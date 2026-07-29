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
import { StackedBars } from "../charts/stackedbars.js";
import { kpi } from "../components/widgets.js";

export class NetworkView {
  constructor() {
    this._unsubs = [];
  }

  mount(container) {
    const view = h("div.view");

    this._kpis = {
      down: kpi({ label: "Download", value: "0", unit: "B/s", icon: "download", accent: "accent" }),
      up: kpi({ label: "Upload", value: "0", unit: "B/s", icon: "upload", accent: "accent" }),
      conns: kpi({ label: "TCP Connections", value: "0", icon: "network" }),
      listen: kpi({ label: "Listening Ports", value: "0", icon: "server" }),
      ifaces: kpi({ label: "Interfaces Up", value: "0", icon: "wifi" }),
    };
    const kpiStrip = h("div.kpi-strip.section", null, [
      this._kpis.down.el,
      this._kpis.up.el,
      this._kpis.conns.el,
      this._kpis.listen.el,
      this._kpis.ifaces.el,
    ]);

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

    // Recent throughput (stacked RX/TX per sample bucket).
    this.barsHost = h("div.chart", { style: { height: "150px" } });
    const barsCard = card({ title: "Recent Throughput", iconName: "bar-chart" }, [this.barsHost]);

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
      kpiStrip,
      h("div.grid.grid-3.section", null, [
        h("div", { style: { gridColumn: "span 2" } }, headCard),
        socketCard,
      ]),
      h("div.section", null, chartCard),
      h("div.section", null, barsCard),
      h("div.section", null, tableCard)
    );
    container.appendChild(view);

    this.sortKey = "rxBytesPerSec";
    this.sortDir = "desc";

    requestAnimationFrame(() => {
      this.bars = new StackedBars(this.barsHost, {
        stacked: true,
        maxBars: 48,
        series: [
          { key: "rx", label: "Download", color: cssVar("--series-net-rx") },
          { key: "tx", label: "Upload", color: cssVar("--series-net-tx") },
        ],
        valueFormat: (v) => fmtRate(v),
      });
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
    if (this.bars) {
      const rx = hist.netRx.slice(-48);
      const tx = hist.netTx.slice(-48);
      const bt = hist.t.slice(-48);
      this.bars.setData(rx.map((v, i) => ({ t: bt[i], values: { rx: v || 0, tx: tx[i] || 0 } })));
    }
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

    // KPI strip.
    const ifaces = net.interfaces || [];
    const upCount = ifaces.filter((i) => i.isUp).length;
    this._kpis.down.update({ value: rx.value, sub: rx.unit + "/s" });
    this._kpis.down.el.querySelector(".kpi-unit").textContent = rx.unit + "/s";
    this._kpis.up.update({ value: tx.value, sub: tx.unit + "/s" });
    this._kpis.up.el.querySelector(".kpi-unit").textContent = tx.unit + "/s";
    this._kpis.conns.update({ value: fmtNum(net.tcpConnections), sub: fmtNum(net.udpConnections) + " UDP" });
    this._kpis.listen.update({ value: fmtNum(net.tcpListening) });
    this._kpis.ifaces.update({ value: upCount + " / " + ifaces.length });

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
    if (this.bars) this.bars.destroy();
    if (this.chart) this.chart.destroy();
  }
}

export default NetworkView;
