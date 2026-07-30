//! WebSocket handler for the PTY-backed web shell. Doubly gated: the
//! `--enable-shell` flag must be on AND the request must carry a valid session
//! cookie. Binary PTY output is base64-free — sent as text frames of UTF-8
//! (lossily decoded) so the xterm-lite frontend can render directly.

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
            let text = String::from_utf8_lossy(&chunk).to_string();
            if sender.send(Message::Text(text.into())).await.is_err() {
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
        match msg {
            Message::Text(text) => {
                if let Ok(cmd) = serde_json::from_str::<ClientMsg>(&text) {
                    match cmd {
                        ClientMsg::Input { data } => sess_in.lock().write_input(data.as_bytes()),
                        ClientMsg::Resize { cols, rows } => sess_in.lock().resize(cols, rows),
                    }
                } else {
                    // Treat unrecognized text as raw input.
                    sess_in.lock().write_input(text.as_bytes());
                }
            }
            Message::Binary(b) => sess_in.lock().write_input(&b),
            Message::Close(_) => break,
            _ => {}
        }
    }

    out_task.abort();
}
