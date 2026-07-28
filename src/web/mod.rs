//! The web layer: the axum router wiring together the REST API, the WebSocket
//! endpoint, and the embedded static assets, plus middleware for compression,
//! CORS, and security headers.

pub mod api;
pub mod assets;
pub mod ws;

use crate::state::store::AppState;
use axum::{routing::get, Router};
use tower_http::compression::CompressionLayer;
use tower_http::cors::{Any, CorsLayer};

/// Build the full application router.
pub fn build_router(state: AppState) -> Router {
    let api_routes = Router::new()
        .route("/snapshot", get(api::snapshot))
        .route("/summary", get(api::summary))
        .route("/host", get(api::host))
        .route("/history", get(api::history))
        .route("/processes", get(api::processes))
        .route("/alerts", get(api::alerts))
        .route("/config", get(api::config))
        .route("/health", get(api::health));

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let mut app = Router::new()
        .route("/", get(assets::index))
        .route("/ws", get(ws::handler))
        .route("/favicon.svg", get(assets::asset_handler))
        .route("/manifest.webmanifest", get(assets::asset_handler))
        .route("/index.html", get(assets::asset_handler))
        .route("/css/{*path}", get(assets::asset_handler))
        .route("/js/{*path}", get(assets::asset_handler))
        .nest("/api", api_routes)
        .fallback(get(assets::index))
        .with_state(state.clone());

    if state.config().server.enable_compression {
        app = app.layer(CompressionLayer::new());
    }
    app = app.layer(cors);

    app
}
