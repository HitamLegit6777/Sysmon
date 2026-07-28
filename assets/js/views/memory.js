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
} from "../util.js";
import store from "../store.js";
import { card, kvList, updateKvList, meter } from "../components/card.js";
import { LineChart } from "../charts/linechart.js";
import { Gauge } from "../charts/gauge.js";

export class MemoryView {
  constructor() {
    this._unsubs = [];
  }

  mount(container) {
    const view = h("div.view");

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

    // Composition stacked bar.
    this.compBar = h("div.progress-segmented", { style: { height: "22px" } });
    this.compLegend = h("div.chart-legend");
    const compCard = card({ title: "Composition", iconName: "layers" }, [
      this.compBar,
      this.compLegend,
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
      this.chart = new LineChart(chartHost, {
        yMin: 0,
        yMax: 100,
        ySuffix: "%",
        yFormat: (v) => String(Math.round(v)),
      });
      this._buildComposition();
      this._refresh(store.get());
      this._updateChart();
    });

    this._unsubs.push(store.on("snapshot", () => this._refresh(store.get())));
    this._unsubs.push(store.on("historyPoint", () => this._updateChart()));
    this._refresh(store.get());
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
    const parts = [
      ["used", "Used", cssVar("--series-cpu")],
      ["cached", "Cached", cssVar("--series-mem")],
      ["buffers", "Buffers", cssVar("--info")],
      ["free", "Free", cssVar("--bg-3")],
    ];
    this.compBar.replaceChildren();
    this.compLegend.replaceChildren();
    for (const [key, label, color] of parts) {
      const seg = h("div.seg", { style: { background: color, flex: "0 0 0%" } });
      this.compSegs[key] = seg;
      this.compBar.appendChild(seg);
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

  _refresh(state) {
    const snap = state.snapshot;
    if (!snap) return;
    const m = snap.memory;

    if (this.gauge) this.gauge.set(m.usedPercent);
    this.gaugeValue.textContent = fmtPct(m.usedPercent, 0);
    this.gaugeValue.style.color = usageColor(m.usedPercent);

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
      const set = (key, bytes) => {
        const pct = (bytes / total) * 100;
        if (this.compSegs[key]) this.compSegs[key].style.flex = `0 0 ${pct}%`;
        if (this.compSegs[key + "_v"]) this.compSegs[key + "_v"].textContent = fmtBytes(bytes);
      };
      set("used", m.used);
      set("cached", m.cached);
      set("buffers", m.buffers);
      set("free", free);
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
    if (this.gauge) this.gauge.destroy();
    if (this.chart) this.chart.destroy();
  }
}

export default MemoryView;
