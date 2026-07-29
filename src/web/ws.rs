//! WebSocket endpoint. On connect, the client immediately receives a bootstrap
//! message (host info, latest snapshot, history, active alerts) and is then
//! subscribed to the live broadcast stream. Client-to-server text messages are
//! parsed as small JSON commands (for example a ping or a request to resend the
//! history) so the frontend can stay responsive without extra HTTP round-trips.

use crate::state::store::{AppState, StreamMessage};
use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::sync::Arc;

/// GET /ws - upgrade to a WebSocket connection. Requires a valid session
/// cookie: the live stream carries the same system data as the protected REST
/// API (process list, host info, network), so it must be gated identically.
pub async fn handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    req: Request,
) -> Response {
    let authed = crate::web::auth_api::token_from_request(&req)
        .and_then(|t| state.auth().validate(&t))
        .is_some();
    if !authed {
        return (StatusCode::UNAUTHORIZED, "authentication required").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    let client_num = state.incr_ws_clients();
    tracing::debug!("ws client connected (total {})", client_num);

    // Send the bootstrap payload first so the UI can render immediately.
    let bootstrap = build_bootstrap(&state);
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

    loop {
        tokio::select! {
            // Broadcast messages from the sampler.
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
                        if let Some(reply) = handle_command(&state, &text) {
                            if socket.send(Message::Text(reply.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
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

/// Build the initial bootstrap payload delivered on connect.
fn build_bootstrap(state: &AppState) -> serde_json::Value {
    json!({
        "type": "bootstrap",
        "host": state.host(),
        "snapshot": state.snapshot(),
        "processes": state.processes(),
        "history": state.history(600),
        "alerts": {
            "active": state.active_alerts(),
            "history": state.alert_history(50),
        },
        "config": {
            "ui": state.config().ui,
            "sampling": {
                "fastIntervalMs": state.config().sampling.fast_interval_ms,
                "processIntervalMs": state.config().sampling.process_interval_ms,
            },
        },
        "serverTime": crate::state::now_millis(),
    })
}

/// Serialize a broadcast message to a JSON string.
fn serialize_stream(msg: &Arc<StreamMessage>) -> Option<String> {
    serde_json::to_string(msg.as_ref()).ok()
}

/// Handle a small JSON command from the client. Returns an optional reply.
fn handle_command(state: &AppState, text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let cmd = value.get("cmd").and_then(|v| v.as_str())?;
    match cmd {
        "ping" => Some(json!({"type": "pong", "t": crate::state::now_millis()}).to_string()),
        "history" => {
            let points = value
                .get("points")
                .and_then(|v| v.as_u64())
                .unwrap_or(600) as usize;
            Some(
                json!({
                    "type": "historyFull",
                    "data": state.history(points.clamp(10, 5000)),
                })
                .to_string(),
            )
        }
        "processes" => Some(
            json!({
                "type": "processesFull",
                "data": state.processes(),
            })
            .to_string(),
        ),
        "snapshot" => Some(
            json!({
                "type": "snapshotFull",
                "data": state.snapshot(),
            })
            .to_string(),
        ),
        _ => None,
    }
}
