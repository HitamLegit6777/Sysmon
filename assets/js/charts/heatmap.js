/**
 * heatmap.js
 * ----------
 * A per-core utilization heatmap. Each row is a CPU core and each column a
 * point in time; cell color encodes utilization (cool -> hot). Renders on a
 * single canvas for efficiency with many cores and samples.
 */

import { cssVar, clamp, mixColor } from "../util.js";

export class Heatmap {
  constructor(target, opts = {}) {
    // Accept either a <canvas> or a container element.
    if (target && target.tagName === "CANVAS") {
      this.canvas = target;
    } else {
      this.canvas = document.createElement("canvas");
      this.canvas.className = "chart-canvas";
      target.appendChild(this.canvas);
    }
    this.ctx = this.canvas.getContext("2d");
    this.rows = opts.rows || 0;
    this.gap = opts.gap ?? 2;
    this.data = []; // data[row] = number[] (0..100)
    this.dpr = window.devicePixelRatio || 1;
    this._resize();

    this._ro = new ResizeObserver(() => {
      this._resize();
      this.draw();
    });
    this._ro.observe(this.canvas);
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(Math.max(1, rect.width) * this.dpr);
    this.canvas.height = Math.round(Math.max(1, rect.height) * this.dpr);
    this.w = rect.width;
    this.h = rect.height;
  }

  setData(data) {
    this.data = data || [];
    this.rows = this.data.length;
    this.draw();
  }

  _colorFor(value) {
    // cool blue -> teal -> amber -> red
    const v = clamp(value, 0, 100);
    if (v < 33) return mixColor("#1a2336", "#3ad29f", v / 33);
    if (v < 66) return mixColor("#3ad29f", "#f5b342", (v - 33) / 33);
    return mixColor("#f5b342", "#ff5c7a", (v - 66) / 34);
  }

  draw() {
    const ctx = this.ctx;
    const { w, h, dpr } = this;
    if (!w || !h) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const rows = this.data.length;
    if (rows === 0) return;
    const cols = Math.max(...this.data.map((r) => r.length), 1);
    const cellH = (h - this.gap * (rows - 1)) / rows;
    const cellW = (w - this.gap * (cols - 1)) / cols;

    for (let r = 0; r < rows; r++) {
      const row = this.data[r];
      for (let c = 0; c < row.length; c++) {
        const value = row[c];
        const x = c * (cellW + this.gap);
        const y = r * (cellH + this.gap);
        ctx.fillStyle = this._colorFor(value);
        ctx.fillRect(x, y, Math.ceil(cellW), Math.ceil(cellH));
      }
    }
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
  }
}

export default Heatmap;
