/**
 * memory.js
 * ---------
 * The memory detail view: a usage gauge, a stacked memory composition bar
 * (used / cached / buffers / free), a memory + swap history chart, and a
 * detailed table of meminfo-derived figures (active, dirty, committed, etc.).
 */

import {
  h,
  icon,
  fmtBytes,
  fmtPct,
  cssVar,
  usageColor,
  usageClass,
  clamp,
  escapeHtml,
} from "../util.js";
import store from "../store.js";
import { card, kvList, updateKvList, meter } from "../components/card.js";
import { LineChart } from "../charts/linechart.js";
import { Gauge } from "../charts/gauge.js";
import { Donut } from "../charts/donut.js";
import { kpi } from "../components/widgets.js";

export class MemoryView {
  constructor() {
    this._unsubs = [];
  }

  mount(container) {
    const view = h("div.view");

    this._kpis = {
      used: kpi({ label: "Memory Used", value: "0", unit: "%", icon: "memory", accent: "accent" }),
      avail: kpi({ label: "Available", value: "—", icon: "layers" }),
      swap: kpi({ label: "Swap Used", value: "0", unit: "%", icon: "disk" }),
      cache: kpi({ label: "Cache + Buffers", value: "—", icon: "activity" }),
      commit: kpi({ label: "Committed", value: "—", icon: "server" }),
    };
    const kpiStrip = h("div.kpi-strip.section", null, [
      this._kpis.used.el,
      this._kpis.avail.el,
      this._kpis.swap.el,
      this._kpis.cache.el,
      this._kpis.commit.el,
    ]);

    const gaugeCanvas = h("canvas");
    this.gaugeValue = h("div.big", { text: "0%" });
    const gaugeWrap = h("div.ring-wrap", { style: { height: "200px" } }, [
      h("div.gauge", { style: { width: "200px", height: "200px" } }, gaugeCanvas),
      h("div.ring-center", null, [this.gaugeValue, h("div.small", { text: "RAM" })]),
    ]);
    this.headStats = kvList([
      ["Total", "…"],
      ["Used", "…"],
      ["Available", "…"],
      ["Cached", "…"],
      ["Buffers", "…"],
    ]);
    const gaugeCard = card({ title: "Memory Usage", iconName: "memory" }, [
      h("div.row.gap-4", { style: { alignItems: "center" } }, [
        gaugeWrap,
        h("div.flex-1", null, this.headStats),
      ]),
    ]);

    // Composition donut (used / cached / buffers / free).
    this.compDonutHost = h("div.chart", { style: { width: "180px", height: "180px", flex: "0 0 180px" } });
    this.compLegend = h("div.chart-legend.flex-1");
    const compCard = card({ title: "Composition", iconName: "layers" }, [
      h("div.row.gap-4", { style: { alignItems: "center" } }, [
        this.compDonutHost,
        this.compLegend,
      ]),
    ]);

    // Swap meters.
    this.swapMeter = meter({ label: "Swap", color: cssVar("--series-swap"), tall: true });
    const swapCard = card({ title: "Swap", iconName: "disk" }, [
      this.swapMeter.el,
      h("div.swap-detail.mono.text-2", { style: { marginTop: "10px", fontSize: "12px" } }),
    ]);
    this.swapDetail = swapCard.querySelector(".swap-detail");

    // History chart.
    const chartHost = h("div.chart.chart-lg");
    const chartCard = card(
      { title: "Memory History", iconName: "activity", accent: true },
      [chartHost, this._legend()]
    );

    // Detailed table.
    this.detail = kvList([
      ["Active", "…"],
      ["Inactive", "…"],
      ["Dirty", "…"],
      ["Writeback", "…"],
      ["Mapped", "…"],
      ["Slab", "…"],
      ["Page tables", "…"],
      ["Committed", "…"],
      ["Commit limit", "…"],
    ]);
    const detailCard = card({ title: "Details", iconName: "info" }, [this.detail]);

    view.append(
      kpiStrip,
      h("div.grid.grid-3.section", null, [
        h("div", { style: { gridColumn: "span 2" } }, gaugeCard),
        swapCard,
      ]),
      h("div.section", null, compCard),
      h("div.section", null, chartCard),
      h("div.section", null, detailCard)
    );
    container.appendChild(view);

    requestAnimationFrame(() => {
      this.gauge = new Gauge(gaugeCanvas, { thickness: 16 });
      this.compDonut = new Donut(this.compDonutHost, { thickness: 20, centerSub: "RAM" });
      this.chart = new LineChart(chartHost, {
        yMin: 0,
        yMax: 100,
        ySuffix: "%",
        yFormat: (v) => String(Math.round(v)),
        tooltipExtra: (i) => this._tooltipExtra(i),
      });
      this._buildComposition();
      this._refresh(store.get());
      this._updateChart();
    });

    this._unsubs.push(store.on("snapshot", () => this._refresh(store.get())));
    this._unsubs.push(store.on("historyPoint", () => this._updateChart()));
    this._refresh(store.get());

    // Ask for a fresh process table so the chart tooltip can show top memory
    // consumers, and refresh it periodically while this view is mounted.
    import("../ws.js").then((m) => m.default.requestProcesses());
    this._procTimer = setInterval(() => {
      import("../ws.js").then((m) => m.default.requestProcesses());
    }, 5000);
  }

  _legend() {
    const items = [
      ["mem", "Memory", cssVar("--series-mem")],
      ["swap", "Swap", cssVar("--series-swap")],
    ];
    this.legendVals = {};
    const legend = h("div.chart-legend");
    for (const [key, label, color] of items) {
      const v = h("span.lv", { text: "0%" });
      this.legendVals[key] = v;
      legend.appendChild(
        h("div.legend-item", { onClick: () => this.chart && this.chart.toggleSeries(key) }, [
          h("span.legend-swatch", { style: { background: color } }),
          h("span", { text: label }),
          v,
        ])
      );
    }
    return legend;
  }

  _buildComposition() {
    this.compSegs = {};
    this._compParts = [
      ["used", "Used", cssVar("--series-cpu")],
      ["cached", "Cached", cssVar("--series-mem")],
      ["buffers", "Buffers", cssVar("--info")],
      ["free", "Free", cssVar("--bg-3")],
    ];
    this.compLegend.replaceChildren();
    for (const [key, label, color] of this._compParts) {
      const v = h("span.lv", { text: "0" });
      this.compSegs[key + "_v"] = v;
      this.compLegend.appendChild(
        h("div.legend-item", null, [
          h("span.legend-swatch", { style: { background: color } }),
          h("span", { text: label }),
          v,
        ])
      );
    }
  }

  _updateChart() {
    if (!this.chart) return;
    const hist = store.get().history;
    const ts = hist.t.slice(-600);
    this.chart.setData(ts, [
      { key: "mem", label: "Memory", color: cssVar("--series-mem"), values: hist.mem.slice(-600), fill: true },
      { key: "swap", label: "Swap", color: cssVar("--series-swap"), values: hist.swap.slice(-600), fill: true },
    ]);
  }

  // Extra tooltip rows: the current top memory-consuming processes. The
  // per-process history is only available for the latest sample, so this is
  // shown as "top now" context.
  _tooltipExtra(i) {
    const st = store.get();
    const procs = st.processes && st.processes.processes;
    if (!procs || !procs.length) return "";
    const top = procs
      .slice()
      .sort((a, b) => (b.rssBytes || 0) - (a.rssBytes || 0))
      .slice(0, 3);
    const rows = top
      .map(
        (p) =>
          `<div class="tt-row"><span class="tt-proc">${escapeHtml(p.name)}</span>` +
          `<span class="tt-val">${fmtBytes(p.rssBytes)}</span></div>`
      )
      .join("");
    return `<div class="tt-sub">Top memory (now)</div>${rows}`;
  }

  _refresh(state) {
    const snap = state.snapshot;
    if (!snap) return;
    const m = snap.memory;

    if (this.gauge) this.gauge.set(m.usedPercent);
    this.gaugeValue.textContent = fmtPct(m.usedPercent, 0);
    this.gaugeValue.style.color = usageColor(m.usedPercent);

    // KPI strip.
    const memAccent = m.usedPercent >= 90 ? "danger" : m.usedPercent >= 75 ? "warn" : "accent";
    this._kpis.used.update({ value: fmtPct(m.usedPercent, 0).replace("%", ""), accent: memAccent, sub: fmtBytes(m.used) + " / " + fmtBytes(m.total) });
    this._kpis.avail.update({ value: fmtBytes(m.available) });
    const swapPct = m.swapUsedPercent || 0;
    this._kpis.swap.update({
      value: m.swapTotal > 0 ? fmtPct(swapPct, 0).replace("%", "") : "0",
      accent: swapPct >= 50 ? "warn" : "accent",
      sub: m.swapTotal > 0 ? fmtBytes(m.swapUsed) + " / " + fmtBytes(m.swapTotal) : "no swap",
    });
    this._kpis.cache.update({ value: fmtBytes((m.cached || 0) + (m.buffers || 0)) });
    this._kpis.commit.update({ value: fmtBytes(m.committedAs || 0), sub: m.commitLimit ? "limit " + fmtBytes(m.commitLimit) : "" });

    updateKvList(this.headStats, [
      fmtBytes(m.total),
      fmtBytes(m.used),
      fmtBytes(m.available),
      fmtBytes(m.cached),
      fmtBytes(m.buffers),
    ]);

    // Composition.
    if (this.compSegs) {
      const total = m.total || 1;
      const free = Math.max(0, m.total - m.used - m.cached - m.buffers);
      const values = { used: m.used, cached: m.cached, buffers: m.buffers, free };
      for (const key of ["used", "cached", "buffers", "free"]) {
        if (this.compSegs[key + "_v"]) this.compSegs[key + "_v"].textContent = fmtBytes(values[key]);
      }
      if (this.compDonut && this._compParts) {
        this.compDonut.setSegments(
          this._compParts.map(([key, label, color]) => ({ label, value: values[key], color })),
          { title: fmtPct((m.used / total) * 100, 0), sub: "used" }
        );
      }
    }

    // Swap.
    this.swapMeter.update(
      m.swapUsedPercent,
      fmtBytes(m.swapUsed) + " / " + fmtBytes(m.swapTotal),
      usageClass(m.swapUsedPercent)
    );
    if (this.swapDetail) {
      this.swapDetail.textContent = m.swapTotal
        ? `${fmtPct(m.swapUsedPercent, 1)} used · ${fmtBytes(m.swapFree)} free`
        : "No swap configured";
    }

    if (this.legendVals.mem) this.legendVals.mem.textContent = fmtPct(m.usedPercent, 1);
    if (this.legendVals.swap) this.legendVals.swap.textContent = fmtPct(m.swapUsedPercent, 1);

    updateKvList(this.detail, [
      fmtBytes(m.active),
      fmtBytes(m.inactive),
      fmtBytes(m.dirty),
      fmtBytes(m.writeback),
      fmtBytes(m.mapped),
      fmtBytes(m.slab),
      fmtBytes(m.pageTables),
      fmtBytes(m.committedAs),
      fmtBytes(m.commitLimit),
    ]);
  }

  update() {}

  unmount() {
    for (const u of this._unsubs) u();
    this._unsubs = [];
    if (this._procTimer) clearInterval(this._procTimer);
    if (this.gauge) this.gauge.destroy();
    if (this.compDonut) this.compDonut.destroy();
    if (this.chart) this.chart.destroy();
  }
}

export default MemoryView;
