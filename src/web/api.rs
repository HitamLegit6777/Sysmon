//! REST API handlers. These return the same data available over the WebSocket
//! stream but as one-shot JSON responses, which is convenient for scripting,
//! health checks, and initial page hydration.

use crate::state::config::AlertRuleConfig;
use crate::state::store::AppState;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Deserialize)]
pub struct HistoryQuery {
    pub points: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct ProcessQuery {
    pub sort: Option<String>,
    pub limit: Option<usize>,
    pub order: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AlertQuery {
    pub limit: Option<usize>,
}

/// GET /api/snapshot - the latest full metrics snapshot.
pub async fn snapshot(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.snapshot())
}

/// GET /api/host - relatively static host information.
pub async fn host(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.host())
}

/// GET /api/history?points=N - a downsampled history series for charts.
pub async fn history(
    State(state): State<AppState>,
    Query(q): Query<HistoryQuery>,
) -> impl IntoResponse {
    let points = q.points.unwrap_or(300).clamp(10, 5000);
    Json(state.history(points))
}

/// GET /api/processes?sort=cpu&limit=50&order=desc - the process table.
pub async fn processes(
    State(state): State<AppState>,
    Query(q): Query<ProcessQuery>,
) -> impl IntoResponse {
    let mut pm = state.processes();
    let sort = q.sort.unwrap_or_else(|| "cpu".to_string());
    let descending = q.order.as_deref() != Some("asc");

    pm.processes.sort_by(|a, b| {
        let ord = match sort.as_str() {
            "mem" | "memory" => a.rss_bytes.cmp(&b.rss_bytes),
            "pid" => a.pid.cmp(&b.pid),
            "name" => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            "threads" => a.threads.cmp(&b.threads),
            "user" => a.user.cmp(&b.user),
            _ => a
                .cpu_percent
                .partial_cmp(&b.cpu_percent)
                .unwrap_or(std::cmp::Ordering::Equal),
        };
        if descending {
            ord.reverse()
        } else {
            ord
        }
    });

    if let Some(limit) = q.limit {
        pm.processes.truncate(limit);
    }

    Json(pm)
}

/// GET /api/alerts - active alerts, recent history, and counts.
pub async fn alerts(
    State(state): State<AppState>,
    Query(q): Query<AlertQuery>,
) -> impl IntoResponse {
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    Json(json!({
        "active": state.active_alerts(),
        "history": state.alert_history(limit),
        "counts": state.alert_counts(),
    }))
}

/// POST /api/alert-rules - validate, persist, and activate a new rule.
pub async fn add_alert_rule(
    State(state): State<AppState>,
    Json(rule): Json<AlertRuleConfig>,
) -> impl IntoResponse {
    match state.add_alert_rule(rule) {
        Ok(rules) => (
            StatusCode::CREATED,
            Json(json!({ "ok": true, "rules": rules })),
        ),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}

/// PUT /api/alert-rules/:id - replace one existing rule. The body may rename
/// the rule as long as the new ID remains unique.
pub async fn update_alert_rule(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(rule): Json<AlertRuleConfig>,
) -> impl IntoResponse {
    match state.update_alert_rule(&id, rule) {
        Ok(rules) => (StatusCode::OK, Json(json!({ "ok": true, "rules": rules }))),
        Err(error) if error == "Rule not found" => (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": error })),
        ),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}
/// DELETE /api/alert-rules/:id - remove one existing rule.
pub async fn delete_alert_rule(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.remove_alert_rule(&id) {
        Ok(rules) => (StatusCode::OK, Json(json!({ "ok": true, "rules": rules }))),
        Err(error) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}

/// GET /api/config - the effective UI-relevant configuration.
pub async fn config(State(state): State<AppState>) -> impl IntoResponse {
    let cfg = state.config();
    Json(json!({
        "ui": cfg.ui,
        "sampling": {
            "fastIntervalMs": cfg.sampling.fast_interval_ms,
            "processIntervalMs": cfg.sampling.process_interval_ms,
            "thermalIntervalMs": cfg.sampling.thermal_interval_ms,
        },
        "alerts": {
            "enabled": cfg.alerts.enabled,
            "rules": state.alert_rules(),
        },
    }))
}

/// GET /api/health - a compact liveness and diagnostics payload.
pub async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let now = crate::state::now_millis();
    let uptime_ms = now.saturating_sub(state.started_at());
    let body = json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "uptimeMs": uptime_ms,
        "sampleCount": state.sample_count(),
        "wsClients": state.ws_client_count(),
        "wsMessagesSent": state.ws_messages_sent(),
        "timestamp": now,
    });
    (StatusCode::OK, Json(body))
}

/// GET /api/summary - a compact dashboard summary for lightweight polling.
pub async fn summary(State(state): State<AppState>) -> impl IntoResponse {
    let snap = state.snapshot();
    let host = state.host();
    Json(json!({
        "timestamp": snap.timestamp,
        "hostname": host.hostname,
        "cpu": snap.cpu.usage,
        "cores": snap.cpu.core_count,
        "memoryUsedPercent": snap.memory.used_percent,
        "memoryUsed": snap.memory.used,
        "memoryTotal": snap.memory.total,
        "swapUsedPercent": snap.memory.swap_used_percent,
        "load1": snap.load.load1,
        "uptimeSeconds": snap.load.uptime_seconds,
        "netRx": snap.network.total_rx_bytes_per_sec,
        "netTx": snap.network.total_tx_bytes_per_sec,
        "diskRead": snap.disk.total_read_bytes_per_sec,
        "diskWrite": snap.disk.total_write_bytes_per_sec,
        "maxTemp": snap.thermal.max_temp,
        "maxDiskUsedPercent": snap.disk.max_used_percent,
        "activeAlerts": state.active_alerts().len(),
    }))
}
