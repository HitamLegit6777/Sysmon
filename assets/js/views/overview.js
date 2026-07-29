/**
 * overview.js
 * -----------
 * The flagship dashboard. A grid of KPI stat tiles (CPU, memory, load, network,
 * disk, temperature) each with a live sparkline, followed by a large combined
 * performance chart, a per-core mini grid, filesystem meters, and a compact
 * top-processes preview. Everything updates live from the store.
 */

import {
  h,
  icon,
  fmtPct,
  fmtBytes,
  fmtRate,
  fmtUptime,
  fmtNum,
  splitBytes,
  cssVar,
  usageColor,
  usageClass,
  clamp,
} from "../util.js";
import store from "../store.js";
import { statTile, card, meter, badge } from "../components/card.js";
import { LineChart } from "../charts/linechart.js";
import { Bars } from "../charts/bars.js";
import { AreaChart } from "../charts/areachart.js";

export class OverviewView {
  constructor() {
    this.tiles = {};
    this.meters = new Map();
    this.charts = {};
    this.coreBars = null;
    this._unsubs = [];
  }

  mount(container) {
    const view = h("div.view");

    // --- KPI tiles row ---
    this.tiles.cpu = statTile({
      label: "CPU Usage",
      iconName: "cpu",
      iconClass: "cpu",
      unit: "%",
      sparkColor: cssVar("--series-cpu"),
      sparkMin: 0,
      sparkMax: 100,
    });
    this.tiles.mem = statTile({
      label: "Memory",
      iconName: "memory",
      iconClass: "mem",
      unit: "%",
      sparkColor: cssVar("--series-mem"),
      sparkMin: 0,
      sparkMax: 100,
    });
    this.tiles.load = statTile({
      label: "Load (1m)",
      iconName: "activity",
      iconClass: "load",
      sparkColor: cssVar("--series-load"),
    });
    this.tiles.net = statTile({
      label: "Network",
      iconName: "network",
      iconClass: "net",
      sparkColor: cssVar("--series-net-rx"),
    });
    this.tiles.disk = statTile({
      label: "Disk I/O",
      iconName: "disk",
      iconClass: "disk",
      sparkColor: cssVar("--series-disk-r"),
    });
    this.tiles.temp = statTile({
      label: "Temperature",
      iconName: "thermal",
      iconClass: "temp",
      unit: "°C",
      sparkColor: cssVar("--series-temp"),
    });

    const tilesRow = h("div.grid.grid-4.grid-5", null, [
      this.tiles.cpu.el,
      this.tiles.mem.el,
      this.tiles.load.el,
      this.tiles.net.el,
      this.tiles.disk.el,
      this.tiles.temp.el,
    ]);

    // --- Main performance chart ---
    const chartHost = h("div.chart.chart-xl");
    const perfCard = card(
      {
        title: "Performance",
        iconName: "activity",
        accent: true,
        actions: [this._buildRangeButtons()],
      },
      [chartHost, this._buildLegend()]
    );

    // --- Per-core grid ---
    const coreHost = h("div.chart.chart-md");
    const coreCard = card(
      { title: "Per-Core Utilization", iconName: "cpu" },
      [coreHost]
    );

    // --- Filesystem meters ---
    this.fsWrap = h("div.col.gap-4");
    const fsCard = card(
      { title: "Filesystems", iconName: "disk" },
      [this.fsWrap]
    );

    // --- Memory breakdown meters ---
    this.memWrap = h("div.col.gap-4");
    const memCard = card(
      { title: "Memory Breakdown", iconName: "memory" },
      [this.memWrap]
    );

    // --- Top processes preview ---
    this.procWrap = h("div.col.gap-2");
    const procCard = card(
      {
        title: "Top Processes",
        iconName: "processes",
        actions: [
          h("button.btn.sm.ghost", {
            html: icon("chevron", 14),
            title: "View all",
            onClick: () => (location.hash = "#/processes"),
          }),
        ],
      },
      [this.procWrap]
    );

    // --- System summary strip ---
    this.summaryStrip = this._buildSummaryStrip();

    // --- Network throughput (stacked area) ---
    this.netAreaHost = h("div.chart.chart-md", { style: { height: "160px" } });
    const netAreaCard = card(
      { title: "Network Throughput", iconName: "network" },
      [this.netAreaHost]
    );

    view.append(
      this.summaryStrip.el,
      h("div.section", null, tilesRow),
      h("div.grid.grid-3.section", null, [
        h("div.col-span-2", { style: { gridColumn: "span 2" } }, perfCard),
        coreCard,
      ]),
      h("div.section", null, netAreaCard),
      h("div.grid.grid-3.section", null, [fsCard, memCard, procCard])
    );

    container.appendChild(view);

    // Build charts after layout.
    requestAnimationFrame(() => {
      this.charts.perf = new LineChart(chartHost, {
        yMin: 0,
        yMax: 100,
        ySuffix: "%",
        yFormat: (v) => String(Math.round(v)),
        tooltipExtra: (i) => {
          const t = store.get().history.temp.slice(-600)[i];
          if (t == null || t <= 0) return "";
          return (
            `<div class="tt-row"><span class="tt-dot" style="background:${cssVar("--series-temp")}"></span>` +
            `<span class="tt-label">Temp</span><span class="tt-val">${t.toFixed(1)}\u00b0C</span></div>`
          );
        },
      });
      this.coreBars = new Bars(coreHost, {
        orientation: "vertical",
        max: 100,
        autoColor: true,
        gap: 3,
      });
      this.netArea = new AreaChart(this.netAreaHost, {
        stacked: true,
        maxPoints: 120,
        series: [
          { key: "rx", label: "Download", color: cssVar("--series-net-rx") },
          { key: "tx", label: "Upload", color: cssVar("--series-net-tx") },
        ],
      });
      this._seedCharts();
      this._refresh(store.get());
    });

    // Subscribe to live updates.
    this._unsubs.push(store.on("snapshot", () => this._refresh(store.get())));
    this._unsubs.push(
      store.on("historyPoint", () => this._updatePerfChart())
    );
    this._unsubs.push(store.on("processes", () => this._updateProcesses()));

    this._refresh(store.get());
    this._updateProcesses();
  }

  _buildRangeButtons() {
    const ranges = [
      { label: "1m", points: 60 },
      { label: "5m", points: 300 },
      { label: "15m", points: 900 },
    ];
    this.range = 300;
    const group = h("div.btn-group");
    ranges.forEach((r) => {
      const btn = h("button.btn.sm" + (r.points === 300 ? ".active" : ""), {
        text: r.label,
        onClick: () => {
          this.range = r.points;
          for (const b of group.children) b.classList.remove("active");
          btn.classList.add("active");
          this._updatePerfChart();
        },
      });
      group.appendChild(btn);
    });
    return group;
  }

  _buildLegend() {
    const series = [
      { key: "cpu", label: "CPU", color: cssVar("--series-cpu") },
      { key: "mem", label: "Memory", color: cssVar("--series-mem") },
    ];
    this.legendValues = {};
    const legend = h("div.chart-legend");
    series.forEach((s) => {
      const valEl = h("span.lv", { text: "0%" });
      this.legendValues[s.key] = valEl;
      legend.appendChild(
        h(
          "div.legend-item",
          {
            onClick: () => this.charts.perf && this.charts.perf.toggleSeries(s.key),
          },
          [
            h("span.legend-swatch", { style: { background: s.color } }),
            h("span", { text: s.label }),
            valEl,
          ]
        )
      );
    });
    return legend;
  }

  _buildSummaryStrip() {
    const items = {
      host: h("span.v", { text: "…" }),
      uptime: h("span.v", { text: "…" }),
      procs: h("span.v", { text: "…" }),
      alerts: h("span.v", { text: "0" }),
    };
    const el = h("div.card.row-between", { style: { padding: "14px 20px" } }, [
      h("div.row.gap-4.wrap", null, [
        summaryItem("server", "Host", items.host),
        summaryItem("clock", "Uptime", items.uptime),
        summaryItem("processes", "Processes", items.procs),
        summaryItem("alerts", "Active Alerts", items.alerts),
      ]),
      h("div.row.gap-2", null, [
        h("span.badge.success", null, [
          h("span.dot"),
          h("span", { text: "Monitoring" }),
        ]),
      ]),
    ]);
    return { el, items };
  }

  _seedCharts() {
    const hist = store.get().history;
    if (hist && hist.t && hist.t.length) {
      this._updatePerfChart();
    }
    // Seed sparklines.
    for (const [key, mapKey] of [
      ["cpu", "cpu"],
      ["mem", "mem"],
      ["load", "load1"],
    ]) {
      const arr = store.get().history[mapKey];
      if (arr && this.tiles[key]) this.tiles[key].setSpark(arr.slice(-60));
    }
  }

  _updatePerfChart() {
    if (!this.charts.perf) return;
    const hist = store.get().history;
    const n = this.range || 300;
    const slice = (arr) => (arr.length > n ? arr.slice(arr.length - n) : arr.slice());
    const ts = slice(hist.t);
    const series = [
      {
        key: "cpu",
        label: "CPU",
        color: cssVar("--series-cpu"),
        values: slice(hist.cpu),
        fill: true,
      },
      {
        key: "mem",
        label: "Memory",
        color: cssVar("--series-mem"),
        values: slice(hist.mem),
        fill: true,
      },
    ];
    this.charts.perf.setData(ts, series);

    if (this.netArea) {
      const rx = slice(hist.netRx);
      const tx = slice(hist.netTx);
      this.netArea.setData(
        ts.map((t, i) => ({ t, values: { rx: rx[i] || 0, tx: tx[i] || 0 } }))
      );
    }
  }

  _refresh(state) {
    const snap = state.snapshot;
    if (!snap) return;

    // Tiles.
    this.tiles.cpu.update(fmtPct(snap.cpu.usage, 1).replace("%", ""), `${snap.cpu.coreCount} cores · ${Math.round(snap.cpu.avgFreqMhz)} MHz`, "%");
    this.tiles.cpu.pushSpark(snap.cpu.usage);
    this.tiles.cpu.setSparkColor(usageColor(snap.cpu.usage));

    this.tiles.mem.update(
      fmtPct(snap.memory.usedPercent, 1).replace("%", ""),
      `${fmtBytes(snap.memory.used)} / ${fmtBytes(snap.memory.total)}`,
      "%"
    );
    this.tiles.mem.pushSpark(snap.memory.usedPercent);

    const loadCls = snap.load.load1PerCore > 1 ? "up" : "down";
    this.tiles.load.update(
      snap.load.load1.toFixed(2),
      `${snap.load.load5.toFixed(2)} · ${snap.load.load15.toFixed(2)} (5/15m)`,
      ""
    );
    this.tiles.load.pushSpark(snap.load.load1);

    const net = (snap.network.totalRxBytesPerSec || 0) + (snap.network.totalTxBytesPerSec || 0);
    const netSplit = splitBytes(net);
    this.tiles.net.update(
      netSplit.value,
      `↓ ${fmtRate(snap.network.totalRxBytesPerSec)}  ↑ ${fmtRate(snap.network.totalTxBytesPerSec)}`,
      netSplit.unit + "/s"
    );
    this.tiles.net.pushSpark(net);

    const diskIo = (snap.disk.totalReadBytesPerSec || 0) + (snap.disk.totalWriteBytesPerSec || 0);
    const diskSplit = splitBytes(diskIo);
    this.tiles.disk.update(
      diskSplit.value,
      `R ${fmtRate(snap.disk.totalReadBytesPerSec)}  W ${fmtRate(snap.disk.totalWriteBytesPerSec)}`,
      diskSplit.unit + "/s"
    );
    this.tiles.disk.pushSpark(diskIo);

    const temp = snap.thermal.maxTemp || 0;
    this.tiles.temp.update(
      temp.toFixed(0),
      temp > 0 ? `avg ${snap.thermal.avgTemp.toFixed(0)}°C` : "no sensors",
      "°C"
    );
    this.tiles.temp.pushSpark(temp);
    this.tiles.temp.setSparkColor(usageColor(clamp(temp, 0, 100)));

    // Legend values.
    if (this.legendValues.cpu) this.legendValues.cpu.textContent = fmtPct(snap.cpu.usage, 1);
    if (this.legendValues.mem) this.legendValues.mem.textContent = fmtPct(snap.memory.usedPercent, 1);

    // Per-core bars.
    if (this.coreBars && snap.cpu.cores) {
      this.coreBars.setData(snap.cpu.cores.map((c) => ({ label: "C" + c.core, value: c.usage })));
    }

    // Filesystem meters.
    this._updateFilesystems(snap.disk.filesystems || []);
    // Memory breakdown.
    this._updateMemory(snap.memory);
    // Summary strip.
    this._updateSummary(state);
  }

  _updateFilesystems(filesystems) {
    const top = filesystems.slice(0, 5);
    // Rebuild only if the count changed; otherwise update in place.
    if (this.fsWrap.childElementCount !== top.length || this._fsCount !== top.length) {
      this.fsWrap.replaceChildren();
      this._fsMeters = [];
      for (const fs of top) {
        const m = meter({ label: fs.mountPoint, tall: false });
        this._fsMeters.push({ meter: m, device: fs.device });
        this.fsWrap.appendChild(m.el);
      }
      this._fsCount = top.length;
    }
    top.forEach((fs, i) => {
      const m = this._fsMeters[i];
      if (m) {
        m.meter.update(
          fs.usedPercent,
          `${fmtBytes(fs.used)} / ${fmtBytes(fs.total)}`,
          usageClass(fs.usedPercent)
        );
      }
    });
    if (top.length === 0) {
      this.fsWrap.replaceChildren(h("div.muted", { text: "No filesystems detected" }));
    }
  }

  _updateMemory(mem) {
    const rows = [
      { label: "Used", value: mem.used, color: cssVar("--series-cpu") },
      { label: "Cached", value: mem.cached, color: cssVar("--series-mem") },
      { label: "Buffers", value: mem.buffers, color: cssVar("--info") },
      { label: "Swap", value: mem.swapUsed, color: cssVar("--series-swap") },
    ];
    if (!this._memMeters) {
      this.memWrap.replaceChildren();
      this._memMeters = rows.map((r) => {
        const m = meter({ label: r.label, color: r.color });
        this.memWrap.appendChild(m.el);
        return m;
      });
    }
    const total = mem.total || 1;
    rows.forEach((r, i) => {
      const denom = r.label === "Swap" ? mem.swapTotal || 1 : total;
      this._memMeters[i].update((r.value / denom) * 100, fmtBytes(r.value));
    });
  }

  _updateProcesses() {
    const procs = store.get().processes;
    if (!procs || !procs.processes) return;
    const top = procs.processes.slice(0, 6);
    this.procWrap.replaceChildren(
      ...top.map((p) =>
        h("div.row-between", { style: { fontSize: "13px" } }, [
          h("div.row.gap-2", { style: { minWidth: 0 } }, [
            h("span.mono.text-3", { text: String(p.pid), style: { width: "52px" } }),
            h("span.truncate.cell-strong", { text: p.name, title: p.cmdline }),
          ]),
          h("div.row.gap-4", null, [
            h("span.mono", {
              text: fmtPct(p.cpuPercent, 1),
              style: { color: usageColor(p.cpuPercent) },
            }),
            h("span.mono.text-2", { text: fmtBytes(p.rssBytes) }),
          ]),
        ])
      )
    );
  }

  _updateSummary(state) {
    const s = this.summaryStrip.items;
    const host = state.host;
    const snap = state.snapshot;
    if (host) s.host.textContent = host.hostname || "unknown";
    if (snap) {
      s.uptime.textContent = fmtUptime(snap.load.uptimeSeconds);
      s.procs.textContent = fmtNum(snap.load.totalProcs || (state.processes?.total ?? 0));
    }
    const alerts = state.alerts?.active?.length || 0;
    s.alerts.textContent = String(alerts);
  }

  update(topic) {
    // Router forwards store topics here; the store subscriptions already
    // handle refresh, so this is a no-op kept for interface completeness.
  }

  unmount() {
    for (const u of this._unsubs) u();
    this._unsubs = [];
    if (this.charts.perf) this.charts.perf.destroy();
    if (this.coreBars) this.coreBars.destroy();
    if (this.netArea) this.netArea.destroy();
    for (const t of Object.values(this.tiles)) {
      const s = t.spark && t.spark();
      if (s) s.destroy();
    }
  }
}

export default OverviewView;

/** A small labeled summary item for the top strip. */
function summaryItem(iconName, label, valueEl) {
  return h("div.row.gap-2", null, [
    h("span.stat-icon", {
      html: icon(iconName, 16),
      style: { width: "32px", height: "32px" },
    }),
    h("div.col", null, [
      h("span.stat-label", { text: label, style: { fontSize: "10px" } }),
      valueEl,
    ]),
  ]);
}
