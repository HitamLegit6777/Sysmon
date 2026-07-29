//! Advanced data table: sortable, filterable, column configuration, sticky
//! header, optional virtualization for large row sets, row selection, and
//! per-row context actions. Renders efficiently by reconciling row nodes.
import { h, iconEl, escapeHtml } from "../util.js";

export const DATATABLE_VERSION = "1.0.0";

/**
 * Column spec:
 *   { key, label, align, width, sortable, format(value,row), render(row)->Node,
 *     className(row), sortValue(row), hidden, sparkline }
 *
 * Options:
 *   { columns, rowKey(row)->id, searchable, searchKeys, pageSize, virtual,
 *     rowHeight, striped, dense, onRowClick, emptyText, defaultSort }
 */
export class DataTable2 {
  constructor(opts = {}) {
    this.columns = (opts.columns || []).map((c) => ({ ...c }));
    this.rowKey = opts.rowKey || ((r, i) => (r.id != null ? r.id : i));
    this.searchable = opts.searchable || false;
    this.searchKeys = opts.searchKeys || null;
    this.virtual = !!opts.virtual;
    this.rowHeight = opts.rowHeight || 40;
    this.dense = !!opts.dense;
    this.striped = opts.striped !== false;
    this.onRowClick = opts.onRowClick || null;
    this.onRowContext = opts.onRowContext || null;
    this.emptyText = opts.emptyText || "No data";
    this.pageSize = opts.pageSize || 0; // 0 = no paging
    this.page = 0;
    this.sortKey = (opts.defaultSort && opts.defaultSort.key) || null;
    this.sortDir = (opts.defaultSort && opts.defaultSort.dir) || "desc";
    this.filterText = "";
    this.rows = [];
    this.filtered = [];
    this._rowNodes = new Map();
    this._build();
  }

  _build() {
    this.head = h("thead.dt2-head");
    this.body = h("tbody.dt2-body");
    this.table = h(
      `table.dt2${this.dense ? ".dt2--dense" : ""}${this.striped ? ".dt2--striped" : ""}`,
      null,
      [this.head, this.body]
    );
    this.scroller = h("div.dt2-scroller", null, [this.table]);
    this.footer = h("div.dt2-footer");
    this.el = h("div.dt2-wrap", null, [
      this.searchable ? this._buildToolbar() : null,
      this.scroller,
      this.pageSize ? this.footer : null,
    ]);
    this._buildHead();
    if (this.virtual) {
      this.scroller.addEventListener("scroll", () => this._renderVirtual());
    }
  }

  _buildToolbar() {
    const input = h("input.dt2-search", {
      type: "search",
      placeholder: "Filter…",
      oninput: (e) => {
        this.filterText = e.target.value.toLowerCase();
        this.page = 0;
        this._apply();
      },
    });
    this._searchInput = input;
    this.countLabel = h("span.dt2-count");
    return h("div.dt2-toolbar", null, [
      h("span.dt2-search-wrap", null, [iconEl("search", 15), input]),
      this.countLabel,
    ]);
  }

  _buildHead() {
    const tr = h("tr");
    this.columns.forEach((col) => {
      if (col.hidden) return;
      const sortable = col.sortable !== false && col.sortable !== undefined ? true : !!col.sortable;
      const th = h(
        `th.dt2-th${col.align ? ".is-" + col.align : ""}${sortable ? ".is-sortable" : ""}`,
        {
          style: col.width ? { width: col.width } : null,
          onClick: sortable ? () => this._toggleSort(col.key) : null,
        },
        [
          h("span.dt2-th-label", { text: col.label }),
          sortable ? h("span.dt2-sort-ind") : null,
        ]
      );
      col._th = th;
      tr.appendChild(th);
    });
    this.head.replaceChildren(tr);
    this._paintSortIndicators();
  }

  _paintSortIndicators() {
    this.columns.forEach((col) => {
      if (!col._th) return;
      const ind = col._th.querySelector(".dt2-sort-ind");
      if (!ind) return;
      if (col.key === this.sortKey) {
        col._th.classList.add("is-sorted");
        ind.innerHTML = this.sortDir === "asc" ? "▲" : "▼";
      } else {
        col._th.classList.remove("is-sorted");
        ind.innerHTML = "";
      }
    });
  }

  _toggleSort(key) {
    if (this.sortKey === key) {
      this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
    } else {
      this.sortKey = key;
      this.sortDir = "desc";
    }
    this._apply();
    this._paintSortIndicators();
  }

  setData(rows) {
    this.rows = rows || [];
    this._apply();
  }

  _apply() {
    let out = this.rows;
    if (this.filterText) {
      const keys = this.searchKeys || this.columns.map((c) => c.key);
      out = out.filter((r) =>
        keys.some((k) => {
          const v = r[k];
          return v != null && String(v).toLowerCase().includes(this.filterText);
        })
      );
    }
    if (this.sortKey) {
      const col = this.columns.find((c) => c.key === this.sortKey);
      const getv = col && col.sortValue ? col.sortValue : (r) => r[this.sortKey];
      const dir = this.sortDir === "asc" ? 1 : -1;
      out = out.slice().sort((a, b) => {
        const va = getv(a);
        const vb = getv(b);
        if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
        return String(va).localeCompare(String(vb)) * dir;
      });
    }
    this.filtered = out;
    if (this.countLabel) {
      this.countLabel.textContent = `${out.length} of ${this.rows.length}`;
    }
    this._render();
  }

  _pageSlice() {
    if (!this.pageSize) return this.filtered;
    const start = this.page * this.pageSize;
    return this.filtered.slice(start, start + this.pageSize);
  }

  _render() {
    if (this.virtual) {
      this._renderVirtual(true);
    } else {
      this._renderRows(this._pageSlice());
    }
    if (this.pageSize) this._renderPager();
  }

  _renderRows(rows) {
    if (!rows.length) {
      this.body.replaceChildren(
        h("tr.dt2-empty-row", null, [
          h("td.dt2-empty", { colspan: this.visibleColCount() }, [
            iconEl("info", 22),
            h("span", { text: this.emptyText }),
          ]),
        ])
      );
      this._rowNodes.clear();
      return;
    }
    // reconcile by key
    const seen = new Set();
    const frag = document.createDocumentFragment();
    rows.forEach((row, i) => {
      const key = this.rowKey(row, i);
      seen.add(key);
      let tr = this._rowNodes.get(key);
      if (!tr) {
        tr = this._buildRow(row, i);
        this._rowNodes.set(key, tr);
      } else {
        this._updateRow(tr, row, i);
      }
      frag.appendChild(tr);
    });
    // drop stale
    for (const [key, node] of this._rowNodes) {
      if (!seen.has(key)) {
        this._rowNodes.delete(key);
        if (node.parentNode) node.parentNode.removeChild(node);
      }
    }
    this.body.replaceChildren(frag);
  }

  _renderVirtual(reset = false) {
    const rows = this.filtered;
    const total = rows.length;
    const vh = this.scroller.clientHeight || 400;
    const scrollTop = this.scroller.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / this.rowHeight) - 4);
    const visible = Math.ceil(vh / this.rowHeight) + 8;
    const end = Math.min(total, start + visible);

    if (!total) {
      this.body.replaceChildren(
        h("tr.dt2-empty-row", null, [
          h("td.dt2-empty", { colspan: this.visibleColCount() }, this.emptyText),
        ])
      );
      return;
    }
    const padTop = start * this.rowHeight;
    const padBottom = (total - end) * this.rowHeight;
    const frag = document.createDocumentFragment();
    frag.appendChild(
      h("tr.dt2-spacer", { style: { height: padTop + "px" } })
    );
    for (let i = start; i < end; i++) {
      frag.appendChild(this._buildRow(rows[i], i));
    }
    frag.appendChild(
      h("tr.dt2-spacer", { style: { height: padBottom + "px" } })
    );
    this.body.replaceChildren(frag);
  }

  _buildRow(row, i) {
    const tr = h("tr.dt2-row");
    if (this.virtual) tr.style.height = this.rowHeight + "px";
    this.columns.forEach((col) => {
      if (col.hidden) return;
      tr.appendChild(this._buildCell(col, row));
    });
    if (this.onRowClick) {
      tr.classList.add("is-clickable");
      tr.addEventListener("click", () => this.onRowClick(row));
    }
    if (this.onRowContext) {
      tr.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.onRowContext(row, e);
      });
    }
    tr._row = row;
    return tr;
  }

  _updateRow(tr, row) {
    tr._row = row;
    let ci = 0;
    this.columns.forEach((col) => {
      if (col.hidden) return;
      const td = tr.children[ci++];
      if (!td) return;
      this._fillCell(td, col, row);
    });
  }

  _buildCell(col, row) {
    const td = h(`td.dt2-td${col.align ? ".is-" + col.align : ""}`);
    if (col.className) {
      const cn = col.className(row);
      if (cn) td.classList.add(cn);
    }
    this._fillCell(td, col, row);
    return td;
  }

  _fillCell(td, col, row) {
    if (col.render) {
      const node = col.render(row);
      td.replaceChildren();
      if (node instanceof Node) td.appendChild(node);
      else if (node != null) td.textContent = String(node);
      return;
    }
    const raw = row[col.key];
    const text = col.format ? col.format(raw, row) : raw == null ? "" : String(raw);
    if (td.textContent !== text) td.textContent = text;
    // dynamic class refresh
    if (col.className) {
      const cn = col.className(row);
      td.className = `dt2-td${col.align ? " is-" + col.align : ""}${cn ? " " + cn : ""}`;
    }
  }

  visibleColCount() {
    return this.columns.filter((c) => !c.hidden).length;
  }

  _renderPager() {
    const pages = Math.max(1, Math.ceil(this.filtered.length / this.pageSize));
    if (this.page >= pages) this.page = pages - 1;
    const btn = (label, target, disabled, active) =>
      h(
        `button.dt2-page${active ? ".is-active" : ""}`,
        { disabled: disabled || false, onClick: () => { this.page = target; this._render(); } },
        label
      );
    const parts = [
      btn("‹", Math.max(0, this.page - 1), this.page === 0),
    ];
    const windowSize = 5;
    let from = Math.max(0, this.page - 2);
    let to = Math.min(pages, from + windowSize);
    from = Math.max(0, to - windowSize);
    for (let p = from; p < to; p++) {
      parts.push(btn(String(p + 1), p, false, p === this.page));
    }
    parts.push(btn("›", Math.min(pages - 1, this.page + 1), this.page >= pages - 1));
    this.footer.replaceChildren(
      h("div.dt2-pager", null, parts),
      h("span.dt2-pageinfo", {
        text: `Page ${this.page + 1} / ${pages} · ${this.filtered.length} rows`,
      })
    );
  }

  toggleColumn(key, hidden) {
    const col = this.columns.find((c) => c.key === key);
    if (!col) return;
    col.hidden = hidden != null ? hidden : !col.hidden;
    this._rowNodes.clear();
    this._buildHead();
    this._render();
  }

  focusSearch() {
    if (this._searchInput) this._searchInput.focus();
  }
}
