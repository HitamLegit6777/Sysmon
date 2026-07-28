/**
 * table.js
 * --------
 * A sortable, efficiently-updating data table. Columns declare a key, label,
 * alignment, and an optional cell renderer. The table keeps its DOM rows and
 * reconciles them against new data on update() rather than rebuilding, which
 * keeps the process table smooth even at high refresh rates.
 */

import { h, iconEl } from "../util.js";

export class DataTable {
  /**
   * @param {object} opts
   *   columns: [{ key, label, align, sortable, render(row):Node|string, width }]
   *   sortKey, sortDir ('asc'|'desc'), rowKey(row):string, onSort(key,dir)
   */
  constructor(opts = {}) {
    this.columns = opts.columns || [];
    this.sortKey = opts.sortKey || null;
    this.sortDir = opts.sortDir || "desc";
    this.rowKey = opts.rowKey || ((r, i) => String(i));
    this.onSort = opts.onSort || null;
    this.emptyText = opts.emptyText || "No data";
    this.rows = new Map(); // key -> { tr, cells }
    this._build();
  }

  _build() {
    this.thead = h("thead");
    const tr = h("tr");
    for (const col of this.columns) {
      const th = h(
        "th" +
          (col.align === "right" || col.num ? ".num" : "") +
          (col.sortable !== false ? ".sortable" : ""),
        col.width ? { style: { width: col.width } } : null,
        [
          h("span", { text: col.label }),
          col.sortable !== false ? h("span.sort-arrow", { text: "" }) : null,
        ]
      );
      if (col.sortable !== false) {
        th.addEventListener("click", () => this._toggleSort(col.key));
      }
      th._col = col;
      tr.appendChild(th);
    }
    this.thead.appendChild(tr);
    this.tbody = h("tbody");
    this.table = h("table.data", null, [this.thead, this.tbody]);
    this.wrap = h("div.table-wrap", null, this.table);
    this._updateSortIndicators();
  }

  get el() {
    return this.wrap;
  }

  _toggleSort(key) {
    if (this.sortKey === key) {
      this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
    } else {
      this.sortKey = key;
      this.sortDir = "desc";
    }
    this._updateSortIndicators();
    if (this.onSort) this.onSort(this.sortKey, this.sortDir);
  }

  _updateSortIndicators() {
    for (const th of this.thead.querySelectorAll("th")) {
      const col = th._col;
      const arrow = th.querySelector(".sort-arrow");
      if (col && col.key === this.sortKey) {
        th.classList.add("sorted");
        if (arrow) arrow.textContent = this.sortDir === "asc" ? "▲" : "▼";
      } else {
        th.classList.remove("sorted");
        if (arrow) arrow.textContent = "";
      }
    }
  }

  setSort(key, dir) {
    this.sortKey = key;
    this.sortDir = dir;
    this._updateSortIndicators();
  }

  /**
   * Update the table with a fresh array of row objects. Rows are reconciled by
   * key: existing rows are updated in place, new rows created, stale rows
   * removed. Order follows the provided array.
   */
  update(data) {
    if (!data || data.length === 0) {
      this.tbody.replaceChildren(
        h("tr", null, h("td.empty", { colspan: this.columns.length }, [
          h("div.empty-state", null, [h("div.title", { text: this.emptyText })]),
        ]))
      );
      this.rows.clear();
      return;
    }

    const seen = new Set();
    let prevNode = null;

    data.forEach((row, index) => {
      const key = this.rowKey(row, index);
      seen.add(key);
      let entry = this.rows.get(key);

      if (!entry) {
        entry = this._createRow(row, key);
        this.rows.set(key, entry);
      } else {
        this._updateRow(entry, row);
      }

      // Ensure correct order without full rebuild.
      const tr = entry.tr;
      const expectedNext = prevNode ? prevNode.nextSibling : this.tbody.firstChild;
      if (expectedNext !== tr) {
        this.tbody.insertBefore(tr, prevNode ? prevNode.nextSibling : this.tbody.firstChild);
      }
      prevNode = tr;
    });

    // Remove stale rows.
    for (const [key, entry] of this.rows) {
      if (!seen.has(key)) {
        entry.tr.remove();
        this.rows.delete(key);
      }
    }
  }

  _createRow(row, key) {
    const tr = h("tr");
    const cells = [];
    for (const col of this.columns) {
      const td = h("td" + (col.align === "right" || col.num ? ".num" : ""));
      this._renderCell(td, col, row);
      cells.push({ td, col });
      tr.appendChild(td);
    }
    if (this._onRowClick) {
      tr.style.cursor = "pointer";
      tr.addEventListener("click", () => this._onRowClick(row));
    }
    return { tr, cells, key };
  }

  _updateRow(entry, row) {
    for (const cell of entry.cells) {
      this._renderCell(cell.td, cell.col, row);
    }
  }

  _renderCell(td, col, row) {
    if (col.render) {
      const out = col.render(row);
      if (out instanceof Node) {
        td.replaceChildren(out);
      } else {
        const str = String(out);
        if (td.textContent !== str) td.textContent = str;
      }
    } else {
      const value = row[col.key];
      const str = value == null ? "" : String(value);
      if (td.textContent !== str) td.textContent = str;
    }
  }

  onRowClick(fn) {
    this._onRowClick = fn;
  }
}

export default DataTable;
