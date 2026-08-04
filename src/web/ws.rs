//! WebSocket endpoint. On connect, the client immediately receives a bootstrap
//! message (host info, latest snapshot, history, active alerts) for the hub
//! host ("self"), plus the current fleet list. The client may then switch to
//! any registered agent with `{"cmd":"select","server":"<id>"}`, which returns
//! the same bootstrap payload for that server and re-targets the live stream.
//! Client-to-server text messages are parsed as small JSON commands (ping,
//! history, processes, snapshot, select) so the frontend stays responsive
//! without extra HTTP round-trips.

use crate::state::store::{AppState, StreamMessage};
use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

/// GET /ws - upgrade to a WebSocket connection. Requires a valid session
/// cookie: the live stream carries the same system data as the protected REST
/// API (process list, host info, network), so it must be gated identically.
pub async fn handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    req: Request,
) -> Response {
    if !crate::web::auth_api::same_origin(&req) {
        return (StatusCode::FORBIDDEN, "cross-origin websocket rejected").into_response();
    }
    let Some(token) = crate::web::auth_api::token_from_request(&req) else {
        return (StatusCode::UNAUTHORIZED, "authentication required").into_response();
    };
    if state.auth().validate(&token).is_none() {
        return (StatusCode::UNAUTHORIZED, "authentication required").into_response();
    }
    ws.max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, state, token))
}

async fn handle_socket(mut socket: WebSocket, state: AppState, token: String) {
    let client_num = state.incr_ws_clients();
    tracing::debug!("ws client connected (total {})", client_num);

    // Send the bootstrap payload first so the UI can render immediately.
    let bootstrap = build_bootstrap(&state, "self");
    if socket
        .send(Message::Text(bootstrap.to_string().into()))
        .await
        .is_err()
    {
        state.decr_ws_clients();
        return;
    }

    let mut rx = state.subscribe();
    let mut sent: u64 = 0;
    let mut auth_check = tokio::time::interval(Duration::from_secs(15));
    auth_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Watchdog: if the client goes silent (no frames at all, including pings)
    // for 60s it is almost certainly gone; close instead of holding the slot.
    let mut idle = tokio::time::interval(Duration::from_secs(60));
    idle.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // tokio::time::interval fires immediately on the first tick; consume it
    // so neither watchdog trips a fresh connection.
    idle.tick().await;
    let mut active_server = "self".to_string();

    loop {
        tokio::select! {
            _ = auth_check.tick() => {
                if state.auth().validate(&token).is_none() {
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
            }
            _ = idle.tick() => {
                // Any inbound frame resets the idle timer (select! re-arms on
                // every iteration), so reaching here means truly no traffic.
                let _ = socket.send(Message::Close(None)).await;
                break;
            }
            // Broadcast messages from the sampler / agents.
            msg = rx.recv() => {
                match msg {
                    Ok(stream_msg) => {
                        if let Some(text) = serialize_stream(&stream_msg) {
                            if socket.send(Message::Text(text.into())).await.is_err() {
                                break;
                            }
                            sent += 1;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        // The client fell behind; inform it and continue with
                        // the newest data rather than disconnecting.
                        tracing::warn!("ws client lagged by {} messages", n);
                        let notice = json!({"type": "lagged", "skipped": n}).to_string();
                        if socket.send(Message::Text(notice.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            // Inbound messages from the client.
            client_msg = socket.recv() => {
                match client_msg {
                    Some(Ok(Message::Text(text))) => {
                        idle.reset();
                        if let Some(reply) = handle_command(&state, &text, &mut active_server) {
                            if socket.send(Message::Text(reply.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        idle.reset();
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }

    state.add_ws_messages(sent);
    let remaining = state.decr_ws_clients();
    tracing::debug!("ws client disconnected (total {})", remaining);
}

/// Build the bootstrap payload for a given server id: the hub host ("self")
/// or a registered agent. The shape is identical so the frontend can use one
/// applyBootstrap() path for the initial connect and for every select.
fn build_bootstrap(state: &AppState, server_id: &str) -> serde_json::Value {
    let (host, snapshot, processes, history, active, alert_hist) = if server_id == "self" {
        (
            state.host(),
            state.snapshot(),
            state.processes(),
            state.history(600),
            state.active_alerts(),
            state.alert_history(50),
        )
    } else {
        let agents = state.agents();
        (
            agents.host(server_id).unwrap_or_default(),
            agents.snapshot(server_id).unwrap_or_default(),
            agents.processes(server_id).unwrap_or_default(),
            agents.history(server_id, 600),
            agents.active_alerts(server_id),
            agents.alert_history(server_id, 50),
        )
    };
    json!({
        "type": "bootstrap",
        "serverId": server_id,
        "serverName": if server_id == "self" { "this host".to_string() } else { state.agents().host(server_id).map(|h| h.hostname).unwrap_or_else(|| server_id.to_string()) },
        "host": host,
        "snapshot": snapshot,
        "processes": processes,
        "history": history,
        "alerts": {
            "active": active,
            "history": alert_hist,
        },
        "config": {
            "ui": state.config().ui,
            "sampling": {
                "fastIntervalMs": state.config().sampling.fast_interval_ms,
                "processIntervalMs": state.config().sampling.process_interval_ms,
            },
            "alerts": {
                "enabled": state.config().alerts.enabled,
                "rules": state.alert_rules(),
            },
        },
        "servers": state.agents().summaries(),
        "serverTime": crate::state::now_millis(),
    })
}

/// Serialize a broadcast message to a JSON string.
fn serialize_stream(msg: &Arc<StreamMessage>) -> Option<String> {
    serde_json::to_string(msg.as_ref()).ok()
}

/// Handle a small JSON command from the client. Returns an optional reply.
fn handle_command(state: &AppState, text: &str, active_server: &mut String) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let cmd = value.get("cmd").and_then(|v| v.as_str())?;
    match cmd {
        "ping" => Some(json!({"type": "pong", "t": crate::state::now_millis()}).to_string()),
        "select" => {
            let server = value.get("server").and_then(|v| v.as_str()).unwrap_or("self");
            if server != "self" && !state.agents().contains(server) {
                return Some(json!({"type": "error", "error": "unknown server"}).to_string());
            }
            *active_server = server.to_string();
            Some(build_bootstrap(state, server).to_string())
        }
        "history" => {
            let points = value.get("points").and_then(|v| v.as_u64()).unwrap_or(600) as usize;
            let data = if active_server == "self" {
                state.history(points.clamp(10, 5000))
            } else {
                state.agents().history(active_server, points.clamp(10, 5000))
            };
            Some(json!({"type": "historyFull", "data": data}).to_string())
        }
        "processes" => {
            let data = if active_server == "self" {
                state.processes()
            } else {
                state.agents().processes(active_server).unwrap_or_default()
            };
            Some(json!({"type": "processesFull", "data": data}).to_string())
        }
        "snapshot" => {
            let data = if active_server == "self" {
                state.snapshot()
            } else {
                state.agents().snapshot(active_server).unwrap_or_default()
            };
            Some(json!({"type": "snapshotFull", "data": data}).to_string())
        }
        _ => None,
    }
}
