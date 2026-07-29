//! sysmon entry point. Parses a small set of CLI flags, configures logging,
//! constructs the shared state, spawns the sampler tasks, and serves the axum
//! application until an interrupt signal is received.

use sysmon::state::config::Config;
use sysmon::state::store::AppState;
use sysmon::web;
use std::net::SocketAddr;
use std::process::ExitCode;

/// Parsed command-line options.
struct Cli {
    config_path: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    enable_shell: bool,
    print_help: bool,
    print_version: bool,
}

fn parse_cli() -> Cli {
    let mut cli = Cli {
        config_path: None,
        host: None,
        port: None,
        enable_shell: false,
        print_help: false,
        print_version: false,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => cli.print_help = true,
            "-v" | "--version" => cli.print_version = true,
            "-c" | "--config" => cli.config_path = args.next(),
            "--enable-shell" => cli.enable_shell = true,
            "--host" => cli.host = args.next(),
            "-p" | "--port" => {
                cli.port = args.next().and_then(|s| s.parse().ok());
            }
            other => {
                if let Some(rest) = other.strip_prefix("--port=") {
                    cli.port = rest.parse().ok();
                } else if let Some(rest) = other.strip_prefix("--host=") {
                    cli.host = Some(rest.to_string());
                } else if let Some(rest) = other.strip_prefix("--config=") {
                    cli.config_path = Some(rest.to_string());
                } else {
                    eprintln!("sysmon: unknown argument '{}'", other);
                }
            }
        }
    }
    cli
}

fn print_help() {
    println!(
        "sysmon {version} - modern real-time system monitor\n\
\n\
USAGE:\n    sysmon [OPTIONS]\n\
\n\
OPTIONS:\n\
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
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,sysmon=info"));
    fmt()
        .with_env_filter(filter)
        .with_target(false)
        .compact()
        .init();
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = parse_cli();

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
        tracing::warn!(
            "no /proc detected; sysmon is designed for Linux and metrics will be empty"
        );
    }

    let host = config.server.host.clone();
    let port = config.server.port;

    let enable_shell = cli.enable_shell || std::env::var("SYSMON_ENABLE_SHELL").is_ok();
    if enable_shell {
        tracing::warn!(
            "web shell ENABLED: authenticated users can run commands as this process's user"
        );
    }
    let state = AppState::with_options(config, enable_shell, None);
    sysmon::sampler::spawn(state.clone());

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

    tracing::info!("sysmon {} listening on http://{}", env!("CARGO_PKG_VERSION"), addr);
    tracing::info!("embedded assets: {}", web::assets::asset_count());
    print_banner(&addr);

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
