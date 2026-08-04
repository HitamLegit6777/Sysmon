#!/usr/bin/env bash
# =============================================================================
# SysMon installer — hub + agent + cloudflared (free quick tunnel)
#
# Installs everything needed to run SysMon multi-server monitoring:
#   1. cloudflared        (free Cloudflare quick tunnel, if missing)
#   2. sysmon (hub)       binary -> /usr/local/bin/sysmon
#   3. agent-monitor      binary -> /usr/local/bin/agent-monitor
#   4. systemd units      sysmon.service / agent-monitor.service (if systemd)
#   5. startup banner     how to launch + get the tunnel URL
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/HitamLegit6777/Sysmon/main/install.sh | sudo bash
#   # or:  sudo bash install.sh
#
# Environment overrides:
#   SYSMON_MODE=hub|agent|both   (default: both)
#   SYSMON_HUB_URL=wss://...     (agent mode: hub endpoint; default: asks)
#   SYSMON_AGENT_ID=name         (agent mode; default: hostname)
#   SYSMON_TOKEN=secret          (shared agent token; default: asks, or auto)
#   SYSMON_PORT=8088             (hub listen port)
#   SKIP_SYSTEMD=1               (do not install systemd units)
# =============================================================================
set -euo pipefail

GITHUB_REPO="HitamLegit6777/Sysmon"
GITHUB_BASE="https://github.com/${GITHUB_REPO}/releases/latest/download"
VERSION="1.0.0"
INSTALL_DIR="/usr/local/bin"
SYSTEMD_DIR="/etc/systemd/system"
CURL="curl -fsSL --retry 3 --connect-timeout 15"

# ----------------------------- helpers --------------------------------------
say()  { printf '\033[1;36m[sysmon]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[sysmon]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[sysmon] ERROR: %s\033[0m\n' "$*" >&2; exit 1; }

need_root() {
  if [[ $EUID -ne 0 ]]; then
    die "run as root: sudo bash install.sh"
  fi
}

detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    linux) ;;
    darwin) os="darwin" ;;
    *) die "unsupported OS: $os (SysMon targets Linux; macOS install is best-effort)" ;;
  esac
  case "$arch" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) die "unsupported architecture: $arch" ;;
  esac
  echo "${os}_${arch}"
}

# ----------------------------- cloudflared ----------------------------------
install_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then
    say "cloudflared already installed: $(cloudflared --version 2>/dev/null | head -1 || echo 'ok')"
    return 0
  fi
  say "cloudflared not found — installing the free Cloudflare quick-tunnel client..."
  local os
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$os" in
    linux)
      # Official package repo (Debian/Ubuntu, RHEL, Fedora) or raw binary.
      if command -v apt-get >/dev/null 2>&1; then
        say "detected apt (Debian/Ubuntu); using Cloudflare's official repo"
        mkdir -p --mode=0755 /usr/share/keyrings
        $CURL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
        echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs 2>/dev/null || echo 'bookworm') main" \
          > /etc/apt/sources.list.d/cloudflared.list
        apt-get update -qq >/dev/null 2>&1 || true
        apt-get install -y -qq cloudflared >/dev/null 2>&1 \
          || die "apt install cloudflared failed"
      elif command -v dnf >/dev/null 2>&1; then
        say "detected dnf (RHEL/Fedora); using Cloudflare's official repo"
        $CURL https://pkg.cloudflare.com/cloudflared-ascii.sig -o /tmp/cloudflared-repo.asc
        rpm --import /tmp/cloudflared-repo.asc
        cat > /etc/yum.repos.d/cloudflared.repo <<'EOF'
[cloudflared]
name=cloudflared
baseurl=https://pkg.cloudflare.com/cloudflared-rpm
enabled=1
gpgcheck=1
repo_gpgcheck=0
gpgkey=https://pkg.cloudflare.com/cloudflared-ascii.sig
EOF
        dnf install -y -q cloudflared >/dev/null 2>&1 \
          || die "dnf install cloudflared failed"
      else
        say "no apt/dnf; downloading cloudflared binary"
        install_cloudflared_binary
      fi
      ;;
    darwin)
      if command -v brew >/dev/null 2>&1; then
        brew install cloudflared >/dev/null 2>&1 || die "brew install cloudflared failed"
      else
        install_cloudflared_binary
      fi
      ;;
  esac
  command -v cloudflared >/dev/null 2>&1 || die "cloudflared install failed"
  say "cloudflared ready: $(cloudflared --version 2>/dev/null | head -1)"
}

install_cloudflared_binary() {
  local os arch url
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  [[ "$arch" == "x86_64" ]] && arch="amd64"
  url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${os}-${arch}"
  $CURL "$url" -o /tmp/cloudflared-bin
  install -m 0755 /tmp/cloudflared-bin /usr/local/bin/cloudflared
  rm -f /tmp/cloudflared-bin
}

# ----------------------------- sysmon binaries ------------------------------
install_sysmon_binaries() {
  local platform="$1"
  say "downloading SysMon ${VERSION} for ${platform} ..."
  $CURL "${GITHUB_BASE}/sysmon-${platform}.tar.gz" -o /tmp/sysmon.tar.gz \
    || die "download failed (${GITHUB_BASE}/sysmon-${platform}.tar.gz). Build locally instead: cargo build --release"
  local tmp
  tmp="$(mktemp -d)"
  tar -xzf /tmp/sysmon.tar.gz -C "$tmp"
  install -m 0755 "$tmp/sysmon"        "$INSTALL_DIR/sysmon"
  install -m 0755 "$tmp/agent-monitor" "$INSTALL_DIR/agent-monitor"
  rm -rf "$tmp" /tmp/sysmon.tar.gz
  say "installed: ${INSTALL_DIR}/sysmon, ${INSTALL_DIR}/agent-monitor"
}

# ----------------------------- systemd --------------------------------------
install_systemd() {
  [[ -d /run/systemd/system ]] || { say "no systemd detected; skipping service units"; return 0; }
  [[ "${SKIP_SYSTEMD:-0}" == "1" ]] && { say "SKIP_SYSTEMD=1; skipping units"; return 0; }

  if [[ "$MODE" == "hub" || "$MODE" == "both" ]]; then
    cat > "${SYSTEMD_DIR}/sysmon.service" <<EOF
[Unit]
Description=SysMon hub (multi-server monitoring dashboard)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${INSTALL_DIR}/sysmon --port ${PORT}
Environment=SYSMON_AGENT_TOKEN=${TOKEN}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl enable --now sysmon.service >/dev/null 2>&1 || warn "could not start sysmon.service (check: systemctl status sysmon)"
    say "hub service installed: systemctl status sysmon"
  fi

  if [[ "$MODE" == "agent" || "$MODE" == "both" ]]; then
    [[ -n "${HUB_URL:-}" ]] || HUB_URL="$(ask_hub_url)"
    [[ -n "${AGENT_ID:-}" ]] || AGENT_ID="$(hostname)"
    cat > "${SYSTEMD_DIR}/agent-monitor.service" <<EOF
[Unit]
Description=SysMon agent (telemetry for ${AGENT_ID})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${INSTALL_DIR}/agent-monitor --hub ${HUB_URL} --token ${TOKEN} --id ${AGENT_ID}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl enable --now agent-monitor.service >/dev/null 2>&1 || warn "could not start agent-monitor.service (check: systemctl status agent-monitor)"
    say "agent service installed: systemctl status agent-monitor"
  fi
}

ask_hub_url() {
  printf '\033[1;36m[sysmon]\033[0m Hub WebSocket URL (e.g. wss://xxx.trycloudflare.com/agent/ws): '
  read -r -p "" url
  [[ -n "$url" ]] || die "hub URL is required for agent mode"
  echo "$url"
}

ask_token() {
  if [[ -n "${SYSMON_TOKEN:-}" ]]; then
    echo "$SYSMON_TOKEN"
    return 0
  fi
  # Generate a strong random token unless the user wants to type one.
  local gen
  gen="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
  printf '\033[1;36m[sysmon]\033[0m Agent token (Enter = auto-generate: %s): ' "$gen"
  read -r -p "" t
  [[ -n "$t" ]] && echo "$t" || echo "$gen"
}

print_banner() {
  echo
  echo "  ┌────────────────────────────────────────────────────────────┐"
  echo "  │  SysMon installed ✓                                        │"
  if [[ "$MODE" == "hub" || "$MODE" == "both" ]]; then
    echo "  │  Hub:   ${INSTALL_DIR}/sysmon --port ${PORT}                  │"
    echo "  │  Token: ${TOKEN}                                    │"
    echo "  │  Run it and look for the QUICK TUNNEL banner for the URL │"
    echo "  │  Agents connect to:  wss://<tunnel>/agent/ws              │"
  fi
  if [[ "$MODE" == "agent" || "$MODE" == "both" ]]; then
    echo "  │  Agent: ${INSTALL_DIR}/agent-monitor --hub <URL> --token … │"
  fi
  echo "  └────────────────────────────────────────────────────────────┘"
  echo
}

# ----------------------------- main ----------------------------------------
need_root
PLATFORM="$(detect_platform)"
MODE="${SYSMON_MODE:-both}"   # hub | agent | both
PORT="${SYSMON_PORT:-8088}"
TOKEN="${SYSMON_TOKEN:-}"
HUB_URL="${SYSMON_HUB_URL:-}"
AGENT_ID="${SYSMON_AGENT_ID:-}"

say "SysMon installer v${VERSION} — mode=${MODE}, platform=${PLATFORM}"

install_cloudflared
install_sysmon_binaries "$PLATFORM"

if [[ -z "$TOKEN" && ( "$MODE" == "hub" || "$MODE" == "both" ) ]]; then
  TOKEN="$(ask_token)"
fi
[[ -z "$TOKEN" ]] && die "a token is required for the hub (SYSMON_TOKEN or interactive)"

install_systemd

print_banner
