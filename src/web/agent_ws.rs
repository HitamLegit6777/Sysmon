//! Inbound WebSocket endpoint for `agent-monitor` binaries.
//!
//! This is the hub-side listener agents dial out to (typically through a
//! Cloudflare quick tunnel, so agents never need an inbound port). Auth is a
//! shared Bearer token (`Authorization: Bearer <token>`) compared in
//! constant time; agents are not browser clients so they send no Origin, and
//! this route deliberately sits OUTSIDE the session-auth middleware tree.
//!
//! Protocol (agent -> hub, JSON text frames):
//!   { "type": "hello", "id": "<agent-id>", "name": "<display name>" }
//!   { "type": "host",   "data": HostInfo }
//!   { "type": "snapshot", "data": MetricsSnapshot }   // ~1s cadence
//!   { "type": "processes", "data": ProcessMetrics }   // ~3s cadence
//!   { "type": "pong", "data": <echo of ping payload> }
//!
//! Hub -> agent:
//!   { "type": "welcome" }
//!   { "type": "ping", "data": <nanosecond timestamp> }  // latency probe
//!
//! The hub re-tags every ingested frame with the agent id and fans it out on
//! the shared broadcast channel; per-agent alert rules are evaluated on the
//! hub against the same rule set as the hub's own metrics.

use crate::state::store::AppState;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Request, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use std::time::Duration;

/// Frame the agent sends first to identify itself.
#[derive(Debug, Deserialize)]
struct Hello {
    #[serde(rename = "type")]
    kind: String,
    id: String,
    #[serde(default)]
    name: Option<String>,
}

/// Frame the agent sends for the hub -> agent latency probe.
#[derive(Debug, Deserialize)]
struct Pong {
    #[serde(default)]
    data: Option<u64>,
}

/// Static-time comparison helper so token validation cannot leak timing.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Extract the Bearer token from the Authorization header.
fn bearer_token(req: &Request) -> Option<String> {
    let header = req.headers().get("authorization")?.to_str().ok()?;
    header.strip_prefix("Bearer ").map(|t| t.trim().to_string())
}

/// GET /agent/ws — upgrade, authenticate, and stream agent telemetry.
pub async fn handler(
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
    req: Request,
) -> Response {
    if !state.agents_enabled() {
        return (StatusCode::FORBIDDEN, "agents disabled").into_response();
    }
    let Some(token) = bearer_token(&req) else {
        return (StatusCode::UNAUTHORIZED, "missing bearer token").into_response();
    };
    if !constant_time_eq(&token, state.agents_token()) {
        tracing::warn!("agent connection rejected: bad token");
        return (StatusCode::UNAUTHORIZED, "invalid token").into_response();
    }
    ws.max_message_size(512 * 1024)
        .max_frame_size(512 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();

    // --- Hello handshake with a deadline so a silent connection cannot hold
    // a socket (and a registry slot) forever.
    let id = match tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match receiver.next().await {
                Some(Ok(Message::Text(text))) => match serde_json::from_str::<Hello>(&text) {
                    Ok(hello) if hello.kind == "hello" => {
                        return Ok((hello.id, hello.name.unwrap_or_default()))
                    }
                    Ok(_) => {}
                    Err(_) => {}
                },
                Some(Ok(Message::Close(_))) | None => return Err(()),
                _ => {}
            }
        }
    })
    .await
    {
        Ok(Ok((id, name))) => {
            let name = if name.trim().is_empty() { id.clone() } else { name };
            let rules = state.alert_rules();
            if let Err(e) = state.agents().register(
                crate::agents::AgentIdentity { id: id.clone(), name },
                &rules,
            ) {
                let _ = sender
                    .send(Message::Text(format!("{{\"type\":\"error\",\"error\":\"{e}\"}}").into()))
                    .await;
                let _ = sender.close().await;
                return;
            }
            id
        }
        _ => {
            let _ = sender.close().await;
            return;
        }
    };

    // --- Shared send half: both the outbound/probe task and the ingest loop
    // write to the socket, so guard the sink with a mutex. Sends are short;
    // holding the lock across await only serializes writes (correct order).
    let sender = std::sync::Arc::new(tokio::sync::Mutex::new(sender));

    // --- Outbound command channel: hub-side pushes (tunnel URL changes,
    // future commands) flow through an mpsc drained inside the probe task.
    let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    if !state.agents().attach_outbound(&id, outbound_tx) {
        let _ = sender.lock().await.close().await;
        return;
    }
    if sender
        .lock()
        .await
        .send(Message::Text("{\"type\":\"welcome\"}".into()))
        .await
        .is_err()
    {
        state.agents().mark_disconnected(&id);
        return;
    }
    tracing::info!("agent '{}' connected", id);

    let state_ingest = state.clone();
    let id_ingest = id.clone();
    let probe_sender = sender.clone();

    // --- Probe + outbound task: pings every 15s, forwards pushed frames.
    let probe_task = tokio::spawn(async move {
        let mut iv = tokio::time::interval(Duration::from_secs(15));
        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = iv.tick() => {
                    let sent = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_nanos() as u64)
                        .unwrap_or(0);
                    if probe_sender
                        .lock()
                        .await
                        .send(Message::Text(format!("{{\"type\":\"ping\",\"data\":{sent}}}").into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Some(frame) = outbound_rx.recv() => {
                    if probe_sender.lock().await.send(Message::Text(frame.into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // (single probe_task is spawned above; duplicates were purged)

    // --- Main ingest loop.
    loop {
        let msg = tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(45)) => {
                // Liveness watchdog: no frame at all for 45s => dead link.
                tracing::warn!("agent '{id}' idle; closing");
                break;
            }
            msg = receiver.next() => match msg {
                Some(Ok(msg)) => msg,
                _ => break,
            },
        };

        let now = crate::state::now_millis();
        let text = match msg {
            Message::Text(text) => text,
            Message::Ping(payload) => {
                if sender.lock().await.send(Message::Pong(payload)).await.is_err() {
                    break;
                }
                continue;
            }
            Message::Close(_) | Message::Binary(_) => break,
            _ => continue,
        };

        // Parse a typed frame. Malformed frames are logged and skipped; a
        // flood of malformed frames is bounded by the socket size limit and
        // the 45s watchdog.
        let value: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!("agent '{id}' malformed frame: {e}");
                continue;
            }
        };
        let Some(kind) = value.get("type").and_then(|v| v.as_str()) else {
            continue;
        };


        match kind {
            "snapshot" => {
                let Ok(snap) = serde_json::from_value(value.get("data").cloned().unwrap_or_default())
                else {
                    continue;
                };
                let events = state_ingest.agents().ingest_snapshot(
                    &id_ingest,
                    snap,
                    state_ingest.config().alerts.enabled,
                    now,
                );
                // Fan the snapshot out to dashboards (tagged with the agent
                // id; the browser filters by its selected server).
                if let Some(latest) = state_ingest.agents().snapshot(&id_ingest) {
                    state_ingest.broadcast(crate::state::store::StreamMessage::Snapshot {
                        server_id: id_ingest.clone(),
                        data: Box::new(latest),
                    });
                }
                for ev in events {
                    state_ingest.broadcast(crate::state::store::StreamMessage::Alert {
                        server_id: ev.server_id,
                        data: ev.event,
                    });
                }
            }
            "processes" => {
                let Ok(procs) = serde_json::from_value(value.get("data").cloned().unwrap_or_default())
                else {
                    continue;
                };
                state_ingest.agents().ingest_processes(&id_ingest, procs, now);
                if let Some(latest) = state_ingest.agents().processes(&id_ingest) {
                    state_ingest.broadcast(crate::state::store::StreamMessage::Processes {
                        server_id: id_ingest.clone(),
                        data: Box::new(latest),
                    });
                }
            }
            "host" => {
                let Ok(host) = serde_json::from_value(value.get("data").cloned().unwrap_or_default())
                else {
                    continue;
                };
                state_ingest.agents().set_host(&id_ingest, host);
            }
            "pong" => {
                if let Ok(pong) = serde_json::from_str::<Pong>(&text) {
                    if let Some(sent) = pong.data {
                        let now_ns = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_nanos() as u64)
                            .unwrap_or(0);
                        let rtt_ms = now_ns.saturating_sub(sent) / 1_000_000;
                        state_ingest.agents().set_latency(&id_ingest, rtt_ms);
                    }
                }
            }
            _ => {}
        }
        state_ingest.agents().touch(&id_ingest, now);
    }

    probe_task.abort();
    state.agents().mark_disconnected(&id);
    state.agents().detach_outbound(&id);
    tracing::info!("agent '{}' disconnected", id);
    // Cleanup: drop the socket halves (closing the link). The child half of
    // the split is dropped with `receiver`; `sender` is dropped here.
    drop(sender);
}

// `split` needs StreamExt/SinkExt; import them so the module compiles.
use futures::{SinkExt, StreamExt};
