/**
 * topbar.js
 * ---------
 * The top bar: a mobile menu toggle, the current page title with a breadcrumb,
 * a live connection status pill, a clock, quick metric chips, and action
 * buttons (pause streaming, refresh, theme toggle). Reacts to store updates.
 */

import { h, icon, fmtClock, fmtPct, fmtRate } from "../util.js";
import store from "../store.js";
import router from "../router.js";

const TITLES = {
  overview: ["Overview", "Live system dashboard"],
  cpu: ["CPU", "Processor utilization and per-core load"],
  memory: ["Memory", "RAM, swap, and cache breakdown"],
  network: ["Network", "Interface throughput and sockets"],
  disk: ["Disk", "Filesystems and block device I/O"],
  processes: ["Processes", "Live process table"],
  thermal: ["Thermal", "Temperatures, cooling, and power"],
  alerts: ["Alerts", "Threshold rules and recent events"],
  info: ["System Info", "Host, kernel, and hardware details"],
};

export function buildTopbar(options = {}) {
  const titleH1 = h("h1", { text: "Overview" });
  const crumb = h("div.crumb", { text: "" });

  const statusDot = h("span.status-dot.connecting");
  const statusText = h("span.status-text", { text: "Connecting" });
  const statusPill = h("div.topbar-status", null, [statusDot, statusText]);

  const clock = h("div.clock", { text: fmtClock() });

  // Quick chips summarizing the most important live values.
  const cpuChip = chip("cpu", "CPU", "0%");
  const memChip = chip("memory", "MEM", "0%");
  const netChip = chip("network", "NET", "0/s");

  const pauseBtn = h("button.icon-btn", {
    title: "Pause live updates",
    html: icon("pause", 20),
    onClick: () => togglePause(pauseBtn),
  });

  const themeBtn = h("button.icon-btn", {
    title: "Toggle theme",
    html: icon(
      document.documentElement.dataset.theme === "light" ? "moon" : "sun",
      20
    ),
    onClick: () => {
      if (options.onToggleTheme) options.onToggleTheme();
      themeBtn.innerHTML = icon(
        document.documentElement.dataset.theme === "light" ? "moon" : "sun",
        20
      );
    },
  });

  const menuBtn = h("button.icon-btn.menu-toggle", {
    title: "Menu",
    html: icon("menu", 20),
    onClick: () => options.onToggleMenu && options.onToggleMenu(),
  });

  const settingsBtn = h("button.icon-btn", {
    title: "Settings",
    html: icon("settings", 20),
    onClick: () => options.onOpenSettings && options.onOpenSettings(),
  });

  const paletteBtn = h("button.icon-btn.palette-btn", {
    title: "Command palette (Ctrl+K)",
    html: icon("search", 20),
    onClick: () => options.onOpenPalette && options.onOpenPalette(),
  });

  const el = h("header.topbar", null, [
    menuBtn,
    h("div.page-title", null, [titleH1, crumb]),
    h("div.spacer"),
    h("div.row.gap-2.hide-mobile", null, [cpuChip.el, memChip.el, netChip.el]),
    statusPill,
    clock,
    h("div.row.gap-2", null, [paletteBtn, pauseBtn, themeBtn, settingsBtn]),
  ]);

  // Allow external (keyboard/command) pause toggles to sync this button.
  window.addEventListener("sysmon:toggle-pause", () => togglePause(pauseBtn));

  // Title updates on route change.
  const setTitle = (path) => {
    const [t, sub] = TITLES[path] || [path, ""];
    titleH1.textContent = t;
    crumb.textContent = sub;
    document.title = `SysMon · ${t}`;
  };
  router.onChange(setTitle);
  setTitle(router.currentPath());

  // Connection status.
  store.on("connection", ({ connected, connecting }) => {
    statusDot.className =
      "status-dot " +
      (connected ? "online" : connecting ? "connecting" : "offline");
    statusText.textContent = connected
      ? "Live"
      : connecting
      ? "Connecting"
      : "Offline";
  });

  // Live chips + clock.
  store.on("snapshot", (snap) => {
    if (!snap) return;
    cpuChip.set(fmtPct(snap.cpu.usage, 0));
    memChip.set(fmtPct(snap.memory.usedPercent, 0));
    const net = (snap.network.totalRxBytesPerSec || 0) +
      (snap.network.totalTxBytesPerSec || 0);
    netChip.set(fmtRate(net, 0));
  });

  setInterval(() => {
    clock.textContent = fmtClock();
  }, 1000);

  return el;
}

function chip(iconName, label, initial) {
  const val = h("span.v", { text: initial });
  const el = h("div.chip", null, [
    h("span.icon", { html: icon(iconName, 14), style: { display: "inline-flex" } }),
    h("span.k", { text: label }),
    val,
  ]);
  return {
    el,
    set(v) {
      if (val.textContent !== v) val.textContent = v;
    },
  };
}

let paused = false;
function togglePause(btn) {
  paused = !paused;
  btn.innerHTML = icon(paused ? "play" : "pause", 20);
  btn.title = paused ? "Resume live updates" : "Pause live updates";
  btn.classList.toggle("active", paused);
  // Signal pause via a custom event the app can consume.
  window.dispatchEvent(new CustomEvent("sysmon:pause", { detail: { paused } }));
}

export function isPaused() {
  return paused;
}

export default buildTopbar;
