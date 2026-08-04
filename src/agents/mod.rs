//! Agent registry: the hub-side state for every remote monitored server.
//!
//! Each `agent-monitor` connects to the hub's `/agent/ws` endpoint and streams
//! snapshots. This module owns the per-agent state: identity, liveness, the
//! latest snapshot/process table, the rolling history ring, and a per-agent
//! alert engine evaluated against the shared rule set on the hub.
//!
//! The hub's own local metrics live outside this registry in `AppState`; the
//! registry only tracks remote agents. Both are addressed by a `serverId` in
//! the browser WebSocket protocol ("self" for the hub host).

use crate::alerts::{ActiveAlert, AlertEngine, AlertEvent};
use crate::state::config::AlertRuleConfig;
use crate::state::metrics::{HistoryPoint, HostInfo, MetricsSnapshot, ProcessMetrics};
use crate::util::ring::RingBuffer;
use parking_lot::RwLock;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

/// Identity + display metadata an agent presents on connect.
#[derive(Debug, Clone)]
pub struct AgentIdentity {
    pub id: String,
    pub name: String,
}

use tokio::sync::mpsc;

/// Validate an agent-supplied id: URL/JSON-safe, bounded length. Prevents
/// injection into JSON paths, sidebar DOM, and rule keys.
pub fn validate_agent_id(id: &str) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() || id.len() > 64 {
        return Err("agent id must be 1-64 characters".into());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err("agent id may only contain letters, numbers, '.', '-' and '_'".into());
    }
    Ok(())
}

/// Validate the display name (free-form, bounded, whitespace allowed).
pub fn validate_agent_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 128 {
        return Err("agent name must be 1-128 characters".into());
    }
    Ok(())
}

/// Everything the hub knows about one connected (or last-known) agent.
struct AgentState {
    identity: AgentIdentity,
    hostname: String,
    version: String,
    connected: bool,
    last_seen_ms: u64,
    latency_ms: u64,
    host: Option<HostInfo>,
    snapshot: Option<MetricsSnapshot>,
    processes: Option<ProcessMetrics>,
    history: RingBuffer<HistoryPoint>,
    engine: AlertEngine,
    /// Hub -> agent command channel (set on connect; used to push tunnel URL
    /// changes and future commands). None while the agent is offline.
    outbound: Option<mpsc::UnboundedSender<String>>,
}

/// A compact per-agent summary pushed to dashboards on the fleet tick.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub id: String,
    pub name: String,
    pub hostname: String,
    pub version: String,
    pub connected: bool,
    pub last_seen_ms: u64,
    pub latency_ms: u64,
    pub uptime_sec: u64,
    pub cpu_usage: f64,
    pub mem_used_percent: f64,
    pub load1: f64,
    pub net_rx_bps: f64,
    pub net_tx_bps: f64,
    pub max_temp: f64,
    pub disk_used_percent: f64,
    pub procs_total: u64,
    pub alerts_warning: usize,
    pub alerts_critical: usize,
}

/// A single alert transition tagged with the originating server.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAlertEvent {
    pub server_id: String,
    #[serde(flatten)]
    pub event: AlertEvent,
}

/// The hub-side registry of remote agents. Internally RwLock-guarded; every
/// method takes a short lock so the per-agent 1s ingest never blocks the
/// browser-facing reads for long.
#[derive(Clone)]
pub struct AgentRegistry {
    inner: Arc<RegistryInner>,
}

struct RegistryInner {
    agents: RwLock<HashMap<String, AgentState>>,
    max_agents: usize,
}

impl AgentRegistry {
    /// Build an empty registry. `max_agents` caps concurrent registrations;
    /// new agents beyond the cap are rejected (the WS handler returns 503).
    pub fn new(max_agents: usize) -> Self {
        AgentRegistry {
            inner: Arc::new(RegistryInner {
                agents: RwLock::new(HashMap::new()),
                max_agents: max_agents.max(1),
            }),
        }
    }

    /// Whether the registry is empty (no agents registered).
    pub fn is_empty(&self) -> bool {
        self.inner.agents.read().is_empty()
    }

    /// Register or update an agent identity. Returns Err when the registry is
    /// full or the id/name fail validation. Callers must then reject the
    /// connection.
    pub fn register(&self, identity: AgentIdentity, rules: &[AlertRuleConfig]) -> Result<(), String> {
        validate_agent_id(&identity.id)?;
        validate_agent_name(&identity.name)?;
        let mut agents = self.inner.agents.write();
        if !agents.contains_key(&identity.id) && agents.len() >= self.inner.max_agents {
            return Err("agent limit reached".into());
        }
        let entry = agents.entry(identity.id.clone()).or_insert_with(|| AgentState {
            identity,
            hostname: String::new(),
            version: String::new(),
            connected: false,
            last_seen_ms: 0,
            latency_ms: 0,
            host: None,
            snapshot: None,
            processes: None,
            history: RingBuffer::new(3600),
            engine: AlertEngine::new(rules),
            outbound: None,
        });
        entry.connected = true;
        Ok(())
    }

    /// Record an agent heartbeat (used for liveness + latency bookkeeping).
    pub fn touch(&self, id: &str, now_ms: u64) {
        if let Some(a) = self.inner.agents.write().get_mut(id) {
            a.last_seen_ms = now_ms;
            a.connected = true;
        }
    }

    /// Attach static host info reported once after connect.
    pub fn set_host(&self, id: &str, host: HostInfo) {
        if let Some(a) = self.inner.agents.write().get_mut(id) {
            a.hostname = host.hostname.clone();
            a.version = host.sysmon_version.clone();
            a.host = Some(host);
        }
    }


    /// Attach the agent's outbound command channel after the hello handshake.
    /// Returns false when the agent id is not registered.
    pub fn attach_outbound(&self, id: &str, tx: mpsc::UnboundedSender<String>) -> bool {
        let mut agents = self.inner.agents.write();
        match agents.get_mut(id) {
            Some(a) => {
                a.outbound = Some(tx);
                true
            }
            None => false,
        }
    }

    /// Detach the outbound channel (agent went offline). Keeps all data.
    pub fn detach_outbound(&self, id: &str) {
        if let Some(a) = self.inner.agents.write().get_mut(id) {
            a.outbound = None;
        }
    }

    /// Push a JSON command frame to one agent. Returns false when the agent
    /// is offline or the channel is closed.
    pub fn send_to_agent(&self, id: &str, frame: String) -> bool {
        self.inner
            .agents
            .read()
            .get(id)
            .and_then(|a| a.outbound.as_ref())
            .map(|tx| tx.send(frame).is_ok())
            .unwrap_or(false)
    }
    /// Ingest a fresh snapshot: store it, append history, evaluate alerts,
    /// and return any new alert transitions (tagged with the server id).
    pub fn ingest_snapshot(
        &self,
        id: &str,
        snapshot: MetricsSnapshot,
        alerts_enabled: bool,
        now_ms: u64,
    ) -> Vec<AgentAlertEvent> {
        let mut agents = self.inner.agents.write();
        let Some(a) = agents.get_mut(id) else {
            return Vec::new();
        };
        a.snapshot = Some(snapshot.clone());
        a.last_seen_ms = now_ms;
        a.connected = true;
        a.history.push(HistoryPoint::from_snapshot(&snapshot));
        if !alerts_enabled {
            return Vec::new();
        }
        a.engine
            .evaluate(&snapshot, now_ms)
            .into_iter()
            .map(|event| AgentAlertEvent {
                server_id: id.to_string(),
                event,
            })
            .collect()
    }

    /// Record a measured round-trip time (ms) for the agent connection.
    pub fn set_latency(&self, id: &str, latency_ms: u64) {
        if let Some(a) = self.inner.agents.write().get_mut(id) {
            a.latency_ms = latency_ms;
        }
    }

    /// Replace the process table.
    pub fn ingest_processes(&self, id: &str, processes: ProcessMetrics, now_ms: u64) {
        let mut agents = self.inner.agents.write();
        if let Some(a) = agents.get_mut(id) {
            a.processes = Some(processes);
            a.last_seen_ms = now_ms;
        }
    }

    /// Mark an agent disconnected (keeps last-known data for display).
    pub fn mark_disconnected(&self, id: &str) {
        if let Some(a) = self.inner.agents.write().get_mut(id) {
            a.connected = false;
        }
    }

    /// Remove an agent entirely (e.g. administrative removal).
    pub fn remove(&self, id: &str) {
        self.inner.agents.write().remove(id);
    }

    /// Hot-reload the shared rule set into every agent's engine, preserving
    /// the runtime state of rules whose config did not change.
    pub fn replace_rules(&self, rules: &[AlertRuleConfig]) {
        let mut agents = self.inner.agents.write();
        for a in agents.values_mut() {
            a.engine.replace_rules(rules);
        }
    }

    /// Current active alerts for one agent.
    pub fn active_alerts(&self, id: &str) -> Vec<ActiveAlert> {
        self.inner
            .agents
            .read()
            .get(id)
            .map(|a| a.engine.active())
            .unwrap_or_default()
    }

    /// Recent alert history for one agent, newest last.
    pub fn alert_history(&self, id: &str, limit: usize) -> Vec<AlertEvent> {
        self.inner
            .agents
            .read()
            .get(id)
            .map(|a| a.engine.history(limit))
            .unwrap_or_default()
    }

    /// Latest snapshot for one agent, if any has arrived.
    pub fn snapshot(&self, id: &str) -> Option<MetricsSnapshot> {
        self.inner.agents.read().get(id).and_then(|a| a.snapshot.clone())
    }

    pub fn processes(&self, id: &str) -> Option<ProcessMetrics> {
        self.inner.agents.read().get(id).and_then(|a| a.processes.clone())
    }

    pub fn host(&self, id: &str) -> Option<HostInfo> {
        self.inner.agents.read().get(id).and_then(|a| a.host.clone())
    }

    /// Downsampled history for one agent.
    pub fn history(&self, id: &str, max_points: usize) -> Vec<HistoryPoint> {
        self.inner
            .agents
            .read()
            .get(id)
            .map(|a| a.history.downsample(max_points))
            .unwrap_or_default()
    }

    /// Compact per-agent summaries for the fleet view + sidebar.
    pub fn summaries(&self) -> Vec<AgentSummary> {
        let agents = self.inner.agents.read();
        let now = crate::state::now_millis();
        let mut out: Vec<AgentSummary> = agents
            .values()
            .map(|a| {
                let snap = a.snapshot.as_ref();
                let active = a.engine.active();
                let (alerts_warning, alerts_critical) = active.iter().fold(
                    (0usize, 0usize),
                    |(w, c), al| match al.severity.as_str() {
                        "critical" => (w, c + 1),
                        _ => (w + 1, c),
                    },
                );
                AgentSummary {
                    id: a.identity.id.clone(),
                    name: a.identity.name.clone(),
                    hostname: a.hostname.clone(),
                    version: a.version.clone(),
                    connected: a.connected,
                    last_seen_ms: a.last_seen_ms,
                    latency_ms: a.latency_ms,
                    uptime_sec: snap.map(|s| s.load.uptime_seconds as u64).unwrap_or(0),
                    cpu_usage: snap.map(|s| s.cpu.usage).unwrap_or(0.0),
                    mem_used_percent: snap.map(|s| s.memory.used_percent).unwrap_or(0.0),
                    load1: snap.map(|s| s.load.load1).unwrap_or(0.0),
                    net_rx_bps: snap.map(|s| s.network.total_rx_bytes_per_sec).unwrap_or(0.0),
                    net_tx_bps: snap.map(|s| s.network.total_tx_bytes_per_sec).unwrap_or(0.0),
                    max_temp: snap.map(|s| s.thermal.max_temp).unwrap_or(0.0),
                    disk_used_percent: snap.map(|s| s.disk.max_used_percent).unwrap_or(0.0),
                    procs_total: snap.map(|s| s.load.total_procs).unwrap_or(0),
                    alerts_warning,
                    alerts_critical,
                }
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        // Drop a stale "now" borrow before returning.
        let _ = now;
        out
    }

    /// Whether an agent id is currently registered.
    pub fn contains(&self, id: &str) -> bool {
        self.inner.agents.read().contains_key(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::config::AlertRuleConfig;

    fn rule(id: &str, metric: &str, threshold: f64, duration: u64) -> AlertRuleConfig {
        AlertRuleConfig {
            id: id.into(),
            metric: metric.into(),
            operator: ">".into(),
            threshold,
            duration_ms: duration,
            severity: "warning".into(),
            message: "test".into(),
        }
    }

    fn snap_with_cpu(usage: f64) -> MetricsSnapshot {
        let mut s = MetricsSnapshot::default();
        s.cpu.usage = usage;
        s.timestamp = 1000;
        s
    }

    #[test]
    fn id_validation_accepts_safe_and_rejects_dangerous() {
        assert!(validate_agent_id("web-01.prod").is_ok());
        assert!(validate_agent_id("a").is_ok());
        assert!(validate_agent_id("").is_err());
        assert!(validate_agent_id("has space").is_err());
        assert!(validate_agent_id("bad;drop").is_err());
        assert!(validate_agent_id(&"x".repeat(65)).is_err());
    }

    #[test]
    fn register_then_ingest_roundtrips() {
        let reg = AgentRegistry::new(4);
        reg.register(
            AgentIdentity { id: "a1".into(), name: "Alpha".into() },
            &[rule("cpu", "cpu.usage", 90.0, 0)],
        )
        .unwrap();
        assert!(reg.contains("a1"));
        assert!(!reg.is_empty());

        let events = reg.ingest_snapshot("a1", snap_with_cpu(95.0), true, 2000);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].server_id, "a1");
        assert_eq!(events[0].event.transition, "fired");
        assert_eq!(reg.active_alerts("a1").len(), 1);
        assert_eq!(reg.summaries()[0].cpu_usage, 95.0);
    }

    #[test]
    fn alerts_are_per_agent() {
        let reg = AgentRegistry::new(4);
        reg.register(
            AgentIdentity { id: "hot".into(), name: "H".into() },
            &[rule("cpu", "cpu.usage", 90.0, 0)],
        )
        .unwrap();
        reg.register(
            AgentIdentity { id: "cold".into(), name: "C".into() },
            &[rule("cpu", "cpu.usage", 90.0, 0)],
        )
        .unwrap();
        reg.ingest_snapshot("hot", snap_with_cpu(99.0), true, 2000);
        reg.ingest_snapshot("cold", snap_with_cpu(10.0), true, 2000);
        assert_eq!(reg.active_alerts("hot").len(), 1);
        assert_eq!(reg.active_alerts("cold").len(), 0);
    }

    #[test]
    fn max_agents_caps_registration() {
        let reg = AgentRegistry::new(2);
        reg.register(AgentIdentity { id: "a".into(), name: "A".into() }, &[]).unwrap();
        reg.register(AgentIdentity { id: "b".into(), name: "B".into() }, &[]).unwrap();
        assert!(reg.register(AgentIdentity { id: "c".into(), name: "C".into() }, &[]).is_err());
        // Re-registering an existing id is allowed (reconnect).
        assert!(reg.register(AgentIdentity { id: "a".into(), name: "A".into() }, &[]).is_ok());
    }

    #[test]
    fn disconnect_keeps_data_but_flags_offline() {
        let reg = AgentRegistry::new(2);
        reg.register(AgentIdentity { id: "a".into(), name: "A".into() }, &[]).unwrap();
        reg.ingest_snapshot("a", snap_with_cpu(50.0), false, 2000);
        reg.mark_disconnected("a");
        let s = reg.summaries();
        assert!(!s[0].connected);
        assert_eq!(s[0].cpu_usage, 50.0); // last-known data retained
    }

    #[test]
    fn history_is_retained_per_agent() {
        let reg = AgentRegistry::new(2);
        reg.register(AgentIdentity { id: "a".into(), name: "A".into() }, &[]).unwrap();
        for i in 0..10u64 {
            let mut s = snap_with_cpu(i as f64);
            s.timestamp = i;
            reg.ingest_snapshot("a", s, false, i);
        }
        let h = reg.history("a", 500);
        assert_eq!(h.len(), 10);
        assert_eq!(h.last().unwrap().t, 9);
        let ds = reg.history("a", 4);
        assert!(ds.len() <= 4);
        assert_eq!(ds.last().unwrap().t, 9);
    }

    #[test]
    fn replace_rules_preserves_unchanged_active_rule() {
        let reg = AgentRegistry::new(2);
        let cpu_rule = rule("cpu", "cpu.usage", 90.0, 0);
        reg.register(
            AgentIdentity { id: "a".into(), name: "A".into() },
            std::slice::from_ref(&cpu_rule),
        )
        .unwrap();
        reg.ingest_snapshot("a", snap_with_cpu(95.0), true, 1000);
        assert_eq!(reg.active_alerts("a").len(), 1);

        reg.replace_rules(&[cpu_rule, rule("mem", "memory.usedPercent", 99.0, 0)]);
        assert_eq!(reg.active_alerts("a").len(), 1);
        assert_eq!(reg.active_alerts("a")[0].id, "cpu");
    }
}
