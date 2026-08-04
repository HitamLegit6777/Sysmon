//! Authentication HTTP handlers and the session-guard middleware.

use crate::state::store::AppState;
use axum::{
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;

pub const COOKIE_NAME: &str = "sysmon_session";

/// Extract the session token from the Cookie header. Shared by the auth
/// middleware and the WebSocket handlers (which authenticate at upgrade time
/// rather than through the `require_auth` middleware).
pub fn token_from_request(req: &Request) -> Option<String> {
    token_from_headers(req.headers())
}

fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    let cookies = headers.get(header::COOKIE)?.to_str().ok()?;
    cookies.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        (name == COOKIE_NAME && !value.is_empty()).then(|| value.to_string())
    })
}

/// Reject browser requests whose Origin does not match Host. Non-browser
/// clients may omit Origin; an explicitly foreign origin is never accepted.
pub fn same_origin(req: &Request) -> bool {
    let Some(origin) = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    else {
        return true;
    };
    let Some(host) = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    origin == format!("http://{}", host) || origin == format!("https://{}", host)
}

pub async fn require_same_origin(req: Request, next: Next) -> Response {
    if !same_origin(&req) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "cross-origin request rejected" })),
        )
            .into_response();
    }
    next.run(req).await
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

fn session_cookie(token: &str, secure: bool) -> String {
    format!(
        "{}={}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200{}",
        COOKIE_NAME,
        token,
        if secure { "; Secure" } else { "" }
    )
}

fn request_is_https(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .is_some_and(|proto| proto.trim().eq_ignore_ascii_case("https"))
}

/// POST /api/auth/login — set a session cookie on success.
pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Response {
    let secure = request_is_https(&headers);
    let peer = peer.ip().to_string();
    if let Err(retry_after) = state.auth().login_allowed(&peer) {
        let mut response = (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "error": "Too many login attempts. Try again later." })),
        )
            .into_response();
        if let Ok(value) = retry_after.to_string().parse() {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
        return response;
    }
    match state.auth().login(&body.username, &body.password) {
        Some(token) => {
            state.auth().record_login_result(&peer, true);
            let cookie = session_cookie(&token, secure);
            let mut resp = Json(json!({
                "ok": true,
                "username": state.auth().username(),
                "preferences": state.auth().preferences(),
            }))
            .into_response();
            if let Ok(value) = cookie.parse() {
                resp.headers_mut().insert(header::SET_COOKIE, value);
            }
            resp
        }
        None => (
            {
                state.auth().record_login_result(&peer, false);
                StatusCode::UNAUTHORIZED
            },
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
    let clear = format!(
        "{}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{}",
        COOKIE_NAME,
        if request_is_https(req.headers()) {
            "; Secure"
        } else {
            ""
        }
    );
    let mut resp = Json(json!({ "ok": true })).into_response();
    if let Ok(value) = clear.parse() {
        resp.headers_mut().insert(header::SET_COOKIE, value);
    }
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
    headers: HeaderMap,
    Json(body): Json<ChangePasswordBody>,
) -> Response {
    let token = token_from_headers(&headers);
    match state
        .auth()
        .change_password(&body.current_password, &body.new_password, token.as_deref())
    {
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
    headers: HeaderMap,
    Json(body): Json<ChangeUsernameBody>,
) -> Response {
    let token = token_from_headers(&headers);
    match state
        .auth()
        .change_username(&body.current_password, &body.new_username, token.as_deref())
    {
        Ok(()) => Json(json!({ "ok": true, "username": state.auth().username() })).into_response(),
        Err(msg) => (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response(),
    }
}

/// POST /api/auth/preferences — persist UI preferences (theme + accent).
pub async fn set_preferences(
    State(state): State<AppState>,
    Json(prefs): Json<crate::auth::Preferences>,
) -> Response {
    match state.auth().set_preferences(prefs) {
        Ok(()) => {
            Json(json!({ "ok": true, "preferences": state.auth().preferences() })).into_response()
        }
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
    }
}
