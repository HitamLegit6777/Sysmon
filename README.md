<div align="center">

# SysMon

**A modern, real-time system & server monitoring dashboard for Linux — written in pure Rust with a zero-dependency embedded web UI.**

The entire frontend is compiled into a single self-contained binary (~2.8 MB). No Node.js, no runtime, no external assets, no database. Drop the binary on any Linux host and open a browser.

![SysMon overview](docs/overview.png)

</div>

---

## Highlights

- **Single static binary.** The whole SPA (HTML/CSS/JS, ~11.5k LOC) is embedded at compile time via `include_bytes!`. Copy one file, run it, done.
- **Live streaming over WebSocket.** Metrics push to the browser every second; the client auto-reconnects and reseeds history on reconnect.
- **Runs on any Linux server.** All hardware is auto-detected from `/proc` and `/sys`. Missing subsystems (no thermal sensors, no battery, no cpufreq, headless VMs, containers) degrade gracefully — never a panic, never a `NaN`.
- **Efficient by design.** Delta-based sampling, `parking_lot` locks, a `tokio` broadcast channel, and an LTO + stripped release build. Idles at a fraction of one CPU core.
- **Modern, polished UI.** Dark/light themes with accent colors, dependency-free canvas charts, a command palette, keyboard shortcuts, a settings drawer, and sortable/searchable tables — responsive down to mobile.

## Features

### Metrics (9 live views)

| View | What it shows |
| --- | --- |
| **Overview** | KPI tiles, stacked network area chart, per-core CPU bars, a combined performance line chart, and sparkline history for every subsystem. |
| **CPU** | Aggregate radial gauge, per-core utilization heatmap, scaling frequency, and a rolling utilization chart with a contextual tooltip (temp + load at each instant). |
| **Memory** | RAM/swap composition donut, cache/buffers/available breakdown, and top memory-consuming processes on chart hover. |
| **Network** | Per-interface throughput, a "recent throughput" stacked-bar chart, live rates, socket counts (TCP/UDP/listening), and lifetime **and** since-open RX/TX totals. |
| **Disk** | Filesystem capacity donuts, per-device read/write I/O, and a throughput chart. |
| **Processes** | Full process table with header-click sorting, live filtering, row reconciliation, a click-to-open detail drawer, and a right-click quick-action menu. |
| **Thermal** | Thermal zones, cooling-device states, and battery/AC power (all optional and conditionally rendered). |
| **Alerts** | Active alerts as prominent cards, the configured rule set with click-to-expand detail (current value vs. threshold, severity, sustained-for), and an event log. |
| **Info** | Static host facts: kernel, distro, CPU model, core count, memory, uptime, virtualization/container detection. |

### Alerting

A threshold engine evaluates rules on an interval with **duration debounce** (a rule must stay tripped for its configured window before firing), so transient spikes don't spam you. Default rules:

| Metric | Threshold | Sustained for | Severity |
| --- | --- | --- | --- |
| `cpu.usage` | > 90% | 15 s | warning |
| `memory.usedPercent` | > 90% | 20 s | warning |
| `memory.swapUsedPercent` | > 80% | 30 s | warning |
| `disk.maxUsedPercent` | > 92% | 5 s | critical |
| `load.load1PerCore` | > 2.0 | 30 s | warning |
| `thermal.maxTemp` | > 85 °C | 10 s | warning |

## Quick start

**Requirements:** Linux, Rust 1.80+ (build only). No runtime dependencies.

```bash
# Build a release binary (deps are vendored in the cargo cache; --offline works)
CARGO_NET_OFFLINE=true cargo build --release --offline

# Run — binds 0.0.0.0 by default so it's reachable across your LAN
./target/release/sysmon --port 8099
```

Open `http://localhost:8099` locally, or `http://<server-ip>:8099` from another device.

### Command-line flags

```
sysmon [OPTIONS]

  -p, --port <PORT>     Port to listen on          (default 8088)
      --host <HOST>     Host/interface to bind      (default 0.0.0.0)
  -c, --config <FILE>   Path to a JSON config file
  -v, --version         Print version and exit
  -h, --help            Print help and exit
```

### Environment overrides

| Variable | Effect |
| --- | --- |
| `SYSMON_PORT` | Listen port |
| `SYSMON_HOST` | Bind host/interface |
| `SYSMON_FAST_INTERVAL_MS` | Fast sampling interval (metrics push cadence) |
| `SYSMON_THEME` | Default UI theme (`dark` / `light`) |

CLI flags take precedence over environment variables, which take precedence over the config file, which falls back to sane built-in defaults.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Ctrl/⌘ + K` | Open the command palette |
| `?` | Show the keyboard-shortcut help |
| `,` | Open settings |
| `Shift + T` | Toggle theme |
| `Space` | Pause / resume the live stream |
| `g` then `o/c/m/n/d/p/t/a/i` | Jump to a view |

## HTTP & WebSocket API

All metric data is available as plain JSON, so SysMon doubles as a lightweight metrics endpoint for scripts and scrapers.

| Endpoint | Description |
| --- | --- |
| `GET /api/snapshot` | Current metrics snapshot (all subsystems) |
| `GET /api/summary` | Compact summary payload |
| `GET /api/host` | Static host info |
| `GET /api/history` | Rolling history series |
| `GET /api/processes` | Current process table |
| `GET /api/alerts` | Active alerts + event history |
| `GET /api/config` | Effective config incl. alert rules |
| `GET /api/health` | Liveness + diagnostics (uptime, sample count, WS clients) |
| `GET /ws` | WebSocket stream: a bootstrap payload on connect, then live updates |

The WebSocket also accepts small JSON commands from the client: `{"cmd":"ping"}`, `{"cmd":"history","points":600}`, `{"cmd":"processes"}`, and `{"cmd":"snapshot"}`.

## Architecture

```
src/
  collectors/   CPU, memory, load, network, disk, thermal, process, host   (/proc + /sys readers)
  state/        metric structs (serde camelCase), config + env overrides, shared AppState
  alerts/       threshold engine with duration debounce
  web/          axum router: REST (/api/*) + WebSocket (/ws) + embedded assets
  sampler.rs    fast / process / thermal / host tokio sampling tasks
  util/         safe /proc readers, formatters, generic ring buffer
assets/
  css/          theme, layout, components, charts, responsive, enhanced (design system)
  js/
    charts/     line, area, gauge, radial gauge, bars, stacked bars, donut, sparkline, heatmap
    components/ primitives, widgets, tooltip/context-menu, command palette, settings, tables, ...
    views/      one module per SPA view
    store.js    reactive pub/sub store
    ws.js       auto-reconnecting WebSocket client
    router.js   hash-based SPA router
docs/           screenshots + headless-Chrome CDP validation harness
```

**Data flow:** collectors read `/proc` and `/sys` → the sampler writes snapshots into a lock-guarded `AppState` → a `tokio` broadcast channel fans out to connected WebSocket clients → the browser store updates → subscribed views re-render.

## Robustness & portability

Every pseudo-file read goes through safe helpers (`read_to_string_safe`, `read_first_line`, `read_u64`, `read_dir_names`) that return empty/fallback values instead of erroring. This is what lets one binary run unchanged across bare-metal servers, VMs, and containers:

- **No thermal sensors / no battery** → the Thermal view shows the subsystems that *do* exist and omits the rest.
- **No `cpufreq`** → frequency is simply not displayed; utilization still works.
- **No physical disks (container)** → the Disk view renders its empty state.
- **Single-core / no network interface** → charts and tables render cleanly with no `NaN` or layout breakage.

These scenarios are exercised directly in the CDP harness by injecting degenerate snapshots.

## Validation

UI correctness is verified automatically with a zero-dependency Chrome DevTools Protocol harness (`docs/cdp_validate.mjs`, using the shared `docs/cdp_util.mjs`). It loads all 9 views across 4 viewports (desktop → mobile), exercises interactions (header sorting, row-click drawers, command palette, settings), and asserts:

```
0 console errors · 0 layout overflow · all views mount with live data
```

The harness launches headless Chrome in its own process group and reaps it reliably on every exit path, so it never leaves orphaned renderers behind.

```bash
# Requires a chrome/chromium binary; server must be running on :8099
node docs/cdp_validate.mjs
```

Rust unit tests (formatters, ring buffer, the alert engine's debounce logic) run with:

```bash
cargo test
```

## Project stats

- **~15.5k LOC** — Rust ~4.0k, JavaScript ~8.3k, CSS ~3.1k
- **~2.8 MB** self-contained release binary
- **18** Rust unit tests, plus the full CDP UI matrix
- **Zero runtime dependencies**

## License

See the repository for license details.
