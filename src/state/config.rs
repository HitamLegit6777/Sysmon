//! Runtime configuration. Loaded from a JSON file when present and overlaid
//! with environment variables (SYSMON_*), with sane defaults baked in so the
//! server runs with zero configuration.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub enable_compression: bool,
}

impl Default for ServerConfig {
    fn default() -> Self {
        ServerConfig {
            host: "0.0.0.0".to_string(),
            port: 8088,
            enable_compression: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SamplingConfig {
    pub fast_interval_ms: u64,
    pub process_interval_ms: u64,
    pub disk_interval_ms: u64,
    pub thermal_interval_ms: u64,
    pub process_limit: usize,
    pub process_io: bool,
}

impl Default for SamplingConfig {
    fn default() -> Self {
        SamplingConfig {
            fast_interval_ms: 1000,
            process_interval_ms: 3000,
            disk_interval_ms: 5000,
            thermal_interval_ms: 4000,
            process_limit: 200,
            process_io: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HistoryConfig {
    pub capacity_fast: usize,
}

impl Default for HistoryConfig {
    fn default() -> Self {
        HistoryConfig {
            capacity_fast: 3600,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AlertRuleConfig {
    pub id: String,
    pub metric: String,
    pub operator: String,
    pub threshold: f64,
    pub duration_ms: u64,
    pub severity: String,
    pub message: String,
}

impl Default for AlertRuleConfig {
    fn default() -> Self {
        AlertRuleConfig {
            id: String::new(),
            metric: String::new(),
            operator: ">".to_string(),
            threshold: 0.0,
            duration_ms: 0,
            severity: "warning".to_string(),
            message: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AlertsConfig {
    pub enabled: bool,
    pub rules: Vec<AlertRuleConfig>,
}

impl Default for AlertsConfig {
    fn default() -> Self {
        AlertsConfig {
            enabled: true,
            rules: default_rules(),
        }
    }
}

/// Agent (remote monitored server) settings. When `enabled` is false the hub
/// behaves exactly like a standalone single-host monitor. `token` is the
/// shared Bearer credential every `agent-monitor` must present; leave it empty
/// to keep agents disabled regardless of the flag.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentsConfig {
    pub enabled: bool,
    pub token: String,
    pub max_agents: usize,
}

impl Default for AgentsConfig {
    fn default() -> Self {
        AgentsConfig {
            enabled: false,
            token: String::new(),
            max_agents: 64,
        }
    }
}

fn default_rules() -> Vec<AlertRuleConfig> {
    vec![
        AlertRuleConfig {
            id: "cpu-high".into(),
            metric: "cpu.usage".into(),
            operator: ">".into(),
            threshold: 90.0,
            duration_ms: 15000,
            severity: "warning".into(),
            message: "CPU usage above 90%".into(),
        },
        AlertRuleConfig {
            id: "mem-high".into(),
            metric: "memory.usedPercent".into(),
            operator: ">".into(),
            threshold: 90.0,
            duration_ms: 20000,
            severity: "warning".into(),
            message: "Memory usage above 90%".into(),
        },
        AlertRuleConfig {
            id: "disk-full".into(),
            metric: "disk.maxUsedPercent".into(),
            operator: ">".into(),
            threshold: 92.0,
            duration_ms: 5000,
            severity: "critical".into(),
            message: "A filesystem is nearly full".into(),
        },
        AlertRuleConfig {
            id: "load-high".into(),
            metric: "load.load1PerCore".into(),
            operator: ">".into(),
            threshold: 2.0,
            duration_ms: 30000,
            severity: "warning".into(),
            message: "Load average high relative to core count".into(),
        },
        AlertRuleConfig {
            id: "temp-high".into(),
            metric: "thermal.maxTemp".into(),
            operator: ">".into(),
            threshold: 85.0,
            duration_ms: 10000,
            severity: "warning".into(),
            message: "Temperature is high".into(),
        },
        AlertRuleConfig {
            id: "swap-high".into(),
            metric: "memory.swapUsedPercent".into(),
            operator: ">".into(),
            threshold: 80.0,
            duration_ms: 30000,
            severity: "warning".into(),
            message: "Swap usage is high".into(),
        },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiConfig {
    pub title: String,
    pub default_theme: String,
    pub accent_color: String,
}

impl Default for UiConfig {
    fn default() -> Self {
        UiConfig {
            title: "SysMon".to_string(),
            default_theme: "dark".to_string(),
            accent_color: "#5b8cff".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub server: ServerConfig,
    pub sampling: SamplingConfig,
    pub history: HistoryConfig,
    pub alerts: AlertsConfig,
    pub ui: UiConfig,
    pub agents: AgentsConfig,
}


impl Config {
    /// Load configuration from an optional JSON file path, then overlay
    /// environment variable overrides. Missing or invalid files fall back to
    /// defaults so the server always starts.
    pub fn load(path: Option<&str>) -> Self {
        let mut config = if let Some(p) = path {
            match std::fs::read_to_string(p) {
                Ok(content) => match serde_json::from_str::<Config>(&content) {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("sysmon: failed to parse config {}: {}", p, e);
                        Config::default()
                    }
                },
                Err(_) => Config::default(),
            }
        } else {
            Config::default()
        };
        config.apply_env();
        config
    }

    /// Apply a small set of well-known environment overrides.
    fn apply_env(&mut self) {
        if let Ok(v) = std::env::var("SYSMON_PORT") {
            if let Ok(p) = v.parse() {
                self.server.port = p;
            }
        }
        if let Ok(v) = std::env::var("SYSMON_HOST") {
            self.server.host = v;
        }
        if let Ok(v) = std::env::var("SYSMON_FAST_INTERVAL_MS") {
            if let Ok(n) = v.parse() {
                self.sampling.fast_interval_ms = n;
            }
        }
        if let Ok(v) = std::env::var("SYSMON_THEME") {
            self.ui.default_theme = v;
        }
        if let Ok(v) = std::env::var("SYSMON_AGENT_TOKEN") {
            if !v.is_empty() {
                self.agents.token = v;
                // Setting a token implies agents are wanted.
                self.agents.enabled = true;
            }
        }
    }
}
