//! Authentication HTTP handlers and the session-guard middleware.

use crate::state::store::AppState;
use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;

const COOKIE_NAME: &str = "sysmon_session";

/// Extract the session token from the Cookie header.
fn token_from_request(req: &Request) -> Option<String> {
    let cookies = req.headers().get(header::COOKIE)?.to_str().ok()?;
    for part in cookies.split(';') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix(&format!("{}=", COOKIE_NAME)) {
            return Some(rest.to_string());
        }
    }
    None
}

/// Middleware that rejects unauthenticated requests. On success, the request
/// proceeds; otherwise a 401 JSON error is returned (the frontend redirects to
/// the login page on any 401).
pub async fn require_auth(State(state): State<AppState>, req: Request, next: Next) -> Response {
    match token_from_request(&req).and_then(|t| state.auth().validate(&t)) {
        Some(_user) => next.run(req).await,
        None => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "authentication required" })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub struct LoginBody {
    username: String,
    password: String,
}

/// POST /api/auth/login — set a session cookie on success.
pub async fn login(State(state): State<AppState>, Json(body): Json<LoginBody>) -> Response {
    match state.auth().login(&body.username, &body.password) {
        Some(token) => {
            let cookie = format!(
                "{}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200",
                COOKIE_NAME, token
            );
            let mut resp = Json(json!({
                "ok": true,
                "username": state.auth().username(),
                "preferences": state.auth().preferences(),
            }))
            .into_response();
            resp.headers_mut()
                .insert(header::SET_COOKIE, cookie.parse().unwrap());
            resp
        }
        None => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Invalid username or password" })),
        )
            .into_response(),
    }
}

/// POST /api/auth/logout — clear the session.
pub async fn logout(State(state): State<AppState>, req: Request) -> Response {
    if let Some(token) = token_from_request(&req) {
        state.auth().logout(&token);
    }
    let clear = format!("{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0", COOKIE_NAME);
    let mut resp = Json(json!({ "ok": true })).into_response();
    resp.headers_mut()
        .insert(header::SET_COOKIE, clear.parse().unwrap());
    resp
}

/// GET /api/auth/me — current identity + preferences + feature flags.
pub async fn me(State(state): State<AppState>) -> Response {
    Json(json!({
        "username": state.auth().username(),
        "preferences": state.auth().preferences(),
        "shellEnabled": state.shell_enabled(),
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct ChangePasswordBody {
    #[serde(rename = "currentPassword")]
    current_password: String,
    #[serde(rename = "newPassword")]
    new_password: String,
}

/// POST /api/auth/password — change the password (invalidates other sessions).
pub async fn change_password(
    State(state): State<AppState>,
    Json(body): Json<ChangePasswordBody>,
) -> Response {
    match state.auth().change_password(&body.current_password, &body.new_password) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(msg) => (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct ChangeUsernameBody {
    #[serde(rename = "currentPassword")]
    current_password: String,
    #[serde(rename = "newUsername")]
    new_username: String,
}

/// POST /api/auth/username — change the username.
pub async fn change_username(
    State(state): State<AppState>,
    Json(body): Json<ChangeUsernameBody>,
) -> Response {
    match state.auth().change_username(&body.current_password, &body.new_username) {
        Ok(()) => Json(json!({ "ok": true, "username": state.auth().username() })).into_response(),
        Err(msg) => (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response(),
    }
}

/// POST /api/auth/preferences — persist UI preferences (theme + accent).
pub async fn set_preferences(
    State(state): State<AppState>,
    Json(prefs): Json<crate::auth::Preferences>,
) -> Response {
    state.auth().set_preferences(prefs);
    Json(json!({ "ok": true, "preferences": state.auth().preferences() })).into_response()
}

/// A permissive body reader for endpoints that ignore the request body but must
/// still accept it (keeps axum extractor ordering simple). Unused placeholder.
#[allow(dead_code)]
async fn _drain(_body: Body) {}
