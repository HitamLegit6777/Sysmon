/**
 * cpu.js
 * ------
 * The CPU detail view: a large utilization gauge with headline numbers, a
 * full-history CPU line chart split by user/system/iowait, a per-core grid
 * with individual sparkline-free bars and frequencies, and a breakdown of
 * scheduler counters (context switches, forks, interrupts).
 */

import {
  h,
  icon,
  fmtPct,
  fmtNum,
  fmtCompact,
  cssVar,
  usageColor,
  usageClass,
  clamp,
} from "../util.js";
import store from "../store.js";
import { card, kvList, updateKvList } from "../components/card.js";
import { LineChart } from "../charts/linechart.js";
import { Gauge } from "../charts/gauge.js";

export class CpuView {
  constructor() {
    this._unsubs = [];
    this.coreCells = [];
  }

  mount(container) {
    const view = h("div.view");

    // Gauge + headline.
    const gaugeCanvas = h("canvas");
    this.gaugeValue = h("div.big", { text: "0%" });
    const gaugeWrap = h("div.ring-wrap", { style: { height: "200px" } }, [
      h("div.gauge", { style: { width: "200px", height: "200px" } }, gaugeCanvas),
      h("div.ring-center", null, [
        this.gaugeValue,
        h("div.small", { text: "CPU" }),
      ]),
    ]);
    this.headStats = kvList([
      ["User", "0%"],
      ["System", "0%"],
      ["I/O wait", "0%"],
      ["Idle", "0%"],
      ["Frequency", "0 MHz"],
    ]);
    const gaugeCard = card({ title: "Utilization", iconName: "gauge" }, [
      h("div.row.gap-4", { style: { alignItems: "center" } }, [
        gaugeWrap,
        h("div.flex-1", null, this.headStats),
      ]),
    ]);

    // Model card.
    this.modelInfo = kvList([
      ["Model", "…"],
      ["Cores", "…"],
      ["Threads", "…"],
      ["Cache", "…"],
      ["Base clock", "…"],
    ]);
    const modelCard = card({ title: "Processor", iconName: "chip" }, [
      this.modelInfo,
    ]);

    // History chart.
    const chartHost = h("div.chart.chart-lg");
    const chartCard = card(
      { title: "CPU History", iconName: "activity", accent: true },
      [chartHost, this._legend()]
    );

    // Per-core grid.
    this.coreGrid = h("div.core-grid");
    const coreCard = card({ title: "Per-Core Detail", iconName: "cpu" }, [
      this.coreGrid,
    ]);

    // Scheduler counters.
    this.schedInfo = kvList([
      ["Context switches/s", "0"],
      ["Forks/s", "0"],
      ["Interrupts/s", "0"],
      ["Running", "0"],
      ["Blocked", "0"],
    ]);
    const schedCard = card({ title: "Scheduler", iconName: "layers" }, [
      this.schedInfo,
    ]);

    view.append(
      h("div.grid.grid-3.section", null, [
        h("div", { style: { gridColumn: "span 2" } }, gaugeCard),
        modelCard,
      ]),
      h("div.section", null, chartCard),
      h("div.grid.grid-3.section", null, [
        h("div", { style: { gridColumn: "span 2" } }, coreCard),
        schedCard,
      ])
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
      this._refresh(store.get());
      this._updateChart();
    });

    this._unsubs.push(store.on("snapshot", () => this._refresh(store.get())));
    this._unsubs.push(store.on("historyPoint", () => this._updateChart()));
    this._refresh(store.get());
  }

  _legend() {
    const items = [
      ["cpu", "Total", cssVar("--series-cpu")],
      ["system", "System", cssVar("--warning")],
      ["iowait", "I/O wait", cssVar("--info")],
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

  _updateChart() {
    if (!this.chart) return;
    const hist = store.get().history;
    // Build user/system/iowait approximations from stored cpu series + snapshot.
    const ts = hist.t.slice(-600);
    const cpu = hist.cpu.slice(-600);
    this.chart.setData(ts, [
      { key: "cpu", label: "Total", color: cssVar("--series-cpu"), values: cpu, fill: true },
    ]);
  }

  _refresh(state) {
    const snap = state.snapshot;
    if (!snap) return;
    const c = snap.cpu;

    if (this.gauge) this.gauge.set(c.usage);
    this.gaugeValue.textContent = fmtPct(c.usage, 0);
    this.gaugeValue.style.color = usageColor(c.usage);

    updateKvList(this.headStats, [
      fmtPct(c.user, 1),
      fmtPct(c.system, 1),
      fmtPct(c.iowait, 1),
      fmtPct(c.idle, 1),
      Math.round(c.avgFreqMhz) + " MHz",
    ]);

    if (this.legendVals.cpu) this.legendVals.cpu.textContent = fmtPct(c.usage, 1);
    if (this.legendVals.system) this.legendVals.system.textContent = fmtPct(c.system, 1);
    if (this.legendVals.iowait) this.legendVals.iowait.textContent = fmtPct(c.iowait, 1);

    const host = state.host;
    if (host) {
      updateKvList(this.modelInfo, [
        host.cpuModel || "unknown",
        String(host.cpuCoresPhysical || "?"),
        String(host.cpuCoresLogical || c.coreCount),
        host.cpuCacheKb ? Math.round(host.cpuCacheKb / 1024) + " MB" : "n/a",
        host.cpuMhzBase ? Math.round(host.cpuMhzBase) + " MHz" : "n/a",
      ]);
    }

    updateKvList(this.schedInfo, [
      fmtCompact(c.ctxtPerSec),
      fmtCompact(c.forksPerSec),
      fmtCompact(c.interruptsPerSec),
      String(c.procsRunning),
      String(c.procsBlocked),
    ]);

    this._updateCores(c.cores || []);
  }

  _updateCores(cores) {
    if (this.coreCells.length !== cores.length) {
      this.coreGrid.replaceChildren();
      this.coreCells = cores.map((core) => {
        const val = h("span.core-val", { text: "0%" });
        const bar = h("div.progress-bar");
        const freq = h("div.core-freq", { text: "" });
        const cell = h("div.core-cell", null, [
          h("div.core-head", null, [
            h("span.core-name", { text: "Core " + core.core }),
            val,
          ]),
          h("div.progress.thin", null, bar),
          freq,
        ]);
        this.coreGrid.appendChild(cell);
        return { val, bar, freq };
      });
    }
    cores.forEach((core, i) => {
      const cell = this.coreCells[i];
      if (!cell) return;
      cell.val.textContent = fmtPct(core.usage, 0);
      cell.val.style.color = usageColor(core.usage);
      cell.bar.style.width = clamp(core.usage, 0, 100) + "%";
      cell.bar.style.background = usageColor(core.usage);
      cell.freq.textContent = core.freqMhz > 0 ? Math.round(core.freqMhz) + " MHz" : "";
    });
  }

  update() {}

  unmount() {
    for (const u of this._unsubs) u();
    this._unsubs = [];
    if (this.gauge) this.gauge.destroy();
    if (this.chart) this.chart.destroy();
  }
}

export default CpuView;
