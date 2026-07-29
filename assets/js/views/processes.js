/**
 * processes.js
 * ------------
 * The processes view: summary counters (total/running/sleeping/zombie),
 * a search box, and a sortable, filterable, live-updating process table with
 * CPU%, memory, RSS, threads, user, and command. The table reconciles rows so
 * sorting stays smooth as values change.
 */

import {
  h,
  icon,
  fmtBytes,
  fmtPct,
  fmtNum,
  cssVar,
  usageColor,
  truncate,
  debounce,
} from "../util.js";
import store from "../store.js";
import { card, badge } from "../components/card.js";
import { DataTable } from "../components/table.js";
import { drawer } from "../components/primitives.js";
import { attachContextMenu, contextMenu } from "../components/tooltip.js";
import { statGrid, pill, progressBar } from "../components/widgets.js";
import { fmtBytes as _fmtBytes } from "../util.js";

export class ProcessesView {
  constructor() {
    this._unsubs = [];
    this.filter = "";
    this.sortKey = "cpuPercent";
    this.sortDir = "desc";
  }

  mount(container) {
    const view = h("div.view");

    // Summary counters.
    this.counts = {
      total: h("span.cell-strong", { text: "0" }),
      running: h("span.cell-strong", { text: "0" }),
      sleeping: h("span.cell-strong", { text: "0" }),
      threads: h("span.cell-strong", { text: "0" }),
      zombie: h("span.cell-strong", { text: "0" }),
    };
    const summary = h("div.card.row.gap-4.wrap", { style: { padding: "14px 20px" } }, [
      counter("processes", "Total", this.counts.total),
      counter("activity", "Running", this.counts.running, cssVar("--success")),
      counter("clock", "Sleeping", this.counts.sleeping, cssVar("--info")),
      counter("layers", "Threads", this.counts.threads, cssVar("--series-mem")),
      counter("alerts", "Zombie", this.counts.zombie, cssVar("--danger")),
    ]);

    // Search box.
    const searchInput = h("input", {
      type: "text",
      placeholder: "Filter by name, user, or PID…",
      oninput: debounce((e) => {
        this.filter = e.target.value.trim().toLowerCase();
        this._updateTable();
      }, 150),
    });
    const searchBar = h("div.row-between.section", null, [
      h("div.search", null, [h("span", { html: icon("search", 16) }), searchInput]),
      h("div.muted.mono", { text: "" }),
    ]);
    this.resultCount = searchBar.querySelector(".muted");

    // Table.
    this.table = new DataTable({
      columns: [
        { key: "pid", label: "PID", num: true, width: "70px", render: (r) => h("span.mono.text-3", { text: String(r.pid) }) },
        {
          key: "name",
          label: "Name",
          render: (r) =>
            h("div.col", { style: { minWidth: 0 } }, [
              h("span.cell-strong.truncate", { text: r.name }),
              h("span.text-3.truncate", { text: truncate(r.cmdline, 60), style: { fontSize: "11px" } }),
            ]),
        },
        {
          key: "cpuPercent",
          label: "CPU%",
          num: true,
          render: (r) => h("span.mono", { text: fmtPct(r.cpuPercent, 1), style: { color: usageColor(r.cpuPercent) } }),
        },
        {
          key: "memPercent",
          label: "MEM%",
          num: true,
          render: (r) => h("span.mono", { text: fmtPct(r.memPercent, 1) }),
        },
        { key: "rssBytes", label: "RSS", num: true, render: (r) => fmtBytes(r.rssBytes) },
        { key: "threads", label: "Thr", num: true, render: (r) => String(r.threads) },
        { key: "user", label: "User", render: (r) => h("span.text-2", { text: r.user }) },
        {
          key: "state",
          label: "State",
          render: (r) => badge(r.state, stateKind(r.state), true),
        },
      ],
      sortKey: this.sortKey,
      sortDir: this.sortDir,
      rowKey: (r) => String(r.pid),
      emptyText: "No matching processes",
      onSort: (key, dir) => {
        this.sortKey = key;
        this.sortDir = dir;
        this._updateTable();
      },
    });
    const tableCard = card({ title: "Process Table", iconName: "processes" }, [this.table.el]);

    view.append(
      h("div.section", null, summary),
      searchBar,
      h("div.section", null, tableCard)
    );
    container.appendChild(view);

    // Click a row to open a detail drawer; right-click for quick actions.
    this.table.onRowClick((row) => this._openDetail(row));
    attachContextMenu(this.table.el, (e) => {
      const tr = e.target.closest("tr[data-rowkey], tr");
      const pidText = tr && tr.querySelector("td");
      const row = this._rowFromEvent(e);
      if (!row) return [];
      return [
        { header: row.name + " (" + row.pid + ")" },
        { label: "View details", icon: "info", onClick: () => this._openDetail(row) },
        { label: "Copy PID", icon: "layers", onClick: () => navigator.clipboard && navigator.clipboard.writeText(String(row.pid)) },
        { label: "Copy command", icon: "processes", onClick: () => navigator.clipboard && navigator.clipboard.writeText(row.cmdline || row.name) },
      ];
    });

    this._unsubs.push(store.on("processes", () => this._refresh()));
    this._refresh();

    // Ask the server for a fresh process table right away.
    import("../ws.js").then((m) => m.default.requestProcesses());
  }

  _refresh() {
    const procs = store.get().processes;
    if (!procs) return;
    this.counts.total.textContent = fmtNum(procs.total);
    this.counts.running.textContent = fmtNum(procs.running);
    this.counts.sleeping.textContent = fmtNum(procs.sleeping);
    this.counts.threads.textContent = fmtNum(procs.totalThreads);
    this.counts.zombie.textContent = fmtNum(procs.zombie);
    this._updateTable();
  }

  _rowFromEvent(e) {
    const procs = store.get().processes;
    if (!procs || !procs.processes) return null;
    const tr = e.target.closest("tr");
    if (!tr) return null;
    // find the pid cell (first numeric-looking cell)
    const cells = tr.querySelectorAll("td");
    for (const c of cells) {
      const n = parseInt(c.textContent, 10);
      if (!Number.isNaN(n)) {
        const found = procs.processes.find((p) => p.pid === n);
        if (found) return found;
      }
    }
    return null;
  }

  _openDetail(row) {
    if (!row) return;
    const stateLabel = { R: "Running", S: "Sleeping", D: "Uninterruptible", Z: "Zombie", T: "Stopped", I: "Idle" };
    const cpuBar = progressBar({ label: "CPU", value: row.cpuPercent, max: 100, right: fmtPct(row.cpuPercent, 1) });
    const memBar = progressBar({ label: "Memory", value: row.memPercent, max: 100, right: fmtPct(row.memPercent, 1) });
    const grid = statGrid(
      [
        { label: "PID", value: row.pid },
        { label: "Parent PID", value: row.ppid },
        { label: "User", value: row.user },
        { label: "State", value: (stateLabel[row.state] || row.state) },
        { label: "Threads", value: row.threads },
        { label: "Open FDs", value: row.numFds },
        { label: "Priority", value: row.priority },
        { label: "Nice", value: row.nice },
        { label: "RSS", value: _fmtBytes(row.rssBytes) },
        { label: "Virtual", value: _fmtBytes(row.vsizeBytes) },
        { label: "Read", value: _fmtBytes(row.readBytes) },
        { label: "Written", value: _fmtBytes(row.writeBytes) },
      ],
      { cols: 2 }
    );
    const body = h("div.proc-detail", null, [
      h("div.proc-detail-bars", null, [cpuBar.el, memBar.el]),
      grid,
      h("div.proc-cmd-block", null, [
        h("div.proc-cmd-label", { text: "Command line" }),
        h("code.proc-cmd", { text: row.cmdline || row.name }),
      ]),
    ]);
    const dlg = drawer({
      title: row.name,
      subtitle: "PID " + row.pid + " · " + row.user,
      icon: "processes",
      side: "right",
      width: "460px",
      body,
    });
    dlg.open();
  }

  _updateTable() {
    const procs = store.get().processes;
    if (!procs || !procs.processes) return;
    let list = procs.processes;

    if (this.filter) {
      const f = this.filter;
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(f) ||
          p.user.toLowerCase().includes(f) ||
          String(p.pid).includes(f) ||
          (p.cmdline && p.cmdline.toLowerCase().includes(f))
      );
    }

    const key = this.sortKey;
    const dir = this.sortDir === "asc" ? 1 : -1;
    list = list.slice().sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (typeof av === "string") return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });

    const shown = list.slice(0, 200);
    this.table.update(shown);
    if (this.resultCount) {
      this.resultCount.textContent = `${shown.length} of ${procs.total} processes`;
    }
  }

  update() {}

  unmount() {
    for (const u of this._unsubs) u();
    this._unsubs = [];
  }
}

function counter(iconName, label, valueEl, color) {
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

function stateKind(state) {
  if (state === "running") return "success";
  if (state === "zombie" || state === "dead") return "danger";
  if (state === "stopped" || state === "tracing-stop") return "warning";
  return "neutral";
}

export default ProcessesView;
