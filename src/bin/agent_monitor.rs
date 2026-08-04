//! agent-monitor — the outbound telemetry agent for SysMon.
//!
//! Runs the same /proc + /sys collectors as the hub and streams snapshots to
//! a SysMon hub over WebSocket (typically through the hub's Cloudflare quick
//! tunnel, so this agent needs NO inbound ports and can live behind NAT).
//!
//! The agent dials OUT to the hub, authenticates with a shared Bearer token,
//! and reconnects forever with exponential backoff + jitter. The hub may push
//! a new tunnel URL at any time (`{"type":"tunnelUrl","data":"https://..."}`);
//! the agent persists it and reconnects there, so a rotated quick-tunnel URL
//! never strands the agent.
//!
//! Usage:
//!   agent-monitor --hub wss://<hub>/agent/ws --token <secret> [--id name]
//!
//! Env overrides: SYSMON_AGENT_HUB, SYSMON_AGENT_TOKEN, SYSMON_AGENT_ID.

use std::sync::Arc;
use std::time::Duration;
use sysmon::collectors::{
    CpuCollector, DiskCollector, HostCollector, LoadCollector, MemoryCollector, NetworkCollector,
    ProcessCollector, ThermalCollector,
};
use tokio::sync::{broadcast, Mutex};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use futures::{SinkExt, StreamExt};

const TUNNEL_URL_FILE: &str = "/tmp/sysmon-agent-tunnel-url";

struct Cli {
    hub: String,
    token: String,
    id: String,
    fast_interval_ms: u64,
    process_interval_ms: u64,
    process_limit: usize,
    process_io: bool,
    help: bool,
}

fn env_or(name: &str, fallback: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| fallback.to_string())
}

fn parse_cli() -> Cli {
    let mut cli = Cli {
        hub: env_or("SYSMON_AGENT_HUB", ""),
        token: env_or("SYSMON_AGENT_TOKEN", ""),
        id: env_or("SYSMON_AGENT_ID", ""),
        fast_interval_ms: 1000,
        process_interval_ms: 3000,
        process_limit: 200,
        process_io: true,
        help: false,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value_of = |flag: &str| -> String {
            args.next().unwrap_or_else(|| {
                eprintln!("agent-monitor: option '{}' requires a value", flag);
                std::process::exit(2);
            })
        };
        match arg.as_str() {
            "-h" | "--help" => cli.help = true,
            "--hub" => cli.hub = value_of("--hub"),
            "--token" => cli.token = value_of("--token"),
            "--id" => cli.id = value_of("--id"),
            "--interval-ms" => {
                if let Ok(n) = value_of("--interval-ms").parse() {
                    cli.fast_interval_ms = n;
                }
            }
            other if other.starts_with("--hub=") => cli.hub = other[6..].to_string(),
            other if other.starts_with("--token=") => cli.token = other[8..].to_string(),
            other if other.starts_with("--id=") => cli.id = other[5..].to_string(),
            _ => {
                eprintln!("agent-monitor: unknown argument '{}'", arg);
                std::process::exit(2);
            }
        }
    }
    cli
}

fn print_help() {
    println!(
        "agent-monitor - SysMon telemetry agent\n\
\n\
USAGE:\n    agent-monitor --hub <URL> --token <SECRET> [OPTIONS]\n\
\n\
OPTIONS:\n\
        --hub <URL>         Hub WebSocket endpoint, e.g. wss://xxx.trycloudflare.com/agent/ws\n\
        --token <SECRET>    Shared Bearer token (same as the hub's SYSMON_AGENT_TOKEN)\n\
        --id <NAME>         Agent id (default: this host's hostname)\n\
        --interval-ms <N>   Fast sampling interval in ms (default 1000)\n\
    -h, --help              Print this help and exit\n\
\n\
ENVIRONMENT:\n\
    SYSMON_AGENT_HUB, SYSMON_AGENT_TOKEN, SYSMON_AGENT_ID\n"
    );
}

fn frame(kind: &str, data: &impl serde::Serialize) -> String {
    serde_json::json!({ "type": kind, "data": data }).to_string()
}

/// Persist a tunnel URL pushed by the hub so a restart reconnects to the
/// latest endpoint even if the operator never updates the flag.
fn persist_tunnel_url(url: &str) {
    let _ = std::fs::write(TUNNEL_URL_FILE, url);
}

fn read_persisted_tunnel_url() -> Option<String> {
    let url = std::fs::read_to_string(TUNNEL_URL_FILE).ok()?;
    let url = url.trim().to_string();
    if url.starts_with("https://") || url.starts_with("wss://") {
        Some(url)
    } else {
        None
    }
}

/// Normalize a hub base URL into the agent WS endpoint.
fn hub_ws_url(hub: &str) -> String {
    let hub = hub.trim();
    let hub = hub.strip_suffix('/').unwrap_or(hub);
    if hub.starts_with("ws://") || hub.starts_with("wss://") {
        if hub.ends_with("/agent/ws") {
            hub.to_string()
        } else {
            format!("{}/agent/ws", hub)
        }
    } else {
        let scheme = if hub.starts_with("http://") { "ws" } else { "wss" };
        let host = hub
            .trim_start_matches("http://")
            .trim_start_matches("https://");
        format!("{}://{}/agent/ws", scheme, host)
    }
}

#[tokio::main]
async fn main() {
    let cli = parse_cli();
    if cli.help {
        print_help();
        return;
    }

    // Hub resolution: CLI flag wins, then the pushed tunnel URL, then env.
    let mut hub_ws = if !cli.hub.is_empty() {
        hub_ws_url(&cli.hub)
    } else if let Some(pushed) = read_persisted_tunnel_url() {
        hub_ws_url(&pushed)
    } else {
        eprintln!("agent-monitor: no hub configured. Pass --hub <URL> (or set SYSMON_AGENT_HUB).");
        std::process::exit(2);
    };

    let token = cli.token.clone();
    if token.is_empty() {
        eprintln!("agent-monitor: no token configured. Pass --token <SECRET> (or set SYSMON_AGENT_TOKEN).");
        std::process::exit(2);
    }

    let id = if cli.id.is_empty() {
        HostCollector::new().collect().hostname
    } else {
        cli.id.clone()
    };
    if let Err(e) = sysmon::agents::validate_agent_id(&id) {
        eprintln!("agent-monitor: invalid --id: {}", e);
        std::process::exit(2);
    }

    // --- Frame distribution: a broadcast channel so every connection's writer
    // can subscribe (a fresh receiver per connection). The hub reseeds on
    // reconnect, so dropping lagged frames while the socket is down is fine.
    let (frame_tx, _) = broadcast::channel::<String>(256);

    let fast_tx = frame_tx.clone();
    let fast_iv = cli.fast_interval_ms.max(100);
    tokio::spawn(async move {
        let mut cpu = CpuCollector::new();
        let mut mem = MemoryCollector::new();
        let mut load = LoadCollector::new();
        let mut net = NetworkCollector::new();
        let mut disk = DiskCollector::new();
        let mut thermal = ThermalCollector::new();
        cpu.collect();
        net.collect();
        disk.collect();
        tokio::time::sleep(Duration::from_millis(fast_iv.min(1000))).await;
        let mut iv = tokio::time::interval(Duration::from_millis(fast_iv));
        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let disk_every = (5000u64 / fast_iv).max(1);
        let mut tick = 0u64;
        let mut last_disk = disk.collect();
        loop {
            iv.tick().await;
            tick += 1;
            if tick % disk_every == 0 {
                last_disk = disk.collect();
            }
            let mut snap = sysmon::state::metrics::MetricsSnapshot {
                timestamp: sysmon::state::now_millis(),
                cpu: cpu.collect(),
                memory: mem.collect(),
                load: load.collect(),
                network: net.collect(),
                ..Default::default()
            };
            snap.disk = last_disk.clone();
            snap.thermal = thermal.collect();
            let _ = fast_tx.send(frame("snapshot", &snap));
        }
    });

    let proc_tx = frame_tx.clone();
    let proc_iv = cli.process_interval_ms.max(500);
    tokio::spawn(async move {
        let mut collector = ProcessCollector::new();
        collector.collect(cli.process_limit, cli.process_io);
        tokio::time::sleep(Duration::from_millis(proc_iv.min(1500))).await;
        let mut iv = tokio::time::interval(Duration::from_millis(proc_iv));
        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            iv.tick().await;
            let procs = collector.collect(cli.process_limit, cli.process_io);
            let _ = proc_tx.send(frame("processes", &procs));
        }
    });

    // Host info: sent once per connection (after hello) so a freshly started
    // hub always learns the agent's identity.
    let host_info = {
        let mut collector = HostCollector::new();
        let host = collector.collect();
        frame("host", &host)
    };

    // --- Connection loop: dial, run the per-connection handler until the
    // socket dies, then reconnect with exponential backoff + jitter.
    let mut backoff_ms = 1000u64;
    loop {
        let request = match hub_ws.clone().into_client_request() {
            Ok(mut req) => {
                let auth = format!("Bearer {}", token);
                req.headers_mut().insert("Authorization", auth.parse().expect("bearer header"));
                Ok(req)
            }
            Err(e) => Err(e),
        };
        let request = match request {
            Ok(r) => r,
            Err(e) => {
                tracing::error!("bad hub URL '{}': {}", hub_ws, e);
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };

        match tokio_tungstenite::connect_async(request).await {
            Ok((ws_stream, _resp)) => {
                tracing::info!("connected to hub {}", hub_ws);
                backoff_ms = 1000;

                let (sink, mut stream) = ws_stream.split();
                let sink = Arc::new(Mutex::new(sink));
                let hello = serde_json::json!({
                    "type": "hello",
                    "id": id,
                    "name": id,
                })
                .to_string();
                let host_info = host_info.clone();

                // Writer task: hello + metric frames. The sink is shared with
                // the reader loop (ping replies) via the mutex.
                let writer_sink = sink.clone();
                let mut frame_rx = frame_tx.subscribe();
                let writer = tokio::spawn(async move {
                    if writer_sink.lock().await.send(WsMessage::Text(hello.into())).await.is_err() {
                        return;
                    }
                    if writer_sink.lock().await.send(WsMessage::Text(host_info.into())).await.is_err() {
                        return;
                    }
                    loop {
                        match frame_rx.recv().await {
                            Ok(frame) => {
                                if writer_sink.lock().await.send(WsMessage::Text(frame.into())).await.is_err() {
                                    break;
                                }
                            }
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => return,
                        }
                    }
                });

                // Reader loop: hub commands (tunnel URL rotation, ping).
                loop {
                    match stream.next().await {
                        Some(Ok(WsMessage::Text(text))) => {
                            let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                                continue;
                            };
                            match value.get("type").and_then(|v| v.as_str()) {
                                Some("tunnelUrl") => {
                                    if let Some(url) = value.get("data").and_then(|v| v.as_str()) {
                                        persist_tunnel_url(url);
                                        tracing::info!("hub pushed new tunnel URL: {}", url);
                                        hub_ws = hub_ws_url(url);
                                    }
                                }
                                Some("ping") => {
                                    let data = value.get("data").cloned();
                                    let reply =
                                        serde_json::json!({ "type": "pong", "data": data }).to_string();
                                    if sink.lock().await.send(WsMessage::Text(reply.into())).await.is_err() {
                                        break;
                                    }
                                }
                                _ => {}
                            }
                        }
                        Some(Ok(WsMessage::Ping(payload))) => {
                            if sink.lock().await.send(WsMessage::Pong(payload)).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(WsMessage::Close(_))) | None => break,
                        Some(Err(_)) => break,
                        _ => {}
                    }
                }

                writer.abort();
                tracing::warn!("disconnected from hub; reconnecting in {}ms", backoff_ms);
            }
            Err(e) => {
                tracing::warn!("connect failed ({}); retrying in {}ms", e, backoff_ms);
            }
        }

        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
        backoff_ms = (backoff_ms * 2).min(30_000);
        // Jitter to avoid a thundering herd after hub restarts.
        tokio::time::sleep(Duration::from_millis(rand::random::<u64>() % 1000)).await;
    }
}
