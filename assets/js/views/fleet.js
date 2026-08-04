/**
 * fleet.js
 * --------
 * The fleet view: one card per monitored server (the hub host plus every
 * connected agent), with live status, CPU/mem/load/network/disk/temp, alert
 * counts, latency, and last-seen. Clicking a card selects that server and
 * jumps to the overview so all detail views are re-targeted. A summary strip
 * shows fleet aggregates (agents up, average CPU, total active alerts).
 *
 * Data comes from the hub's 1s `fleet` heartbeat — no per-server streaming
 * needed to render this page.
 */

import { h, icon, fmtPct, fmtBytes, fmtRate, fmtUptime, fmtNum, cssVar, usageColor, timeAgo } from "../util.js";
import store from "../store.js";
import ws from "../ws.js";
import router from "../router.js";
import { card } from "../components/card.js";

export class FleetView {
  constructor() {
    this._unsubs = [];
    this._cards = new Map();
  }

  mount(container) {
    const view = h("div.view");

    this.summary = {
      total: h("span.cell-strong", { text: "0" }),
      up: h("span.cell-strong", { text: "0" }),
      avgCpu: h("span.cell-strong", { text: "0%" }),
      avgMem: h("span.cell-strong", { text: "0%" }),
      alerts: h("span.cell-strong", { text: "0" }),
    };
    const strip = h("div.card.row.gap-4.wrap", { style: { padding: "14px 20px" } }, [
      statItem("server", "Servers", this.summary.total),
      statItem("activity", "Online", this.summary.up, cssVar("--success")),
      statItem("cpu", "Avg CPU", this.summary.avgCpu),
      statItem("memory", "Avg Mem", this.summary.avgMem),
      statItem("alerts", "Active Alerts", this.summary.alerts, cssVar("--danger")),
    ]);

    this.grid = h("div.grid.grid-auto", { style: { marginTop: "16px" } });
    const fleetCard = card({ title: "Servers", iconName: "server" }, [this.grid]);

    view.append(strip, h("div.section", null, fleetCard));
    container.appendChild(view);

    this._unsubs.push(store.on("fleet", () => this._render()));
    this._unsubs.push(store.on("bootstrap", () => this._render()));
    this._render();
  }

  _render() {
    const fleet = store.get().fleet || [];
    // Include the hub host itself as the first card.
    const all = [{ id: "self", name: store.get().activeServerName || "this host", hostname: store.get().host?.hostname || "this host", connected: true }]
      .concat(fleet.map((f) => ({ ...f })));

    // Summary strip.
    const up = all.filter((s) => s.connected).length;
    const withData = fleet.filter((f) => f.connected && f.cpuUsage > 0);
    const avgCpu = withData.length
      ? Math.round(withData.reduce((a, f) => a + f.cpuUsage, 0) / withData.length)
      : 0;
    const avgMem = withData.length
      ? Math.round(withData.reduce((a, f) => a + f.memUsedPercent, 0) / withData.length)
      : 0;
    const alerts = fleet.reduce((a, f) => a + (f.alertsWarning || 0) + (f.alertsCritical || 0), 0);
    this.summary.total.textContent = String(all.length);
    this.summary.up.textContent = String(up);
    this.summary.avgCpu.textContent = fmtPct(avgCpu, 0);
    this.summary.avgMem.textContent = fmtPct(avgMem, 0);
    this.summary.alerts.textContent = String(alerts);

    // Reconcile cards by id (cheap: fleet is small).
    const seen = new Set();
    const frag = document.createDocumentFragment();
    for (const s of all) {
      seen.add(s.id);
      let el = this._cards.get(s.id);
      if (!el) {
        el = this._buildCard(s);
        this._cards.set(s.id, el);
      }
      this._updateCard(el, s);
      frag.appendChild(el);
    }
    for (const [id, el] of this._cards) {
      if (!seen.has(id)) {
        el.remove();
        this._cards.delete(id);
      }
    }
    this.grid.replaceChildren(frag);
  }

  _buildCard(s) {
    const el = h(
      "div.card.interactive.fleet-card" + (s.id === store.get().activeServer ? ".is-active" : ""),
      { onClick: () => this._select(s.id) }
    );
    // Stored per-card refs for fast updates.
    const refs = {
      status: h("span.status-dot" + (s.connected ? ".online" : ".offline")),
      name: h("span.cell-strong", { text: "" }),
      host: h("span.text-3.truncate", { text: "" }),
      cpu: h("span.mono", { text: "" }),
      mem: h("span.mono", { text: "" }),
      load: h("span.mono", { text: "" }),
      net: h("span.mono", { text: "" }),
      temp: h("span.mono", { text: "" }),
      disk: h("span.mono", { text: "" }),
      alerts: h("span.badge", { text: "0" }),
      latency: h("span.text-3", { text: "" }),
      last: h("span.text-3", { text: "" }),
    };
    el.append(
      h("div.row-between", null, [
        h("div.row.gap-2", { style: { minWidth: 0 } }, [
          refs.status,
          h("div.col", { style: { minWidth: 0 } }, [
            refs.name,
            refs.host,
          ]),
        ]),
        refs.alerts,
      ]),
      h("div.fleet-grid", { style: { marginTop: "12px" } }, [
        metric("CPU", refs.cpu),
        metric("Mem", refs.mem),
        metric("Load", refs.load),
        metric("Net", refs.net),
        metric("Temp", refs.temp),
        metric("Disk", refs.disk),
      ]),
      h("div.row-between.text-3", { style: { marginTop: "10px", fontSize: "11px" } }, [
        refs.latency,
        refs.last,
      ])
    );
    el._refs = refs;
    return el;
  }

  _updateCard(el, s) {
    const r = el._refs;
    el.classList.toggle("is-active", s.id === store.get().activeServer);
    r.status.className = "status-dot " + (s.connected ? "online" : "offline");
    r.name.textContent = s.name || s.hostname || s.id;
    r.host.textContent = s.hostname || (s.id === "self" ? "this host" : s.id);
    r.cpu.textContent = fmtPct(s.cpuUsage || 0, 0);
    r.cpu.style.color = usageColor(s.cpuUsage || 0);
    r.mem.textContent = fmtPct(s.memUsedPercent || 0, 0);
    r.load.textContent = (s.load1 || 0).toFixed(1);
    r.net.textContent = fmtRate((s.netRxBps || 0) + (s.netTxBps || 0), 0);
    r.temp.textContent = s.maxTemp ? Math.round(s.maxTemp) + "°C" : "—";
    r.disk.textContent = fmtPct(s.diskUsedPercent || 0, 0);
    const nAlerts = (s.alertsWarning || 0) + (s.alertsCritical || 0);
    r.alerts.textContent = String(nAlerts);
    r.alerts.className = "badge " + (nAlerts ? (s.alertsCritical ? "danger" : "warning") : "success");
    if (s.id !== "self") {
      r.latency.textContent = s.connected ? (s.latencyMs != null ? s.latencyMs + "ms" : "…") : "";
      r.last.textContent = s.connected ? "live" : "offline " + (s.lastSeenMs ? timeAgo(s.lastSeenMs) : "—");
    } else {
      r.latency.textContent = "local";
      r.last.textContent = "hub host";
    }
  }

  _select(id) {
    ws.selectServer(id);
    router.navigate("overview");
  }

  update() {}

  unmount() {
    for (const u of this._unsubs) u();
    this._unsubs = [];
    this._cards.clear();
  }
}

function statItem(iconName, label, valueEl, color) {
  return h("div.row.gap-2", null, [
    h("span.stat-icon", {
      html: icon(iconName, 16),
      style: { width: "32px", height: "32px", color: color || cssVar("--accent") },
    }),
    h("div.col", null, [
      h("span.stat-label", { text: label, style: { fontSize: "10px" } }),
      valueEl,
    ]),
  ]);
}

function metric(label, valueEl) {
  return h("div.col", { style: { gap: "2px" } }, [
    h("span.stat-label", { text: label, style: { fontSize: "10px" } }),
    valueEl,
  ]);
}

export default FleetView;
