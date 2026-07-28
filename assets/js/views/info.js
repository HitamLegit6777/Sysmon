/**
 * info.js
 * -------
 * The system info view: host identity, kernel, OS, CPU model, memory, boot
 * time and uptime, virtualization, plus a small settings panel for theme and
 * accent color, and live connection diagnostics.
 */

import {
  h,
  icon,
  fmtBytes,
  fmtUptime,
  fmtDateTime,
  fmtNum,
  cssVar,
} from "../util.js";
import store from "../store.js";
import { card, kvList, updateKvList } from "../components/card.js";

const ACCENTS = [
  ["default", "#5b8cff"],
  ["violet", "#b388ff"],
  ["emerald", "#3ad29f"],
  ["amber", "#f5b342"],
  ["rose", "#ff5c7a"],
];

export class InfoView {
  constructor() {
    this._unsubs = [];
    this._diagTimer = null;
  }

  mount(container) {
    const view = h("div.view");

    this.hostInfo = kvList([
      ["Hostname", "…"],
      ["OS", "…"],
      ["Kernel", "…"],
      ["Architecture", "…"],
      ["Virtualization", "…"],
      ["Container", "…"],
      ["Timezone", "…"],
    ]);
    const hostCard = card({ title: "Host", iconName: "server" }, [this.hostInfo]);

    this.hwInfo = kvList([
      ["CPU model", "…"],
      ["Physical cores", "…"],
      ["Logical cores", "…"],
      ["Base clock", "…"],
      ["Cache", "…"],
      ["Total memory", "…"],
    ]);
    const hwCard = card({ title: "Hardware", iconName: "chip" }, [this.hwInfo]);

    this.timeInfo = kvList([
      ["Boot time", "…"],
      ["Uptime", "…"],
      ["Processes", "…"],
      ["Last PID", "…"],
    ]);
    const timeCard = card({ title: "Runtime", iconName: "clock" }, [this.timeInfo]);

    // Settings.
    const themeToggle = this._buildThemeSetting();
    const accentPicker = this._buildAccentSetting();
    const settingsCard = card({ title: "Appearance", iconName: "settings" }, [
      h("div.row-between", { style: { padding: "8px 0" } }, [
        h("span", { text: "Theme" }),
        themeToggle,
      ]),
      h("div.row-between", { style: { padding: "8px 0" } }, [
        h("span", { text: "Accent" }),
        accentPicker,
      ]),
    ]);

    // Diagnostics.
    this.diagInfo = kvList([
      ["Connection", "…"],
      ["SysMon version", "…"],
      ["Server PID", "…"],
      ["WS messages", "0"],
      ["Dropped frames", "0"],
    ]);
    const diagCard = card({ title: "Diagnostics", iconName: "activity" }, [this.diagInfo]);

    view.append(
      h("div.grid.grid-2.section", null, [hostCard, hwCard]),
      h("div.grid.grid-2.section", null, [timeCard, settingsCard]),
      h("div.section", null, diagCard)
    );
    container.appendChild(view);

    this._unsubs.push(store.on("host", () => this._refresh()));
    this._unsubs.push(store.on("snapshot", () => this._refreshRuntime()));
    this._unsubs.push(store.on("bootstrap", () => this._refresh()));
    this._refresh();

    this._diagTimer = setInterval(() => this._refreshDiag(), 1000);
  }

  _buildThemeSetting() {
    const sw = h("div.switch" + (document.documentElement.dataset.theme === "dark" ? ".on" : ""));
    sw.addEventListener("click", () => {
      const cur = document.documentElement.dataset.theme || "dark";
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("sysmon.theme", next);
      sw.classList.toggle("on", next === "dark");
    });
    return sw;
  }

  _buildAccentSetting() {
    const row = h("div.row.gap-2");
    for (const [name, color] of ACCENTS) {
      const dot = h("button", {
        style: {
          width: "24px",
          height: "24px",
          borderRadius: "50%",
          background: color,
          border: "2px solid transparent",
          cursor: "pointer",
        },
        title: name,
        onClick: () => {
          if (name === "default") delete document.documentElement.dataset.accent;
          else document.documentElement.dataset.accent = name;
          localStorage.setItem("sysmon.accent", name);
          for (const b of row.children) b.style.borderColor = "transparent";
          dot.style.borderColor = "var(--text-0)";
        },
      });
      const current = localStorage.getItem("sysmon.accent") || "default";
      if (name === current) dot.style.borderColor = "var(--text-0)";
      row.appendChild(dot);
    }
    return row;
  }

  _refresh() {
    const host = store.get().host;
    if (!host) return;
    updateKvList(this.hostInfo, [
      host.hostname || "unknown",
      host.osPretty || `${host.osName} ${host.osVersion}`,
      `${host.kernel} ${host.kernelVersion}`,
      host.architecture,
      host.virtualization || "unknown",
      host.container || "none",
      host.timezone || "UTC",
    ]);
    updateKvList(this.hwInfo, [
      host.cpuModel || "unknown",
      String(host.cpuCoresPhysical || "?"),
      String(host.cpuCoresLogical || "?"),
      host.cpuMhzBase ? Math.round(host.cpuMhzBase) + " MHz" : "n/a",
      host.cpuCacheKb ? Math.round(host.cpuCacheKb / 1024) + " MB" : "n/a",
      fmtBytes(host.totalMemory),
    ]);
    this._refreshRuntime();
  }

  _refreshRuntime() {
    const host = store.get().host;
    const snap = store.get().snapshot;
    if (host && host.bootTime) {
      updateKvList(this.timeInfo, [
        fmtDateTime(host.bootTime * 1000),
        snap ? fmtUptime(snap.load.uptimeSeconds) : "…",
        snap ? fmtNum(snap.load.totalProcs) : "…",
        snap ? String(snap.load.lastPid) : "…",
      ]);
    }
  }

  _refreshDiag() {
    const state = store.get();
    const host = state.host;
    updateKvList(this.diagInfo, [
      state.connected ? "Live" : state.connecting ? "Connecting" : "Offline",
      host ? host.sysmonVersion || "?" : "?",
      host ? String(host.sysmonPid || "?") : "?",
      fmtNum(state.stats.wsMessages),
      fmtNum(state.stats.droppedFrames),
    ]);
  }

  update() {}

  unmount() {
    for (const u of this._unsubs) u();
    this._unsubs = [];
    if (this._diagTimer) clearInterval(this._diagTimer);
  }
}

export default InfoView;
