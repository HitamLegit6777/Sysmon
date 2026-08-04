//! The web layer: the axum router wiring together the REST API, the WebSocket
//! endpoint, authentication, the optional shell, and the embedded static
//! assets, plus middleware for compression, CORS, and security headers.

pub mod agent_ws;
pub mod api;
pub mod assets;
pub mod auth_api;
pub mod shell_ws;
pub mod ws;

use crate::state::store::AppState;
use axum::{
    extract::{DefaultBodyLimit, Request},
    http::{header, HeaderValue},
    middleware,
    response::Response,
    routing::{get, post, put},
    Router,
};
use tower_http::compression::CompressionLayer;
use tower_http::cors::CorsLayer;

async fn security_headers(req: Request, next: middleware::Next) -> Response {
    let is_https = req.uri().scheme_str() == Some("https")
        || req
            .headers()
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(',').next())
            .is_some_and(|proto| proto.trim().eq_ignore_ascii_case("https"));
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::HeaderName::from_static("cross-origin-opener-policy"),
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        header::HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("same-origin"),
    );
    if is_https {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"),
    );
    headers.insert(
        header::HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    response
}

/// Build the full application router.
pub fn build_router(state: AppState) -> Router {
    // Protected data API — every route requires a valid session.
    let api_routes = Router::new()
        .route("/snapshot", get(api::snapshot))
        .route("/summary", get(api::summary))
        .route("/host", get(api::host))
        .route("/history", get(api::history))
        .route("/processes", get(api::processes))
        .route("/alerts", get(api::alerts))
        .route("/alert-rules", post(api::add_alert_rule))
        .route(
            "/alert-rules/{id}",
            put(api::update_alert_rule).delete(api::delete_alert_rule),
        )
        .route("/config", get(api::config))
        .route("/health", get(api::health))
        .route_layer(middleware::from_fn(auth_api::require_same_origin))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth_api::require_auth,
        ));

    // Public auth endpoints (login, and identity probe which returns 401 when
    // unauthenticated so the SPA can decide whether to show the login page).
    let auth_routes = Router::new()
        .route("/login", post(auth_api::login))
        .route("/logout", post(auth_api::logout))
        .route(
            "/me",
            get(auth_api::me).route_layer(middleware::from_fn_with_state(
                state.clone(),
                auth_api::require_auth,
            )),
        )
        .route(
            "/password",
            post(auth_api::change_password).route_layer(middleware::from_fn_with_state(
                state.clone(),
                auth_api::require_auth,
            )),
        )
        .route(
            "/username",
            post(auth_api::change_username).route_layer(middleware::from_fn_with_state(
                state.clone(),
                auth_api::require_auth,
            )),
        )
        .route(
            "/preferences",
            post(auth_api::set_preferences).route_layer(middleware::from_fn_with_state(
                state.clone(),
                auth_api::require_auth,
            )),
        )
        .route_layer(middleware::from_fn(auth_api::require_same_origin));

    // The SPA is served from the same origin as the API, so no cross-origin
    // access is needed. Restrict CORS to same-origin (do not advertise a
    // permissive `Access-Control-Allow-Origin: *`), which — combined with the
    // `SameSite=Lax` session cookie — keeps the authenticated API off-limits to
    // other web origins.
    let cors = CorsLayer::new()
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PUT,
            axum::http::Method::DELETE,
        ])
        .allow_headers([axum::http::header::CONTENT_TYPE]);

    let mut app = Router::new()
        .route("/", get(assets::index))
        .route("/ws", get(ws::handler))
        .route("/shell/ws", get(shell_ws::handler))
        .route("/favicon.svg", get(assets::asset_handler))
        .route("/manifest.webmanifest", get(assets::asset_handler))
        .route("/index.html", get(assets::asset_handler))
        .route("/agent/ws", get(agent_ws::handler))
        .route("/css/{*path}", get(assets::asset_handler))
        .route("/js/{*path}", get(assets::asset_handler))
        .route("/vendor/{*path}", get(assets::asset_handler))
        .nest("/api/auth", auth_routes)
        .nest("/api", api_routes)
        .fallback(get(assets::index))
        .layer(DefaultBodyLimit::max(128 * 1024))
        .layer(middleware::from_fn(security_headers))
        .with_state(state.clone());

    if state.config().server.enable_compression {
        app = app.layer(CompressionLayer::new());
    }
    app = app.layer(cors);

    app
}
