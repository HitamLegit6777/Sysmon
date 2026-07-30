//! The web layer: the axum router wiring together the REST API, the WebSocket
//! endpoint, authentication, the optional shell, and the embedded static
//! assets, plus middleware for compression, CORS, and security headers.

pub mod api;
pub mod assets;
pub mod auth_api;
pub mod shell_ws;
pub mod ws;

use crate::state::store::AppState;
use axum::{
    middleware,
    routing::{get, post, put},
    Router,
};
use tower_http::compression::CompressionLayer;
use tower_http::cors::CorsLayer;

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
        .route("/alert-rules/{id}", put(api::update_alert_rule))
        .route("/config", get(api::config))
        .route("/health", get(api::health))
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
        );

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
        ])
        .allow_headers([axum::http::header::CONTENT_TYPE]);

    let mut app = Router::new()
        .route("/", get(assets::index))
        .route("/ws", get(ws::handler))
        .route("/shell/ws", get(shell_ws::handler))
        .route("/favicon.svg", get(assets::asset_handler))
        .route("/manifest.webmanifest", get(assets::asset_handler))
        .route("/index.html", get(assets::asset_handler))
        .route("/css/{*path}", get(assets::asset_handler))
        .route("/js/{*path}", get(assets::asset_handler))
        .route("/vendor/{*path}", get(assets::asset_handler))
        .nest("/api/auth", auth_routes)
        .nest("/api", api_routes)
        .fallback(get(assets::index))
        .with_state(state.clone());

    if state.config().server.enable_compression {
        app = app.layer(CompressionLayer::new());
    }
    app = app.layer(cors);

    app
}
