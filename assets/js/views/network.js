/**
 * network.js
 * ----------
 * The network detail view: total throughput headline with a dual-direction
 * history chart (rx/tx), socket statistics, and a per-interface table with
 * live rates, packets, errors, and link state.
 */

import {
  h,
  icon,
  fmtBytes,
  fmtRate,
  fmtNum,
  fmtCompact,
  cssVar,
  splitBytes,
} from "../util.js";
import store from "../store.js";
import { card, kvList, updateKvList, badge } from "../components/card.js";
import { DataTable } from "../components/table.js";
import { LineChart } from "../charts/linechart.js";

export class NetworkView {
  constructor() {
    this._unsubs = [];
  }

  mount(container) {
    const view = h("div.view");

    // Headline throughput.
    this.rxValue = h("div.r-value", { text: "0" });
    this.txValue = h("div.r-value", { text: "0" });
    const headCard = card({ title: "Throughput", iconName: "network", accent: true }, [
      h("div.row.gap-4.wrap", { style: { marginBottom: "12px" } }, [
        h("div.readout", null, [
          h("div.row.gap-2", null, [
            h("span", { html: icon("download", 16), style: { color: cssVar("--series-net-rx") } }),
            this.rxValue,
          ]),
          h("div.r-label", { text: "Download" }),
        ]),
        h("div.readout", null, [
          h("div.row.gap-2", null, [
            h("span", { html: icon("upload", 16), style: { color: cssVar("--series-net-tx") } }),
            this.txValue,
          ]),
          h("div.r-label", { text: "Upload" }),
        ]),
      ]),
    ]);

    // Chart.
    const chartHost = h("div.chart.chart-lg");
    const chartCard = card({ title: "Network History", iconName: "activity" }, [
      chartHost,
      this._legend(),
    ]);

    // Sockets.
    this.socketInfo = kvList([
      ["TCP connections", "0"],
      ["TCP listening", "0"],
      ["UDP sockets", "0"],
      ["Total RX", "0"],
      ["Total TX", "0"],
    ]);
    const socketCard = card({ title: "Sockets", iconName: "wifi" }, [this.socketInfo]);

    // Interfaces table.
    this.table = new DataTable({
      columns: [
        {
          key: "name",
          label: "Interface",
          render: (r) =>
            h("div.row.gap-2", null, [
              h("span.status-dot" + (r.isUp ? ".online" : ".offline")),
              h("span.cell-strong", { text: r.name }),
            ]),
        },
        {
          key: "rxBytesPerSec",
          label: "↓ RX/s",
          num: true,
          render: (r) => fmtRate(r.rxBytesPerSec),
        },
        {
          key: "txBytesPerSec",
          label: "↑ TX/s",
          num: true,
          render: (r) => fmtRate(r.txBytesPerSec),
        },
        { key: "rxBytes", label: "Total RX", num: true, render: (r) => fmtBytes(r.rxBytes) },
        { key: "txBytes", label: "Total TX", num: true, render: (r) => fmtBytes(r.txBytes) },
        {
          key: "rxErrors",
          label: "Errors",
          num: true,
          render: (r) => fmtNum(r.rxErrors + r.txErrors),
        },
        {
          key: "mtu",
          label: "MTU",
          num: true,
          render: (r) => String(r.mtu),
        },
      ],
      sortKey: "rxBytesPerSec",
      sortDir: "desc",
      rowKey: (r) => r.name,
      emptyText: "No interfaces",
      onSort: (key, dir) => {
        this.sortKey = key;
        this.sortDir = dir;
        this._updateTable();
      },
    });
    const tableCard = card({ title: "Interfaces", iconName: "network" }, [this.table.el]);

    view.append(
      h("div.grid.grid-3.section", null, [
        h("div", { style: { gridColumn: "span 2" } }, headCard),
        socketCard,
      ]),
      h("div.section", null, chartCard),
      h("div.section", null, tableCard)
    );
    container.appendChild(view);

    this.sortKey = "rxBytesPerSec";
    this.sortDir = "desc";

    requestAnimationFrame(() => {
      this.chart = new LineChart(chartHost, {
        yMin: 0,
        ySuffix: "",
        yFormat: (v) => fmtBytes(v, 0),
        tooltipFormat: (v) => fmtRate(v),
        tooltipExtra: (i) => {
          const h2 = store.get().history;
          const rx = h2.netRx.slice(-600)[i];
          const tx = h2.netTx.slice(-600)[i];
          if (rx == null || tx == null) return "";
          return (
            `<div class="tt-row"><span class="tt-label">Total</span>` +
            `<span class="tt-val">${fmtRate(rx + tx)}</span></div>`
          );
        },
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
      ["rx", "Download", cssVar("--series-net-rx")],
      ["tx", "Upload", cssVar("--series-net-tx")],
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
      { key: "rx", label: "Download", color: cssVar("--series-net-rx"), values: hist.netRx.slice(-600), fill: true },
      { key: "tx", label: "Upload", color: cssVar("--series-net-tx"), values: hist.netTx.slice(-600), fill: true },
    ]);
  }

  _sortInterfaces(list) {
    const key = this.sortKey;
    const dir = this.sortDir === "asc" ? 1 : -1;
    return list.slice().sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (typeof av === "string") return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });
  }

  _updateTable() {
    const snap = store.get().snapshot;
    if (!snap) return;
    this.table.update(this._sortInterfaces(snap.network.interfaces || []));
  }

  _refresh(state) {
    const snap = state.snapshot;
    if (!snap) return;
    const net = snap.network;

    const rx = splitBytes(net.totalRxBytesPerSec);
    const tx = splitBytes(net.totalTxBytesPerSec);
    this.rxValue.innerHTML = `${rx.value}<span style="font-size:14px;color:var(--text-3)"> ${rx.unit}/s</span>`;
    this.txValue.innerHTML = `${tx.value}<span style="font-size:14px;color:var(--text-3)"> ${tx.unit}/s</span>`;

    updateKvList(this.socketInfo, [
      fmtNum(net.tcpConnections),
      fmtNum(net.tcpListening),
      fmtNum(net.udpConnections),
      fmtBytes(net.totalRxBytes),
      fmtBytes(net.totalTxBytes),
    ]);

    if (this.legendVals.rx) this.legendVals.rx.textContent = fmtRate(net.totalRxBytesPerSec);
    if (this.legendVals.tx) this.legendVals.tx.textContent = fmtRate(net.totalTxBytesPerSec);

    this._updateTable();
  }

  update() {}

  unmount() {
    for (const u of this._unsubs) u();
    this._unsubs = [];
    if (this.chart) this.chart.destroy();
  }
}

export default NetworkView;
