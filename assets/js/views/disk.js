/**
 * disk.js
 * -------
 * The disk detail view: aggregate capacity headline, a read/write I/O history
 * chart, a filesystem capacity table with usage bars and inode figures, and a
 * per-block-device I/O table with live throughput and utilization.
 */

import {
  h,
  icon,
  fmtBytes,
  fmtRate,
  fmtPct,
  fmtNum,
  cssVar,
  usageColor,
  usageClass,
  splitBytes,
  clamp,
} from "../util.js";
import store from "../store.js";
import { card, kvList, updateKvList } from "../components/card.js";
import { DataTable } from "../components/table.js";
import { LineChart } from "../charts/linechart.js";

export class DiskView {
  constructor() {
    this._unsubs = [];
  }

  mount(container) {
    const view = h("div.view");

    // Headline capacity + I/O.
    this.capValue = h("div.r-value", { text: "0" });
    this.readValue = h("div.r-value", { text: "0" });
    this.writeValue = h("div.r-value", { text: "0" });
    const headCard = card({ title: "Storage", iconName: "disk", accent: true }, [
      h("div.row.gap-4.wrap", null, [
        h("div.readout", null, [this.capValue, h("div.r-label", { text: "Used capacity" })]),
        h("div.readout", null, [
          h("div.row.gap-2", null, [
            h("span", { html: icon("download", 16), style: { color: cssVar("--series-disk-r") } }),
            this.readValue,
          ]),
          h("div.r-label", { text: "Read" }),
        ]),
        h("div.readout", null, [
          h("div.row.gap-2", null, [
            h("span", { html: icon("upload", 16), style: { color: cssVar("--series-disk-w") } }),
            this.writeValue,
          ]),
          h("div.r-label", { text: "Write" }),
        ]),
      ]),
    ]);

    // Chart.
    const chartHost = h("div.chart.chart-lg");
    const chartCard = card({ title: "Disk I/O History", iconName: "activity" }, [
      chartHost,
      this._legend(),
    ]);

    // Filesystems table.
    this.fsTable = new DataTable({
      columns: [
        { key: "mountPoint", label: "Mount", render: (r) => h("span.cell-strong", { text: r.mountPoint, title: r.device }) },
        { key: "fsType", label: "Type" },
        { key: "total", label: "Size", num: true, render: (r) => fmtBytes(r.total) },
        { key: "used", label: "Used", num: true, render: (r) => fmtBytes(r.used) },
        { key: "available", label: "Free", num: true, render: (r) => fmtBytes(r.available) },
        {
          key: "usedPercent",
          label: "Usage",
          num: true,
          render: (r) => this._usageBar(r.usedPercent),
        },
        {
          key: "inodesUsedPercent",
          label: "Inodes",
          num: true,
          render: (r) => fmtPct(r.inodesUsedPercent, 0),
        },
      ],
      sortKey: "total",
      sortDir: "desc",
      rowKey: (r) => r.mountPoint,
      emptyText: "No filesystems",
    });
    const fsCard = card({ title: "Filesystems", iconName: "layers" }, [this.fsTable.el]);

    // Devices table.
    this.devTable = new DataTable({
      columns: [
        { key: "name", label: "Device", render: (r) => h("span.cell-strong", { text: r.name }) },
        { key: "readBytesPerSec", label: "Read/s", num: true, render: (r) => fmtRate(r.readBytesPerSec) },
        { key: "writeBytesPerSec", label: "Write/s", num: true, render: (r) => fmtRate(r.writeBytesPerSec) },
        { key: "readOpsPerSec", label: "IOPS R", num: true, render: (r) => fmtNum(Math.round(r.readOpsPerSec)) },
        { key: "writeOpsPerSec", label: "IOPS W", num: true, render: (r) => fmtNum(Math.round(r.writeOpsPerSec)) },
        { key: "utilPercent", label: "Util", num: true, render: (r) => this._usageBar(r.utilPercent) },
      ],
      sortKey: "readBytesPerSec",
      sortDir: "desc",
      rowKey: (r) => r.name,
      emptyText: "No block devices",
    });
    const devCard = card({ title: "Block Devices", iconName: "disk" }, [this.devTable.el]);

    view.append(
      h("div.section", null, headCard),
      h("div.section", null, chartCard),
      h("div.section", null, fsCard),
      h("div.section", null, devCard)
    );
    container.appendChild(view);

    requestAnimationFrame(() => {
      this.chart = new LineChart(chartHost, {
        yMin: 0,
        yFormat: (v) => fmtBytes(v, 0),
        tooltipFormat: (v) => fmtRate(v),
      });
      this._refresh(store.get());
      this._updateChart();
    });

    this._unsubs.push(store.on("snapshot", () => this._refresh(store.get())));
    this._unsubs.push(store.on("historyPoint", () => this._updateChart()));
    this._refresh(store.get());
  }

  _usageBar(pct) {
    const wrap = h("span", { style: { display: "inline-flex", alignItems: "center", gap: "8px", justifyContent: "flex-end" } }, [
      h("span", { text: fmtPct(pct, 0), style: { color: usageColor(pct), minWidth: "36px" } }),
      h("span.cell-mini-bar", null, h("i", { style: { width: clamp(pct, 0, 100) + "%", background: usageColor(pct) } })),
    ]);
    return wrap;
  }

  _legend() {
    const items = [
      ["r", "Read", cssVar("--series-disk-r")],
      ["w", "Write", cssVar("--series-disk-w")],
    ];
    this.legendVals = {};
    const legend = h("div.chart-legend");
    for (const [key, label, color] of items) {
      const v = h("span.lv", { text: "0/s" });
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
    const ts = hist.t.slice(-600);
    this.chart.setData(ts, [
      { key: "r", label: "Read", color: cssVar("--series-disk-r"), values: hist.diskR.slice(-600), fill: true },
      { key: "w", label: "Write", color: cssVar("--series-disk-w"), values: hist.diskW.slice(-600), fill: true },
    ]);
  }

  _refresh(state) {
    const snap = state.snapshot;
    if (!snap) return;
    const d = snap.disk;

    const cap = splitBytes(d.totalUsed);
    this.capValue.innerHTML = `${cap.value}<span style="font-size:14px;color:var(--text-3)"> ${cap.unit}</span>`;
    const rd = splitBytes(d.totalReadBytesPerSec);
    const wr = splitBytes(d.totalWriteBytesPerSec);
    this.readValue.innerHTML = `${rd.value}<span style="font-size:14px;color:var(--text-3)"> ${rd.unit}/s</span>`;
    this.writeValue.innerHTML = `${wr.value}<span style="font-size:14px;color:var(--text-3)"> ${wr.unit}/s</span>`;

    if (this.legendVals.r) this.legendVals.r.textContent = fmtRate(d.totalReadBytesPerSec);
    if (this.legendVals.w) this.legendVals.w.textContent = fmtRate(d.totalWriteBytesPerSec);

    this.fsTable.update((d.filesystems || []).slice());
    this.devTable.update((d.devices || []).slice());
  }

  update() {}

  unmount() {
    for (const u of this._unsubs) u();
    this._unsubs = [];
    if (this.chart) this.chart.destroy();
  }
}

export default DiskView;
