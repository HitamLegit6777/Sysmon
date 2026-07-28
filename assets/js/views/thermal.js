/**
 * thermal.js
 * ----------
 * The thermal view: a temperature history chart, a grid of thermal zone cards
 * with gauges, cooling device states, and battery/AC power status when present.
 */

import {
  h,
  icon,
  fmtPct,
  cssVar,
  tempClass,
  usageColor,
  clamp,
} from "../util.js";
import store from "../store.js";
import { card, kvList, updateKvList, meter, badge } from "../components/card.js";
import { LineChart } from "../charts/linechart.js";

export class ThermalView {
  constructor() {
    this._unsubs = [];
    this.zoneCells = [];
    this.coolingRows = [];
  }

  mount(container) {
    const view = h("div.view");

    // Max temp headline.
    this.maxValue = h("div.r-value", { text: "0°C" });
    this.avgValue = h("div.r-value", { text: "0°C" });
    const headCard = card({ title: "Temperature", iconName: "thermal", accent: true }, [
      h("div.row.gap-4.wrap", null, [
        h("div.readout", null, [this.maxValue, h("div.r-label", { text: "Max" })]),
        h("div.readout", null, [this.avgValue, h("div.r-label", { text: "Average" })]),
      ]),
    ]);

    // Power card.
    this.powerWrap = h("div.col.gap-4");
    const powerCard = card({ title: "Power", iconName: "battery" }, [this.powerWrap]);

    // Chart.
    const chartHost = h("div.chart.chart-lg");
    const chartCard = card({ title: "Temperature History", iconName: "activity" }, [chartHost]);

    // Zones grid.
    this.zoneGrid = h("div.grid.grid-auto");
    const zoneCard = card({ title: "Thermal Zones", iconName: "thermal" }, [this.zoneGrid]);

    // Cooling devices.
    this.coolingWrap = h("div.col.gap-4");
    const coolingCard = card({ title: "Cooling Devices", iconName: "chip" }, [this.coolingWrap]);

    view.append(
      h("div.grid.grid-3.section", null, [
        h("div", { style: { gridColumn: "span 2" } }, headCard),
        powerCard,
      ]),
      h("div.section", null, chartCard),
      h("div.section", null, zoneCard),
      h("div.section", null, coolingCard)
    );
    container.appendChild(view);

    requestAnimationFrame(() => {
      this.chart = new LineChart(chartHost, {
        yMin: 0,
        yMax: 100,
        ySuffix: "°C",
        yFormat: (v) => String(Math.round(v)),
      });
      this._refresh(store.get());
      this._updateChart();
    });

    this._unsubs.push(store.on("snapshot", () => this._refresh(store.get())));
    this._unsubs.push(store.on("historyPoint", () => this._updateChart()));
    this._refresh(store.get());
  }

  _updateChart() {
    if (!this.chart) return;
    const hist = store.get().history;
    const ts = hist.t.slice(-600);
    this.chart.setData(ts, [
      { key: "temp", label: "Temperature", color: cssVar("--series-temp"), values: hist.temp.slice(-600), fill: true },
    ]);
  }

  _refresh(state) {
    const snap = state.snapshot;
    if (!snap) return;
    const t = snap.thermal;

    this.maxValue.textContent = (t.maxTemp || 0).toFixed(1) + "°C";
    this.maxValue.style.color = usageColor(clamp(t.maxTemp, 0, 100));
    this.avgValue.textContent = (t.avgTemp || 0).toFixed(1) + "°C";

    this._updateZones(t.zones || []);
    this._updateCooling(t.cooling || []);
    this._updatePower(t);
  }

  _updateZones(zones) {
    if (this.zoneCells.length !== zones.length) {
      this.zoneGrid.replaceChildren();
      this.zoneCells = zones.map((z) => {
        const temp = h("div.stat-value", { text: "0°C", style: { fontSize: "26px" } });
        const bar = h("div.progress-bar");
        const el = card({}, [
          h("div.stat-label", { text: z.zoneType || z.name }),
          temp,
          h("div.progress.thin", { style: { marginTop: "8px" } }, bar),
        ]);
        this.zoneGrid.appendChild(el);
        return { temp, bar };
      });
    }
    zones.forEach((z, i) => {
      const cell = this.zoneCells[i];
      if (!cell) return;
      cell.temp.textContent = z.tempCelsius.toFixed(1) + "°C";
      cell.temp.style.color = usageColor(clamp(z.tempCelsius, 0, 100));
      cell.bar.style.width = clamp(z.tempCelsius, 0, 100) + "%";
      cell.bar.style.background = usageColor(clamp(z.tempCelsius, 0, 100));
    });
    if (zones.length === 0) {
      this.zoneGrid.replaceChildren(h("div.muted", { text: "No thermal sensors detected" }));
    }
  }

  _updateCooling(cooling) {
    if (this.coolingRows.length !== cooling.length) {
      this.coolingWrap.replaceChildren();
      this.coolingRows = cooling.map((c) => {
        const m = meter({ label: c.deviceType || c.name });
        this.coolingWrap.appendChild(m.el);
        return m;
      });
    }
    cooling.forEach((c, i) => {
      const m = this.coolingRows[i];
      if (m) m.update(c.percent, `${c.curState} / ${c.maxState}`);
    });
    if (cooling.length === 0) {
      this.coolingWrap.replaceChildren(h("div.muted", { text: "No cooling devices" }));
    }
  }

  _updatePower(t) {
    this.powerWrap.replaceChildren();
    if (t.batteryPresent) {
      const m = meter({
        label: "Battery",
        color: t.batteryPercent > 20 ? cssVar("--success") : cssVar("--danger"),
        tall: true,
      });
      this.powerWrap.appendChild(m.el);
      m.update(t.batteryPercent, t.batteryPercent.toFixed(0) + "%");
      this.powerWrap.appendChild(
        h("div.row.gap-2", { style: { marginTop: "8px" } }, [
          badge(t.batteryStatus || "Unknown", t.onAcPower ? "success" : "warning"),
          badge(t.onAcPower ? "On AC" : "On Battery", t.onAcPower ? "info" : "neutral"),
        ])
      );
    } else {
      this.powerWrap.appendChild(
        h("div.empty-state", { style: { padding: "24px" } }, [
          h("span", { html: icon("battery", 32) }),
          h("div.muted", { text: "No battery detected" }),
          t.onAcPower ? badge("On AC Power", "success") : null,
        ])
      );
    }
  }

  update() {}

  unmount() {
    for (const u of this._unsubs) u();
    this._unsubs = [];
    if (this.chart) this.chart.destroy();
  }
}

export default ThermalView;
