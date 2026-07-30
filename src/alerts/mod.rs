//! Alert engine. Evaluates configured threshold rules against the latest
//! metrics snapshot. A rule must hold continuously for its `duration_ms`
//! before the alert fires, which debounces transient spikes. Firing and
//! clearing transitions are recorded and exposed to the API and WebSocket.

use crate::state::config::AlertRuleConfig;
use crate::state::metrics::MetricsSnapshot;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The lifecycle state of a single rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuleState {
    /// Condition not currently met.
    Ok,
    /// Condition met but not yet for long enough to fire.
    Pending,
    /// Alert is active.
    Firing,
}

/// A currently active or recently active alert instance, exposed via the API.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveAlert {
    pub id: String,
    pub metric: String,
    pub severity: String,
    pub message: String,
    pub threshold: f64,
    pub value: f64,
    pub since: u64,
    pub active: bool,
}

/// A historical alert transition entry (fired or cleared).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertEvent {
    pub id: String,
    pub severity: String,
    pub message: String,
    pub value: f64,
    pub threshold: f64,
    pub timestamp: u64,
    pub transition: String, // "fired" | "cleared"
}

struct RuleRuntime {
    config: AlertRuleConfig,
    state: RuleState,
    condition_since: u64,
    firing_since: u64,
    last_value: f64,
}

pub struct AlertEngine {
    rules: Vec<RuleRuntime>,
    history: Vec<AlertEvent>,
    max_history: usize,
}

impl AlertEngine {
    pub fn new(rules: &[AlertRuleConfig]) -> Self {
        let runtimes = rules
            .iter()
            .cloned()
            .map(|config| RuleRuntime {
                config,
                state: RuleState::Ok,
                condition_since: 0,
                firing_since: 0,
                last_value: 0.0,
            })
            .collect();
        AlertEngine {
            rules: runtimes,
            history: Vec::new(),
            max_history: 500,
        }
    }

    /// Reconcile the evaluated rule set at runtime while retaining event
    /// history and the runtime state of rules whose configuration did not
    /// change. New or edited rules start clean and must satisfy their debounce
    /// duration; adding an unrelated rule does not clear existing alerts.
    pub fn replace_rules(&mut self, rules: &[AlertRuleConfig]) {
        let previous: HashMap<String, RuleRuntime> = self
            .rules
            .drain(..)
            .map(|runtime| (runtime.config.id.clone(), runtime))
            .collect();
        self.rules = rules
            .iter()
            .cloned()
            .map(|config| match previous.get(&config.id) {
                Some(old) if old.config == config => RuleRuntime {
                    config,
                    state: old.state,
                    condition_since: old.condition_since,
                    firing_since: old.firing_since,
                    last_value: old.last_value,
                },
                _ => RuleRuntime {
                    config,
                    state: RuleState::Ok,
                    condition_since: 0,
                    firing_since: 0,
                    last_value: 0.0,
                },
            })
            .collect();
    }

    /// Resolve a dotted metric path against a snapshot to a scalar value.
    fn resolve_metric(path: &str, snap: &MetricsSnapshot) -> Option<f64> {
        match path {
            "cpu.usage" => Some(snap.cpu.usage),
            "cpu.iowait" => Some(snap.cpu.iowait),
            "cpu.system" => Some(snap.cpu.system),
            "memory.usedPercent" => Some(snap.memory.used_percent),
            "memory.swapUsedPercent" => Some(snap.memory.swap_used_percent),
            "load.load1" => Some(snap.load.load1),
            "load.load1PerCore" => Some(snap.load.load1_per_core),
            "load.load5PerCore" => Some(snap.load.load5_per_core),
            "disk.maxUsedPercent" => Some(snap.disk.max_used_percent),
            "thermal.maxTemp" => Some(snap.thermal.max_temp),
            "network.totalRxBytesPerSec" => Some(snap.network.total_rx_bytes_per_sec),
            "network.totalTxBytesPerSec" => Some(snap.network.total_tx_bytes_per_sec),
            _ => None,
        }
    }

    fn compare(value: f64, operator: &str, threshold: f64) -> bool {
        match operator {
            ">" => value > threshold,
            ">=" => value >= threshold,
            "<" => value < threshold,
            "<=" => value <= threshold,
            "==" => (value - threshold).abs() < f64::EPSILON,
            "!=" => (value - threshold).abs() >= f64::EPSILON,
            _ => false,
        }
    }

    /// Evaluate all rules against a snapshot at time `now_ms`. Returns any new
    /// transition events produced during this evaluation.
    pub fn evaluate(&mut self, snap: &MetricsSnapshot, now_ms: u64) -> Vec<AlertEvent> {
        let mut events = Vec::new();
        for rule in self.rules.iter_mut() {
            let value = match Self::resolve_metric(&rule.config.metric, snap) {
                Some(v) => v,
                None => continue,
            };
            rule.last_value = value;
            let condition_met = Self::compare(value, &rule.config.operator, rule.config.threshold);

            match rule.state {
                RuleState::Ok => {
                    if condition_met {
                        rule.state = RuleState::Pending;
                        rule.condition_since = now_ms;
                        if rule.config.duration_ms == 0 {
                            // Fire immediately when no duration is required.
                            rule.state = RuleState::Firing;
                            rule.firing_since = now_ms;
                            events.push(Self::make_event(rule, "fired", now_ms));
                        }
                    }
                }
                RuleState::Pending => {
                    if !condition_met {
                        rule.state = RuleState::Ok;
                    } else if now_ms.saturating_sub(rule.condition_since) >= rule.config.duration_ms
                    {
                        rule.state = RuleState::Firing;
                        rule.firing_since = now_ms;
                        events.push(Self::make_event(rule, "fired", now_ms));
                    }
                }
                RuleState::Firing => {
                    if !condition_met {
                        rule.state = RuleState::Ok;
                        events.push(Self::make_event(rule, "cleared", now_ms));
                    }
                }
            }
        }

        for ev in &events {
            self.history.push(ev.clone());
        }
        if self.history.len() > self.max_history {
            let excess = self.history.len() - self.max_history;
            self.history.drain(0..excess);
        }

        events
    }

    fn make_event(rule: &RuleRuntime, transition: &str, now_ms: u64) -> AlertEvent {
        AlertEvent {
            id: rule.config.id.clone(),
            severity: rule.config.severity.clone(),
            message: rule.config.message.clone(),
            value: crate::util::format::round_to(rule.last_value, 2),
            threshold: rule.config.threshold,
            timestamp: now_ms,
            transition: transition.to_string(),
        }
    }

    /// Snapshot of currently active alerts.
    pub fn active(&self) -> Vec<ActiveAlert> {
        self.rules
            .iter()
            .filter(|r| r.state == RuleState::Firing)
            .map(|r| ActiveAlert {
                id: r.config.id.clone(),
                metric: r.config.metric.clone(),
                severity: r.config.severity.clone(),
                message: r.config.message.clone(),
                threshold: r.config.threshold,
                value: crate::util::format::round_to(r.last_value, 2),
                since: r.firing_since,
                active: true,
            })
            .collect()
    }

    /// Count of active alerts by severity for badges.
    pub fn active_counts(&self) -> HashMap<String, usize> {
        let mut counts = HashMap::new();
        for r in self.rules.iter().filter(|r| r.state == RuleState::Firing) {
            *counts.entry(r.config.severity.clone()).or_insert(0) += 1;
        }
        counts
    }

    /// Recent alert history, newest last.
    pub fn history(&self, limit: usize) -> Vec<AlertEvent> {
        let len = self.history.len();
        let start = len.saturating_sub(limit);
        self.history[start..].to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn test_immediate_fire_and_clear() {
        let mut engine = AlertEngine::new(&[rule("cpu", "cpu.usage", 90.0, 0)]);
        let mut snap = MetricsSnapshot::default();
        snap.cpu.usage = 95.0;
        let events = engine.evaluate(&snap, 1000);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].transition, "fired");
        assert_eq!(engine.active().len(), 1);

        snap.cpu.usage = 50.0;
        let events = engine.evaluate(&snap, 2000);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].transition, "cleared");
        assert_eq!(engine.active().len(), 0);
    }

    #[test]
    fn test_duration_debounce() {
        let mut engine = AlertEngine::new(&[rule("cpu", "cpu.usage", 90.0, 5000)]);
        let mut snap = MetricsSnapshot::default();
        snap.cpu.usage = 95.0;
        // Condition met but not long enough yet.
        assert_eq!(engine.evaluate(&snap, 1000).len(), 0);
        assert_eq!(engine.evaluate(&snap, 3000).len(), 0);
        // Now it has held for >= 5000ms.
        let events = engine.evaluate(&snap, 6000);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].transition, "fired");
    }

    #[test]
    fn replacing_rules_resets_runtime_but_keeps_history() {
        let mut engine = AlertEngine::new(&[rule("cpu", "cpu.usage", 90.0, 0)]);
        let mut snap = MetricsSnapshot::default();
        snap.cpu.usage = 95.0;
        assert_eq!(engine.evaluate(&snap, 1000).len(), 1);
        assert_eq!(engine.history(10).len(), 1);

        engine.replace_rules(&[rule("cpu-new", "cpu.usage", 99.0, 0)]);
        assert!(engine.active().is_empty());
        assert_eq!(engine.history(10).len(), 1);
        assert!(engine.evaluate(&snap, 2000).is_empty());
    }

    #[test]
    fn adding_rule_preserves_unchanged_active_rule() {
        let original = rule("cpu", "cpu.usage", 90.0, 0);
        let mut engine = AlertEngine::new(std::slice::from_ref(&original));
        let mut snap = MetricsSnapshot::default();
        snap.cpu.usage = 95.0;
        engine.evaluate(&snap, 1000);
        assert_eq!(engine.active().len(), 1);

        engine.replace_rules(&[original, rule("cpu-system", "cpu.system", 80.0, 0)]);
        assert_eq!(engine.active().len(), 1);
        assert_eq!(engine.active()[0].id, "cpu");
    }

    #[test]
    fn test_pending_reset() {
        let mut engine = AlertEngine::new(&[rule("cpu", "cpu.usage", 90.0, 5000)]);
        let mut snap = MetricsSnapshot::default();
        snap.cpu.usage = 95.0;
        assert_eq!(engine.evaluate(&snap, 1000).len(), 0);
        // Drops before firing; should reset without an event.
        snap.cpu.usage = 10.0;
        assert_eq!(engine.evaluate(&snap, 2000).len(), 0);
        assert_eq!(engine.active().len(), 0);
    }
}
