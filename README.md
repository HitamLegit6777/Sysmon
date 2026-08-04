<div align="center">

# SysMon

**A modern, real-time system & server monitoring dashboard for Linux — written in pure Rust with a zero-dependency embedded web UI.**

Monitor **one server** in 30 seconds, or a **whole fleet** with the `agent-monitor` binary and the free Cloudflare quick tunnel. Everything — dashboard, WebSocket stream, REST API, embedded SPA — ships as two self-contained binaries. No Node.js, no database, no runtime dependencies.

![SysMon overview](docs/overview.png)

</div>

---

## Highlights

- **Hub + agent architecture.** `sysmon` is the dashboard hub; `agent-monitor` runs on every monitored server and dials **out** to the hub — no inbound ports, works behind NAT.
- **Free Cloudflare quick tunnel, fully automatic.** The hub starts `cloudflared` itself (auto-installed by `install.sh`), prints the tunnel URL, and pushes URL rotations to every connected agent — they never get stranded.
- **Fleet view.** One card per server (CPU, memory, load, network, disk, temperature, alerts, latency), plus a fleet summary strip. Click a card — or the Servers list in the sidebar — to drill into that server's live metrics.
- **Single static binaries.** The whole SPA is embedded at compile time via `include_bytes!`. Copy two files, run them, done.
- **Live streaming over WebSocket.** Metrics push to the browser every second; the client auto-reconnects and reseeds history on reconnect.
- **Runs on any Linux server.** All hardware is auto-detected from `/proc` and `/sys`. Missing subsystems (no thermal sensors, no battery, no cpufreq, VMs, containers) degrade gracefully — never a panic, never a `NaN`.
- **Efficient by design.** Delta-based sampling, `parking_lot` locks, a `tokio` broadcast channel, and an LTO + stripped release build. Idles at a fraction of one CPU core.
- **Hardened.** Argon2id sessions, constant-time agent token checks, per-connection ingest rate limits, and input sanitization for everything a remote agent can send (see [Security](#security)).

## Features

### Metrics views (11 live views)

| View | What it shows |
| --- | --- |
| **Fleet** | Every monitored server at a glance: status, CPU, mem, load, net, temp, disk, alert counts, latency. Click to switch. |
| **Overview** | KPI tiles, stacked network area chart, per-core CPU bars, a combined performance line chart, and sparkline history. |
| **CPU** | Aggregate radial gauge, per-core utilization bars, scaling frequency, rolling utilization chart with contextual tooltips. |
| **Memory** | RAM/swap composition donut, cache/buffers/available breakdown, top memory consumers on chart hover. |
| **Network** | Per-interface throughput, recent-throughput stacked bars, socket counts (TCP/UDP/listening), lifetime and since-open RX/TX. |
| **Disk** | Filesystem capacity + inodes, per-device read/write I/O and utilization. |
| **Processes** | Full process table: header-click sorting, live filtering, row reconciliation, click-to-open detail drawer, right-click quick actions. |
| **Thermal** | Thermal zones, cooling-device states, battery/AC power (optional, conditionally rendered). |
| **Alerts** | Active alerts as prominent cards, the rule set with click-to-expand detail, and a per-server event log. |
| **Info** | Host facts: kernel, distro, CPU model, cores, memory, uptime, virtualization/container detection. |
| **Profile** | Change username/password, theme/accent (server-persisted), sign out. |

### Alerting

Threshold rules can be added, edited, or deleted from the dashboard. Changes apply immediately, persist across restarts, and are evaluated **per server** — a rule fires independently on each agent's data, and the fleet view shows where. The engine uses **duration debounce** (a rule must stay tripped for its configured window before firing). Default rules:

| Metric | Threshold | Sustained for | Severity |
| --- | --- | --- | --- |
| `cpu.usage` | > 90% | 15 s | warning |
| `memory.usedPercent` | > 90% | 20 s | warning |
| `memory.swapUsedPercent` | > 80% | 30 s | warning |
| `disk.maxUsedPercent` | > 92% | 5 s | critical |
| `load.load1PerCore` | > 2.0 | 30 s | warning |
| `thermal.maxTemp` | > 85 °C | 10 s | warning |

## Installation

One command installs everything — including `cloudflared` if it is missing (via the distro package repo, Homebrew, or a direct binary download):

```bash
curl -fsSL https://raw.githubusercontent.com/HitamLegit6777/Sysmon/main/install.sh | sudo bash
```

This installs `sysmon` + `agent-monitor` to `/usr/local/bin`, sets up systemd units, and prints a banner with the agent token.

- **Hub** (the central server): run `sudo sysmon --port 8088`, look for the **QUICK TUNNEL** banner, and copy the URL.
- **Agent** (every server you want to monitor):

```bash
curl -fsSL https://raw.githubusercontent.com/HitamLegit6777/Sysmon/main/install.sh | \
  sudo SYSMON_MODE=agent SYSMON_HUB_URL=wss://<tunnel>/agent/ws SYSMON_TOKEN=<token> bash
```

> The installer's agent mode is interactive by default (asks for hub URL + token). Environment overrides (`SYSMON_HUB_URL`, `SYSMON_TOKEN`, `SYSMON_AGENT_ID`, `SYSMON_MODE`, `SYSMON_PORT`, `SKIP_SYSTEMD`) make it scriptable.

### Build from source

**Requirements:** Linux, Rust 1.80+ (build only). No runtime dependencies.

```bash
CARGO_NET_OFFLINE=true cargo build --release --offline
# target/release/sysmon          — the hub
# target/release/agent-monitor   — the agent
```

## Quick start

```bash
# 1) Hub on your central server
SYSMON_AGENT_TOKEN=<long-secret> ./target/release/sysmon --port 8099

#    → copy the QUICK TUNNEL URL printed at startup (also in /tmp/sysmon-tunnel-url)

# 2) On every server you want to monitor
./target/release/agent-monitor --hub wss://<tunnel>/agent/ws \
    --token <same-long-secret> --id webserver-01
```

Open the dashboard, go to **Fleet**, and click a server card to watch its live metrics. Use `--no-quicktunnel` to disable the tunnel for LAN-only deployments.

### Command-line flags — hub (`sysmon`)

```
sysmon [OPTIONS]

  -p, --port <PORT>       Port to listen on          (default 8088)
      --host <HOST>       Host/interface to bind      (default 0.0.0.0)
  -c, --config <FILE>     Path to a JSON config file
        --enable-shell    Enable the web terminal (auth-gated; runs as this user)
        --no-quicktunnel  Disable the automatic Cloudflare quick tunnel
  -v, --version           Print version and exit
  -h, --help              Print help and exit
```

### Command-line flags — agent (`agent-monitor`)

```
agent-monitor --hub <URL> --token <SECRET> [OPTIONS]

        --hub <URL>       Hub WS endpoint, e.g. wss://xxx.trycloudflare.com/agent/ws
        --token <SECRET>  Shared Bearer token (must match the hub's SYSMON_AGENT_TOKEN)
        --id <NAME>       Agent id (default: this host's hostname)
        --interval-ms <N> Fast sampling interval in ms (default 1000)
  -h, --help              Print this help and exit
```

### Environment overrides

Hub:

| Variable | Effect |
| --- | --- |
| `SYSMON_PORT` | Listen port |
| `SYSMON_HOST` | Bind host/interface |
| `SYSMON_FAST_INTERVAL_MS` | Fast sampling interval (metrics push cadence) |
| `SYSMON_THEME` | Default UI theme (`dark` / `light`) |
| `SYSMON_AGENT_TOKEN` | Shared agent Bearer token (enables the agent listener) |
| `SYSMON_ENABLE_SHELL` | Enable the web terminal (same as `--enable-shell`) |

Agent:

| Variable | Effect |
| --- | --- |
| `SYSMON_AGENT_HUB` | Hub URL (same as `--hub`) |
| `SYSMON_AGENT_TOKEN` | Agent token (same as `--token`) |
| `SYSMON_AGENT_ID` | Agent id (same as `--id`) |

Precedence: CLI flags > environment > config file > built-in defaults.

### Config file (hub)

JSON with camelCase keys; every section optional, falls back to defaults:

```json
{
  "server":   { "host": "0.0.0.0", "port": 8088, "enableCompression": true },
  "sampling": { "fastIntervalMs": 1000, "processIntervalMs": 3000,
                "diskIntervalMs": 5000, "thermalIntervalMs": 4000,
                "processLimit": 200, "processIo": true },
  "history":  { "capacityFast": 3600 },
  "alerts":   { "enabled": true, "rules": [ ] },
  "ui":       { "title": "SysMon", "defaultTheme": "dark", "accentColor": "#5b8cff" },
  "agents":   { "enabled": true, "token": "change-me", "maxAgents": 64 }
}
```

## How it works (architecture)

```
[hub host]                          [server A]            [server B]
sysmon (dashboard + registry)  ←——  agent-monitor  ←——   agent-monitor
   │   /agent/ws (Bearer auth)        ↑ dials out ↑         ↑ dials out ↑
   │   /ws (browser, session auth)    └─ Cloudflare quick tunnel ─┘
   └── Fleet view + per-server drill-down
```

- **Agents** run the same `/proc` + `/sys` collectors as the hub, serialize snapshots (~1 s), process tables (~3 s), and host info, and stream them over a single outbound WebSocket.
- **The hub** authenticates each agent (constant-time Bearer check), keeps a per-agent state (latest snapshot, process table, rolling history ring, alert engine), evaluates the shared alert rules **per agent**, and fans everything out to dashboards tagged with a `serverId`.
- **Browsers** connect to `/ws` (session cookie), receive a bootstrap payload for the selected server plus a 1 s fleet heartbeat, and can switch servers with a single command.
- **The quick tunnel** is started by the hub, its URL is pushed to every connected agent, and each agent persists it — so a rotated URL is followed automatically on reconnect.

```
src/
  agents/       per-agent registry: snapshot, history ring, alert engines, sanitization
  collectors/   CPU, memory, load, network, disk, thermal, process, host  (/proc + /sys readers)
  state/        metric structs (serde camelCase), config + env overrides, shared AppState
  alerts/       threshold engine with duration debounce
  web/          axum router: REST (/api/*) + /ws + /agent/ws + embedded assets
  sampler.rs    fast / process / thermal / host tokio sampling tasks
  util/         safe /proc readers, formatters, generic ring buffer
  bin/agent_monitor.rs   the outbound agent
assets/
  css/          theme, layout, components, charts, responsive, enhanced (design system)
  js/           charts/, components/, views/, store.js, ws.js, router.js
docs/           screenshots + headless-Chrome CDP validation harness
```

## HTTP & WebSocket API

All metric data is plain JSON, so SysMon doubles as a lightweight metrics endpoint for scripts and scrapers. Everything below requires a session cookie (login first).

| Endpoint | Description |
| --- | --- |
| `POST /api/auth/login` | Login; sets an HttpOnly `sysmon_session` cookie |
| `POST /api/auth/logout` | Clear the session |
| `GET /api/auth/me` | Current identity + preferences + feature flags |
| `POST /api/auth/password` | Change password (invalidates other sessions) |
| `POST /api/auth/username` | Change username |
| `POST /api/auth/preferences` | Persist UI preferences (theme + accent) |
| `GET /api/snapshot` | Current metrics snapshot (all subsystems) |
| `GET /api/summary` | Compact summary payload |
| `GET /api/host` | Static host info |
| `GET /api/history?points=N` | Rolling history series (10–5000, default 300) |
| `GET /api/processes?sort=&limit=&order=` | Current process table |
| `GET /api/alerts?limit=N` | Active alerts + event history |
| `POST /api/alert-rules` | Create and persist an alert rule |
| `PUT /api/alert-rules/:id` | Replace an alert rule (may rename) |
| `DELETE /api/alert-rules/:id` | Delete an alert rule |
| `GET /api/config` | Effective config incl. alert rules |
| `GET /api/health` | Liveness + diagnostics (uptime, sample count, WS clients) |

WebSocket (`/ws`): a `bootstrap` payload on connect (host, snapshot, history, alerts, **servers**), then live frames. Client commands: `{"cmd":"ping"}`, `{"cmd":"select","server":"<id>"}` (switch the live stream to an agent), `{"cmd":"history","points":N}`, `{"cmd":"processes"}`, `{"cmd":"snapshot"}`.

Agent WebSocket (`/agent/ws`): authenticated with `Authorization: Bearer <token>`; agents send `hello`, `host`, `snapshot`, `processes`, `pong` frames; the hub sends `welcome`, `ping`, and `tunnelUrl` (URL rotation).

## Security

SysMon is designed to sit on a public IP behind a quick tunnel, so the trust model is explicit:

- **Dashboard auth.** Argon2id password hashing, opaque 256-bit session tokens, sliding 12 h TTL, per-IP brute-force lockout (5 failures / 60 s), `HttpOnly` + `SameSite=Strict` cookie, origin-check middleware, and CSP/security headers on every response.
- **Agent auth.** Shared Bearer token compared in constant time **over a SHA-256 digest**, so neither the token length nor per-byte timing leaks. Agents that fail auth never reach the registry.
- **Agent input is untrusted.** Every snapshot is sanitized before it reaches the alert engine, history, or dashboards: percentages clamped to 0–100, rates bounded, temperature capped, core/interface/filesystem counts truncated, process-table rows and strings bounded, control characters stripped from host/name/command fields.
- **Per-connection ingest budget.** 10 frames/s and 1 MiB/s per agent connection; a flood is dropped with a warning instead of starving the hub.
- **Web shell** (optional) is double-gated: the `--enable-shell` flag *and* a valid session *and* non-default credentials; the PTY child is killed when the socket closes.
- **Files.** `sysmon-auth.json` and alert rules are written atomically (tmp + rename) with `0600` permissions.

### Security testing

The suite includes unit tests (auth bypass, constant-time token comparison, hostile-value sanitization, evil-id rejection, process-table bounding) and a live exploit harness:

```bash
node tools/security-test.mjs http://127.0.0.1:8388 <token>
# PASS  no token rejected
# PASS  wrong token rejected
# PASS  Basic scheme rejected
# PASS  correct token accepted
# PASS  evil agent id rejected by handshake
# PASS  hostile snapshot flood survived (no crash)
```

## Robustness & portability

Every pseudo-file read goes through safe helpers (`read_to_string_safe`, `read_first_line`, `read_u64`, `read_dir_names`) that return empty/fallback values instead of erroring. One binary runs unchanged across bare-metal servers, VMs, and containers:

- **No thermal sensors / no battery** → the Thermal view shows what exists and omits the rest.
- **No `cpufreq`** → frequency is simply not displayed.
- **No physical disks (container)** → the Disk view renders its empty state.
- **Single-core / no network interface** → charts and tables render cleanly with no `NaN`.

## Validation

- `cargo test --all-targets` — 46+ Rust unit tests (auth/session behavior, alert debounce, ring buffer, formatters, registry sanitization, agent auth).
- `cargo clippy --all-targets` — warning-free.
- UI correctness is verified with a zero-dependency Chrome DevTools Protocol harness (`docs/cdp_validate.mjs`): loads all views across 4 viewports, exercises interactions, asserts `0 console errors · 0 layout overflow`.
- Live multi-server E2E: hub + 2 agents → fleet view, server switching, per-server live metrics and alerts.

```bash
cargo test --all-targets
node docs/cdp_validate.mjs     # requires a chrome binary + running server on :8099
node tools/security-test.mjs   # requires a running hub with a token
```

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Hub banner shows no tunnel | `cloudflared` missing: `install.sh` installs it, or `curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared`. |
| Agent says `connect failed` | Wrong token, hub URL, or hub down. Check `SYSMON_AGENT_TOKEN` matches the hub's `SYSMON_AGENT_TOKEN`. |
| Agent "stranded" after hub restart | It should follow the pushed tunnel URL automatically; if not, run it once with `--hub <new-url>` to refresh `/tmp/sysmon-agent-tunnel-url`. |
| Dashboard shows a server offline | The agent connection dropped; agents reconnect with backoff. Check the hub log for `agent 'x' disconnected`. |
| Can't log in | Default credentials are `admin` / `admin123` on first run — change them from the Profile page. A corrupt `sysmon-auth.json` disables login until repaired (fail-closed). |
| Port already in use | Pick another with `-p`. |

## Project stats

- ~20k LOC — Rust ~6.5k, JavaScript ~9.3k, CSS ~3.6k
- ~4.3 MB hub binary, ~1.9 MB agent binary
- 46+ Rust unit tests + live security harness + CDP UI matrix
- Zero runtime dependencies

## License

MIT — see the repository for details.
