//! WebSocket handler for the PTY-backed web shell. Doubly gated: the
//! `--enable-shell` flag must be on AND the request must carry a valid session
//! cookie. PTY output stays binary so UTF-8 sequences split across read chunks
//! are not corrupted by lossy per-chunk decoding.

use crate::shell::{ClientMsg, ShellSession};
use crate::state::store::AppState;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Request, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures::{sink::SinkExt, stream::StreamExt};

/// Upgrade to a shell WebSocket after checking the feature flag and session.
pub async fn handler(
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
    req: Request,
) -> Response {
    if !state.shell_enabled() {
        return (StatusCode::FORBIDDEN, "shell disabled").into_response();
    }
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

async fn handle_socket(socket: WebSocket, state: AppState, token: String) {
    let (mut sender, mut receiver) = socket.split();

    // Spawn the PTY at a default size; the client sends a resize immediately.
    let (session, mut pty_out) = match ShellSession::spawn(80, 24) {
        Ok(s) => s,
        Err(e) => {
            let _ = sender
                .send(Message::Text(
                    format!("\r\n[sysmon] failed to open shell: {}\r\n", e).into(),
                ))
                .await;
            return;
        }
    };
    let session = std::sync::Arc::new(parking_lot::Mutex::new(session));

    // PTY output → WebSocket.
    let out_task = tokio::spawn(async move {
        while let Some(chunk) = pty_out.recv().await {
            if sender.send(Message::Binary(chunk.into())).await.is_err() {
                break;
            }
        }
        let _ = sender.close().await;
    });

    // WebSocket input → PTY.
    let sess_in = session.clone();
    let mut auth_check = tokio::time::interval(std::time::Duration::from_secs(15));
    auth_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let msg = tokio::select! {
            _ = auth_check.tick() => {
                if state.auth().validate(&token).is_none() {
                    break;
                }
                continue;
            }
            msg = receiver.next() => match msg {
                Some(Ok(msg)) => msg,
                _ => break,
            },
        };
        let result = match msg {
            Message::Text(text) => match serde_json::from_str::<ClientMsg>(&text) {
                Ok(ClientMsg::Input { data }) => sess_in.lock().write_input(data.as_bytes()),
                Ok(ClientMsg::Resize { cols, rows }) => sess_in.lock().resize(cols, rows),
                Err(_) => sess_in.lock().write_input(text.as_bytes()),
            },
            Message::Binary(bytes) => sess_in.lock().write_input(&bytes),
            Message::Close(_) => break,
            _ => continue,
        };
        if let Err(error) = result {
            tracing::debug!("shell PTY I/O failed: {}", error);
            break;
        }
    }

    out_task.abort();
}
