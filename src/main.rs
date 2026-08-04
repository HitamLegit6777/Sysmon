//! sysmon entry point. Parses a small set of CLI flags, configures logging,
//! constructs the shared state, spawns the sampler tasks, and serves the axum
//! application until an interrupt signal is received.

use std::net::SocketAddr;
use std::process::ExitCode;
use sysmon::state::config::Config;
use sysmon::state::store::AppState;
use sysmon::web;

/// Parsed command-line options.
struct Cli {
    config_path: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    enable_shell: bool,
    quicktunnel: bool,
    print_help: bool,
    print_version: bool,
    error: Option<String>,
}

fn parse_cli() -> Cli {
    let mut cli = Cli {
        config_path: None,
        host: None,
        port: None,
        enable_shell: false,
        quicktunnel: true,
        print_help: false,
        print_version: false,
        error: None,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let result = match arg.as_str() {
            "-h" | "--help" => {
                cli.print_help = true;
                Ok(())
            }
            "-v" | "--version" => {
                cli.print_version = true;
                Ok(())
            }
            "-c" | "--config" => required_value(&mut args, &arg).map(|v| cli.config_path = Some(v)),
            "--enable-shell" => {
                cli.enable_shell = true;
                Ok(())
            }
            "--no-quicktunnel" => {
                cli.quicktunnel = false;
                Ok(())
            }
            "--quicktunnel" => {
                cli.quicktunnel = true;
                Ok(())
            }
            "--host" => required_value(&mut args, &arg).map(|v| cli.host = Some(v)),
            "-p" | "--port" => required_value(&mut args, &arg)
                .and_then(|v| parse_port(&v).map(|p| cli.port = Some(p))),
            other if other.starts_with("--port=") => {
                parse_port(&other[7..]).map(|p| cli.port = Some(p))
            }
            other if other.starts_with("--host=") => {
                nonempty_value("--host", &other[7..]).map(|v| cli.host = Some(v))
            }
            other if other.starts_with("--config=") => {
                nonempty_value("--config", &other[9..]).map(|v| cli.config_path = Some(v))
            }
            other => Err(format!("unknown argument '{}'", other)),
        };
        if let Err(error) = result {
            cli.error = Some(error);
            break;
        }
    }
    cli
}

fn required_value(args: &mut impl Iterator<Item = String>, option: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("option '{}' requires a value", option))
        .and_then(|value| nonempty_value(option, &value))
}

fn nonempty_value(option: &str, value: &str) -> Result<String, String> {
    if value.is_empty() {
        Err(format!("option '{}' requires a value", option))
    } else {
        Ok(value.to_string())
    }
}

fn parse_port(value: &str) -> Result<u16, String> {
    value
        .parse()
        .map_err(|_| format!("invalid port '{}'; expected 0-65535", value))
}

fn print_help() {
    println!(
        "sysmon {version} - modern real-time system monitor\n\
\n\
        --no-quicktunnel     Disable the automatic Cloudflare quick tunnel\n\
    -p, --port <PORT>       Port to listen on (default 8088)\n\
        --host <HOST>       Host/interface to bind (default 0.0.0.0)\n\
    -c, --config <FILE>     Path to a JSON config file\n\
        --enable-shell      Enable the web terminal (auth-gated; runs commands as this user)\n\
    -v, --version           Print version and exit\n\
    -h, --help              Print this help and exit\n\
\n\
ENVIRONMENT:\n\
    SYSMON_PORT             Overrides the listen port\n\
    SYSMON_HOST             Overrides the bind host\n\
    SYSMON_FAST_INTERVAL_MS Fast sampling interval in milliseconds\n\
    SYSMON_THEME            Default UI theme (dark|light)\n\
    RUST_LOG                Log filter (e.g. info, sysmon=debug)\n",
        version = env!("CARGO_PKG_VERSION")
    );
}

fn init_logging() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,sysmon=info"));
    fmt()
        .with_env_filter(filter)
        .with_target(false)
        .compact()
        .init();
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = parse_cli();
    if let Some(error) = cli.error.as_deref() {
        eprintln!("sysmon: {}", error);
        eprintln!("Try 'sysmon --help' for usage.");
        return ExitCode::FAILURE;
    }

    if cli.print_help {
        print_help();
        return ExitCode::SUCCESS;
    }
    if cli.print_version {
        println!("sysmon {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }

    init_logging();

    // Load configuration and apply CLI overrides (highest precedence).
    let mut config = Config::load(cli.config_path.as_deref());
    if let Some(host) = cli.host {
        config.server.host = host;
    }
    if let Some(port) = cli.port {
        config.server.port = port;
    }

    if !sysmon::util::procfs::has_procfs() {
        tracing::warn!("no /proc detected; sysmon is designed for Linux and metrics will be empty");
    }

    let host = config.server.host.clone();
    let port = config.server.port;

    let enable_shell = cli.enable_shell || std::env::var("SYSMON_ENABLE_SHELL").is_ok();
    if enable_shell {
        tracing::warn!(
            "web shell requested; it remains disabled while default credentials are active"
        );
    }
    let state = AppState::with_options(
        config,
        enable_shell,
        None,
        Some(std::path::PathBuf::from("sysmon-rules.json")),
    );
    sysmon::sampler::spawn(state.clone());
    spawn_fleet_tick(state.clone());

    let app = web::build_router(state.clone());

    let addr: SocketAddr = match format!("{}:{}", host, port).parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("sysmon: invalid bind address {}:{}: {}", host, port, e);
            return ExitCode::FAILURE;
        }
    };

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("sysmon: failed to bind {}: {}", addr, e);
            return ExitCode::FAILURE;
        }
    };

    tracing::info!(
        "sysmon {} listening on http://{}",
        env!("CARGO_PKG_VERSION"),
        addr
    );
    tracing::info!("embedded assets: {}", web::assets::asset_count());
    print_banner(&addr);

    // Quick tunnel is on by default so agents can phone home without any
    // setup; --no-quicktunnel disables it (LAN-only deployment).
    if cli.quicktunnel {
        spawn_quicktunnel(addr.port(), state.clone());
    }

    let server = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal());

    if let Err(e) = server.await {
        eprintln!("sysmon: server error: {}", e);
        return ExitCode::FAILURE;
    }

    tracing::info!("sysmon shut down cleanly");
    ExitCode::SUCCESS
}

fn print_banner(addr: &SocketAddr) {
    let url = if addr.ip().is_unspecified() {
        format!("http://localhost:{}", addr.port())
    } else {
        format!("http://{}", addr)
    };
    println!();
    println!("  ┌─────────────────────────────────────────────┐");
    println!("  │   sysmon - live system monitoring dashboard   │");
    println!("  │                                               │");
    println!("  │   Open: {:<36}│", url);
    println!("  └─────────────────────────────────────────────┘");
    println!();
}

/// Resolve when the process receives Ctrl-C or a SIGTERM.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut sig) = signal(SignalKind::terminate()) {
            sig.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}

/// Broadcast compact per-agent summaries to dashboards once per second so the
/// fleet view and the sidebar stay live without per-server subscriptions.
fn spawn_fleet_tick(state: sysmon::state::store::AppState) {
    use sysmon::state::store::StreamMessage;
    tokio::spawn(async move {
        let mut iv = tokio::time::interval(std::time::Duration::from_secs(1));
        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            iv.tick().await;
            let summaries = state.agents().summaries();
            if !summaries.is_empty() {
                state.broadcast(StreamMessage::Fleet { data: summaries });
            }
        }
    });
}

const TUNNEL_URL_FILE: &str = "/tmp/sysmon-tunnel-url";
const TUNNEL_PID_FILE: &str = "/tmp/sysmon-cloudflared.pid";

/// Auto-start the free Cloudflare quick tunnel.
///
/// Stability strategy for the "URL keeps changing" problem:
/// 1. If a cloudflared we spawned is still alive (pid file), reuse its tunnel
///    URL — no new URL, agents stay connected.
/// 2. The URL is persisted to a file so the operator and agents can read it.
/// 3. If a *new* URL appears (restart, tunnel died), every connected agent is
///    pushed the new URL over its outbound channel immediately; agents persist
///    it and reconnect there.
fn spawn_quicktunnel(port: u16, state: sysmon::state::store::AppState) {
    use std::process::Stdio;
    use tokio::process::Command;

    // Reuse a live tunnel from a previous hub run (same host) so restarts do
    // not churn the URL. The pid file is written by us below.
    if let Some(url) = read_tunnel_state() {
        tracing::info!("reusing existing quick tunnel: {}", url);
        broadcast_tunnel_url(&state, &url);
        return;
    }

    let mut child = match Command::new("cloudflared")
        .args(["tunnel", "--url", &format!("http://127.0.0.1:{}", port)])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(
                "quicktunnel: 'cloudflared' not available ({}); agents must reach this host directly",
                e
            );
            return;
        }
    };
    let pid = child.id().unwrap_or(0);
    let _ = std::fs::write(TUNNEL_PID_FILE, format!("{}\n", pid));

    tokio::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        let stderr = child.stderr.take().expect("stderr piped");
        let mut lines = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(idx) = line.find("trycloudflare.com") {
                let start = line[..idx].rfind("https://").unwrap_or(idx);
                let url = line[start..idx + "trycloudflare.com".len()].to_string();
                let _ = std::fs::write(TUNNEL_URL_FILE, &url);
                let _ = std::fs::remove_file(TUNNEL_PID_FILE);
                println!();
                println!("  ┌─────────────────────────────────────────────┐");
                println!("  │   QUICK TUNNEL (agents connect here):      │");
                println!("  │   {:<37}│", url);
                println!("  └─────────────────────────────────────────────┘");
                println!();
                tracing::info!("quick tunnel ready: {}", url);
                // Tell every connected agent where to find us from now on.
                broadcast_tunnel_url(&state, &url);
                break;
            }
        }
        // Keep the child alive until the hub exits (kill_on_drop handles it).
        let _ = child.wait().await;
    });
}

/// Read a previously persisted tunnel URL if a cloudflared for it is still
/// running on this host. The URL file is only trusted when the pid file is
/// gone (we delete it once the URL is published), so a stale file cannot
/// resurrect a dead tunnel.
fn read_tunnel_state() -> Option<String> {
    if std::path::Path::new(TUNNEL_PID_FILE).exists() {
        return None; // a tunnel is still starting up; wait for it below
    }
    let url = std::fs::read_to_string(TUNNEL_URL_FILE).ok()?;
    let url = url.trim().to_string();
    if url.starts_with("https://") && url.contains("trycloudflare.com") {
        Some(url)
    } else {
        None
    }
}

/// Push the current tunnel URL to every connected agent so they can persist
/// it and reconnect there after a hub restart or tunnel rotation.
fn broadcast_tunnel_url(state: &sysmon::state::store::AppState, url: &str) {
    let ids: Vec<String> = state
        .agents()
        .summaries()
        .into_iter()
        .filter(|s| s.connected)
        .map(|s| s.id)
        .collect();
    for id in ids {
        state.agents().send_to_agent(
            &id,
            format!("{{\"type\":\"tunnelUrl\",\"data\":{}}}", serde_json::to_string(url).unwrap_or_default()),
        );
    }
}
