//! Static asset serving. The frontend is embedded into the binary at compile
//! time via `include_str!`/`include_bytes!` so the server ships as a single
//! self-contained executable with no runtime file dependencies. A small table
//! maps request paths to embedded byte slices and their content types.

use axum::{
    extract::Path,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
};

/// One embedded asset: its route path, bytes, and content type.
struct Asset {
    path: &'static str,
    bytes: &'static [u8],
    content_type: &'static str,
}

macro_rules! asset {
    ($path:expr, $file:expr, $ct:expr) => {
        Asset {
            path: $path,
            bytes: include_bytes!($file),
            content_type: $ct,
        }
    };
}

// The asset table. Paths are matched exactly (after normalizing "/" to
// "/index.html"). Keeping this explicit avoids any path traversal concerns.
const ASSETS: &[Asset] = &[
    asset!("/index.html", "../../assets/index.html", "text/html; charset=utf-8"),
    asset!("/css/theme.css", "../../assets/css/theme.css", "text/css; charset=utf-8"),
    asset!("/css/layout.css", "../../assets/css/layout.css", "text/css; charset=utf-8"),
    asset!("/css/components.css", "../../assets/css/components.css", "text/css; charset=utf-8"),
    asset!("/css/charts.css", "../../assets/css/charts.css", "text/css; charset=utf-8"),
    asset!("/css/responsive.css", "../../assets/css/responsive.css", "text/css; charset=utf-8"),
    asset!("/css/enhanced.css", "../../assets/css/enhanced.css", "text/css; charset=utf-8"),
    asset!("/css/glossy.css", "../../assets/css/glossy.css", "text/css; charset=utf-8"),
    asset!("/js/util.js", "../../assets/js/util.js", "application/javascript; charset=utf-8"),
    asset!("/js/store.js", "../../assets/js/store.js", "application/javascript; charset=utf-8"),
    asset!("/js/ws.js", "../../assets/js/ws.js", "application/javascript; charset=utf-8"),
    asset!("/js/router.js", "../../assets/js/router.js", "application/javascript; charset=utf-8"),
    asset!("/js/charts/sparkline.js", "../../assets/js/charts/sparkline.js", "application/javascript; charset=utf-8"),
    asset!("/js/charts/linechart.js", "../../assets/js/charts/linechart.js", "application/javascript; charset=utf-8"),
    asset!("/js/charts/gauge.js", "../../assets/js/charts/gauge.js", "application/javascript; charset=utf-8"),
    asset!("/js/charts/bars.js", "../../assets/js/charts/bars.js", "application/javascript; charset=utf-8"),
    asset!("/js/charts/heatmap.js", "../../assets/js/charts/heatmap.js", "application/javascript; charset=utf-8"),
    asset!("/js/charts/areachart.js", "../../assets/js/charts/areachart.js", "application/javascript; charset=utf-8"),
    asset!("/js/charts/donut.js", "../../assets/js/charts/donut.js", "application/javascript; charset=utf-8"),
    asset!("/js/charts/radialgauge.js", "../../assets/js/charts/radialgauge.js", "application/javascript; charset=utf-8"),
    asset!("/js/charts/stackedbars.js", "../../assets/js/charts/stackedbars.js", "application/javascript; charset=utf-8"),
    asset!("/js/components/card.js", "../../assets/js/components/card.js", "application/javascript; charset=utf-8"),
    asset!("/js/components/table.js", "../../assets/js/components/table.js", "application/javascript; charset=utf-8"),
    asset!("/js/components/toast.js", "../../assets/js/components/toast.js", "application/javascript; charset=utf-8"),
    asset!("/js/components/topbar.js", "../../assets/js/components/topbar.js", "application/javascript; charset=utf-8"),
    asset!("/js/components/sidebar.js", "../../assets/js/components/sidebar.js", "application/javascript; charset=utf-8"),
    asset!("/js/components/primitives.js", "../../assets/js/components/primitives.js", "application/javascript; charset=utf-8"),
    asset!("/js/components/tooltip.js", "../../assets/js/components/tooltip.js", "application/javascript; charset=utf-8"),
    asset!("/js/components/datatable2.js", "../../assets/js/components/datatable2.js", "application/javascript; charset=utf-8"),
    asset!("/js/components/widgets.js", "../../assets/js/components/widgets.js", "application/javascript; charset=utf-8"),
    asset!("/js/components/commandpalette.js", "../../assets/js/components/commandpalette.js", "application/javascript; charset=utf-8"),
    asset!("/js/components/settings.js", "../../assets/js/components/settings.js", "application/javascript; charset=utf-8"),
    asset!("/js/components/auth.js", "../../assets/js/components/auth.js", "application/javascript; charset=utf-8"),
    asset!("/js/views/overview.js", "../../assets/js/views/overview.js", "application/javascript; charset=utf-8"),
    asset!("/js/views/cpu.js", "../../assets/js/views/cpu.js", "application/javascript; charset=utf-8"),
    asset!("/js/views/memory.js", "../../assets/js/views/memory.js", "application/javascript; charset=utf-8"),
    asset!("/js/views/network.js", "../../assets/js/views/network.js", "application/javascript; charset=utf-8"),
    asset!("/js/views/disk.js", "../../assets/js/views/disk.js", "application/javascript; charset=utf-8"),
    asset!("/js/views/processes.js", "../../assets/js/views/processes.js", "application/javascript; charset=utf-8"),
    asset!("/js/views/thermal.js", "../../assets/js/views/thermal.js", "application/javascript; charset=utf-8"),
    asset!("/js/views/alerts.js", "../../assets/js/views/alerts.js", "application/javascript; charset=utf-8"),
    asset!("/js/views/info.js", "../../assets/js/views/info.js", "application/javascript; charset=utf-8"),
    asset!("/js/views/profile.js", "../../assets/js/views/profile.js", "application/javascript; charset=utf-8"),
    asset!("/js/views/terminal.js", "../../assets/js/views/terminal.js", "application/javascript; charset=utf-8"),
    asset!("/js/app.js", "../../assets/js/app.js", "application/javascript; charset=utf-8"),
    asset!("/favicon.svg", "../../assets/favicon.svg", "image/svg+xml"),
    asset!("/manifest.webmanifest", "../../assets/manifest.webmanifest", "application/manifest+json"),
    // Vendored terminal emulator (xterm.js) + fit addon, served locally so the
    // build stays a single self-contained binary with no CDN/runtime deps.
    asset!("/vendor/xterm.js", "../../assets/vendor/xterm.js", "application/javascript; charset=utf-8"),
    asset!("/vendor/xterm.css", "../../assets/vendor/xterm.css", "text/css; charset=utf-8"),
    asset!("/vendor/xterm-addon-fit.js", "../../assets/vendor/xterm-addon-fit.js", "application/javascript; charset=utf-8"),
];

fn lookup(path: &str) -> Option<&'static Asset> {
    let normalized = if path == "/" { "/index.html" } else { path };
    ASSETS.iter().find(|a| a.path == normalized)
}

/// Handler for the SPA index and any unmatched route (client-side routing).
pub async fn index() -> Response {
    serve("/index.html")
}

/// Handler for explicit asset paths.
pub async fn asset_handler(uri: Uri) -> Response {
    serve(uri.path())
}

/// Handler for the wildcard static path used by nested routes.
pub async fn static_path(Path(path): Path<String>) -> Response {
    let full = format!("/{}", path);
    serve(&full)
}

fn serve(path: &str) -> Response {
    match lookup(path) {
        Some(asset) => {
            let mut resp = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, asset.content_type);
            // Asset URLs are stable (not content-hashed). Revalidate them so a
            // newly deployed binary cannot be paired with stale JS/CSS from a
            // previous build for up to an hour.
            resp = resp.header(header::CACHE_CONTROL, "no-cache");
            resp.body(asset.bytes.to_vec().into())
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        None => {
            // Fall back to the SPA shell so client-side routes resolve.
            match lookup("/index.html") {
                Some(shell) => Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, shell.content_type)
                    .header(header::CACHE_CONTROL, "no-cache")
                    .body(shell.bytes.to_vec().into())
                    .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
                None => (StatusCode::NOT_FOUND, "not found").into_response(),
            }
        }
    }
}

/// Number of embedded assets, used by diagnostics.
pub fn asset_count() -> usize {
    ASSETS.len()
}
