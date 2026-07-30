//! The central application state store. It holds the latest metrics snapshot,
//! host info, process table, the time-series history ring buffers, and the
//! alert engine. All fields live behind fine-grained `parking_lot` locks so
//! the sampler task (writer) and the many HTTP/WebSocket readers never block
//! each other for long.

use crate::alerts::{ActiveAlert, AlertEngine, AlertEvent};
use crate::state::config::{AlertRuleConfig, Config};
use crate::state::metrics::{
    HistoryPoint, HostInfo, MetricsSnapshot, ProcessMetrics, ThermalMetrics,
};
use crate::util::ring::RingBuffer;
use parking_lot::{Mutex, RwLock};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

const VALID_METRICS: &[&str] = &[
    "cpu.usage",
    "cpu.iowait",
    "cpu.system",
    "memory.usedPercent",
    "memory.swapUsedPercent",
    "load.load1",
    "load.load1PerCore",
    "load.load5PerCore",
    "disk.maxUsedPercent",
    "thermal.maxTemp",
    "network.totalRxBytesPerSec",
    "network.totalTxBytesPerSec",
];
const VALID_OPERATORS: &[&str] = &[">", ">=", "<", "<=", "==", "!="];
const VALID_SEVERITIES: &[&str] = &["warning", "critical"];

/// A broadcast channel type alias for pushing snapshots to WebSocket clients.
pub type SnapshotSender = tokio::sync::broadcast::Sender<Arc<StreamMessage>>;

/// Messages pushed onto the broadcast channel consumed by WebSocket clients.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamMessage {
    /// A fresh fast-channel metrics snapshot.
    Snapshot { data: Box<MetricsSnapshot> },
    /// A process table update (slower cadence).
    Processes { data: Box<ProcessMetrics> },
    /// An alert transition (fired/cleared).
    Alert { data: AlertEvent },
    /// Alert rules changed through the API; update all connected dashboards.
    AlertRules {
        data: Vec<AlertRuleConfig>,
        active: Vec<ActiveAlert>,
    },
    /// A compact history point appended to the rolling chart series.
    History { data: HistoryPoint },
}

/// The shared, cloneable handle to application state.
#[derive(Clone)]
pub struct AppState {
    inner: Arc<Inner>,
}

struct Inner {
    config: Config,
    auth: crate::auth::Auth,
    enable_shell: bool,
    started_at: u64,
    snapshot: RwLock<MetricsSnapshot>,
    processes: RwLock<ProcessMetrics>,
    host: RwLock<HostInfo>,
    history_fast: RwLock<RingBuffer<HistoryPoint>>,
    alert_engine: RwLock<AlertEngine>,
    alert_rules: RwLock<Vec<AlertRuleConfig>>,
    alert_rules_update: Mutex<()>,
    alert_rules_path: Option<std::path::PathBuf>,
    stream_tx: SnapshotSender,
    // Lightweight counters for the diagnostics endpoint.
    sample_count: AtomicU64,
    ws_client_count: AtomicU64,
    ws_messages_sent: AtomicU64,
}

impl AppState {
    /// Construct a new state store from configuration.
    pub fn new(config: Config) -> Self {
        Self::with_options(config, false, None, None)
    }

    /// Construct with an explicit shell toggle and optional auth-file path.
    pub fn with_options(
        mut config: Config,
        enable_shell: bool,
        auth_path: Option<std::path::PathBuf>,
        alert_rules_path: Option<std::path::PathBuf>,
    ) -> Self {
        let capacity = config.history.capacity_fast.max(60);
        let (stream_tx, _rx) = tokio::sync::broadcast::channel(256);
        if let Some(path) = alert_rules_path.as_ref() {
            if let Ok(text) = std::fs::read_to_string(path) {
                match serde_json::from_str::<Vec<AlertRuleConfig>>(&text) {
                    Ok(rules) if rules.iter().all(|r| Self::validate_alert_rule(r).is_ok()) => {
                        config.alerts.rules = rules;
                    }
                    Ok(_) => tracing::warn!("ignoring invalid alert rules file {}", path.display()),
                    Err(e) => {
                        tracing::warn!("failed to parse alert rules {}: {}", path.display(), e)
                    }
                }
            }
        }
        let initial_rules = config.alerts.rules.clone();
        let engine = AlertEngine::new(&initial_rules);
        let auth_path = auth_path.unwrap_or_else(|| std::path::PathBuf::from("sysmon-auth.json"));
        let auth = crate::auth::Auth::load(auth_path);
        AppState {
            inner: Arc::new(Inner {
                config,
                auth,
                enable_shell,
                started_at: crate::state::now_millis(),
                snapshot: RwLock::new(MetricsSnapshot::default()),
                processes: RwLock::new(ProcessMetrics::default()),
                host: RwLock::new(HostInfo::default()),
                history_fast: RwLock::new(RingBuffer::new(capacity)),
                alert_engine: RwLock::new(engine),
                alert_rules: RwLock::new(initial_rules),
                alert_rules_update: Mutex::new(()),
                alert_rules_path,
                stream_tx,
                sample_count: AtomicU64::new(0),
                ws_client_count: AtomicU64::new(0),
                ws_messages_sent: AtomicU64::new(0),
            }),
        }
    }

    /// Shared authentication state.
    pub fn auth(&self) -> &crate::auth::Auth {
        &self.inner.auth
    }

    /// Whether the web shell feature is enabled.
    pub fn shell_enabled(&self) -> bool {
        self.inner.enable_shell
    }

    pub fn config(&self) -> &Config {
        &self.inner.config
    }

    pub fn started_at(&self) -> u64 {
        self.inner.started_at
    }

    /// Subscribe to the broadcast stream. Each WebSocket client gets its own
    /// receiver.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Arc<StreamMessage>> {
        self.inner.stream_tx.subscribe()
    }

    /// Broadcast a message to all subscribers, ignoring the "no receivers"
    /// error which is normal when no clients are connected.
    pub fn broadcast(&self, msg: StreamMessage) {
        let _ = self.inner.stream_tx.send(Arc::new(msg));
    }

    /// Replace the latest snapshot, append a compact history point, evaluate
    /// alerts, and broadcast the results.
    pub fn update_snapshot(&self, snapshot: MetricsSnapshot) {
        let now = snapshot.timestamp;

        // Build the compact history point before moving the snapshot.
        let point = HistoryPoint {
            t: now,
            cpu: snapshot.cpu.usage as f32,
            mem: snapshot.memory.used_percent as f32,
            swap: snapshot.memory.swap_used_percent as f32,
            load1: snapshot.load.load1 as f32,
            net_rx: snapshot.network.total_rx_bytes_per_sec as f32,
            net_tx: snapshot.network.total_tx_bytes_per_sec as f32,
            disk_r: snapshot.disk.total_read_bytes_per_sec as f32,
            disk_w: snapshot.disk.total_write_bytes_per_sec as f32,
            temp: snapshot.thermal.max_temp as f32,
            procs_running: snapshot.cpu.procs_running as u32,
        };

        // Evaluate alerts against the new snapshot.
        let events = if self.inner.config.alerts.enabled {
            self.inner.alert_engine.write().evaluate(&snapshot, now)
        } else {
            Vec::new()
        };

        {
            let mut hist = self.inner.history_fast.write();
            hist.push(point);
        }
        {
            let mut snap = self.inner.snapshot.write();
            *snap = snapshot.clone();
        }

        self.inner.sample_count.fetch_add(1, Ordering::Relaxed);

        // Broadcast snapshot, history, and any alert transitions.
        self.broadcast(StreamMessage::Snapshot {
            data: Box::new(snapshot),
        });
        self.broadcast(StreamMessage::History { data: point });
        for ev in events {
            self.broadcast(StreamMessage::Alert { data: ev });
        }
    }

    /// Replace the process table and broadcast it.
    pub fn update_processes(&self, processes: ProcessMetrics) {
        {
            let mut p = self.inner.processes.write();
            *p = processes.clone();
        }
        self.broadcast(StreamMessage::Processes {
            data: Box::new(processes),
        });
    }

    /// Merge freshly collected thermal metrics into the latest snapshot.
    pub fn update_thermal(&self, thermal: ThermalMetrics) {
        let mut snap = self.inner.snapshot.write();
        snap.thermal = thermal;
    }

    pub fn set_host(&self, host: HostInfo) {
        *self.inner.host.write() = host;
    }

    pub fn host(&self) -> HostInfo {
        self.inner.host.read().clone()
    }

    pub fn snapshot(&self) -> MetricsSnapshot {
        self.inner.snapshot.read().clone()
    }

    pub fn processes(&self) -> ProcessMetrics {
        self.inner.processes.read().clone()
    }

    /// Return a downsampled history series for the chart, at most `max_points`.
    pub fn history(&self, max_points: usize) -> Vec<HistoryPoint> {
        self.inner.history_fast.read().downsample(max_points)
    }

    /// Return the last `n` raw history points.
    pub fn history_last_n(&self, n: usize) -> Vec<HistoryPoint> {
        self.inner.history_fast.read().last_n(n)
    }

    pub fn active_alerts(&self) -> Vec<ActiveAlert> {
        self.inner.alert_engine.read().active()
    }

    pub fn alert_history(&self, limit: usize) -> Vec<AlertEvent> {
        self.inner.alert_engine.read().history(limit)
    }

    pub fn alert_counts(&self) -> std::collections::HashMap<String, usize> {
        self.inner.alert_engine.read().active_counts()
    }

    pub fn alert_rules(&self) -> Vec<AlertRuleConfig> {
        self.inner.alert_rules.read().clone()
    }

    pub fn validate_alert_rule(rule: &AlertRuleConfig) -> Result<(), String> {
        let id = rule.id.trim();
        if id.is_empty() || id.len() > 64 {
            return Err("Rule ID must be 1-64 characters".into());
        }
        if !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            return Err("Rule ID may only contain letters, numbers, '.', '-' and '_'".into());
        }
        if !VALID_METRICS.contains(&rule.metric.as_str()) {
            return Err("Unsupported metric".into());
        }
        if !VALID_OPERATORS.contains(&rule.operator.as_str()) {
            return Err("Unsupported operator".into());
        }
        if !rule.threshold.is_finite() || rule.threshold.abs() > 1_000_000_000_000.0 {
            return Err("Threshold must be a finite, reasonable number".into());
        }
        if rule.duration_ms > 7 * 24 * 60 * 60 * 1000 {
            return Err("Duration cannot exceed 7 days".into());
        }
        if !VALID_SEVERITIES.contains(&rule.severity.as_str()) {
            return Err("Severity must be warning or critical".into());
        }
        let msg = rule.message.trim();
        if msg.is_empty() || msg.len() > 240 {
            return Err("Message must be 1-240 characters".into());
        }
        Ok(())
    }

    /// Add a rule, persist the complete set atomically, then hot-reload the
    /// alert engine. Persistence happens before mutation so a disk failure
    /// cannot leave memory and disk disagreeing.
    pub fn add_alert_rule(
        &self,
        mut rule: AlertRuleConfig,
    ) -> Result<Vec<AlertRuleConfig>, String> {
        let _update = self.inner.alert_rules_update.lock();
        Self::normalize_rule(&mut rule);
        Self::validate_alert_rule(&rule)?;
        let mut rules = self.alert_rules();
        if rules.iter().any(|r| r.id == rule.id) {
            return Err("A rule with that ID already exists".into());
        }
        rules.push(rule);
        self.commit_alert_rules(rules)
    }

    pub fn update_alert_rule(
        &self,
        id: &str,
        mut rule: AlertRuleConfig,
    ) -> Result<Vec<AlertRuleConfig>, String> {
        let _update = self.inner.alert_rules_update.lock();
        Self::normalize_rule(&mut rule);
        Self::validate_alert_rule(&rule)?;
        let mut rules = self.alert_rules();
        let index = rules
            .iter()
            .position(|r| r.id == id)
            .ok_or_else(|| "Rule not found".to_string())?;
        if rule.id != id && rules.iter().any(|r| r.id == rule.id) {
            return Err("A rule with that ID already exists".into());
        }
        rules[index] = rule;
        self.commit_alert_rules(rules)
    }

    fn normalize_rule(rule: &mut AlertRuleConfig) {
        rule.id = rule.id.trim().to_string();
        rule.metric = rule.metric.trim().to_string();
        rule.operator = rule.operator.trim().to_string();
        rule.severity = rule.severity.trim().to_ascii_lowercase();
        rule.message = rule.message.trim().to_string();
    }

    fn commit_alert_rules(
        &self,
        rules: Vec<AlertRuleConfig>,
    ) -> Result<Vec<AlertRuleConfig>, String> {
        if let Some(path) = self.inner.alert_rules_path.as_ref() {
            let json = serde_json::to_vec_pretty(&rules).map_err(|e| e.to_string())?;
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, json).map_err(|e| format!("Failed to save rules: {}", e))?;
            std::fs::rename(&tmp, path).map_err(|e| format!("Failed to finalize rules: {}", e))?;
        }
        *self.inner.alert_rules.write() = rules.clone();
        self.inner.alert_engine.write().replace_rules(&rules);
        let active = self.inner.alert_engine.read().active();
        self.broadcast(StreamMessage::AlertRules {
            data: rules.clone(),
            active,
        });
        Ok(rules)
    }

    pub fn incr_ws_clients(&self) -> u64 {
        self.inner.ws_client_count.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn decr_ws_clients(&self) -> u64 {
        let prev = self.inner.ws_client_count.fetch_sub(1, Ordering::Relaxed);
        prev.saturating_sub(1)
    }

    pub fn ws_client_count(&self) -> u64 {
        self.inner.ws_client_count.load(Ordering::Relaxed)
    }

    pub fn add_ws_messages(&self, n: u64) {
        self.inner.ws_messages_sent.fetch_add(n, Ordering::Relaxed);
    }

    pub fn sample_count(&self) -> u64 {
        self.inner.sample_count.load(Ordering::Relaxed)
    }

    pub fn ws_messages_sent(&self) -> u64 {
        self.inner.ws_messages_sent.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod alert_rule_tests {
    use super::*;

    fn rule(id: &str) -> AlertRuleConfig {
        AlertRuleConfig {
            id: id.into(),
            metric: "cpu.usage".into(),
            operator: ">".into(),
            threshold: 90.0,
            duration_ms: 5_000,
            severity: "warning".into(),
            message: "CPU usage is high".into(),
        }
    }

    #[test]
    fn alert_rule_validation_rejects_invalid_fields() {
        assert!(AppState::validate_alert_rule(&rule("cpu-high")).is_ok());
        let mut bad = rule("bad id!");
        assert!(AppState::validate_alert_rule(&bad).is_err());
        bad = rule("bad-metric");
        bad.metric = "unknown.metric".into();
        assert_eq!(
            AppState::validate_alert_rule(&bad).unwrap_err(),
            "Unsupported metric"
        );
        bad = rule("bad-threshold");
        bad.threshold = f64::NAN;
        assert!(AppState::validate_alert_rule(&bad).is_err());
    }

    #[test]
    fn add_and_update_rules_persist_and_reload() {
        let path = std::env::temp_dir().join(format!(
            "sysmon-rules-test-{}-{}.json",
            std::process::id(),
            crate::state::now_millis()
        ));
        let state = AppState::with_options(Config::default(), false, None, Some(path.clone()));
        let initial = state.alert_rules().len();
        state.add_alert_rule(rule("custom-cpu")).unwrap();
        assert_eq!(state.alert_rules().len(), initial + 1);
        assert!(state.add_alert_rule(rule("custom-cpu")).is_err());

        let mut edited = rule("custom-cpu-renamed");
        edited.threshold = 75.0;
        state.update_alert_rule("custom-cpu", edited).unwrap();
        assert!(state
            .alert_rules()
            .iter()
            .any(|r| r.id == "custom-cpu-renamed" && r.threshold == 75.0));

        let persisted: Vec<AlertRuleConfig> =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(persisted.iter().any(|r| r.id == "custom-cpu-renamed"));
        let _ = std::fs::remove_file(path);
    }
}
