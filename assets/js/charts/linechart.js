/**
 * linechart.js
 * ------------
 * A multi-series time-series line chart on canvas with smooth curves, gradient
 * area fills, grid lines, y-axis labels, an interactive crosshair, and a
 * tooltip. Designed for live updating: setData replaces series and redraws.
 * No external dependencies.
 *
 * Series shape: { key, label, color, values: number[], fill?: bool, area?: bool }
 * The x axis is index-based over a shared timestamps array.
 */

import { cssVar, rgba, clamp, fmtClock } from "../util.js";

export class LineChart {
  /**
   * @param {HTMLElement} container element that will hold the canvas
   * @param {object} opts
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.series = [];
    this.timestamps = [];
    this.yMin = opts.yMin;
    this.yMax = opts.yMax;
    this.ySuffix = opts.ySuffix || "";
    this.yFormat = opts.yFormat || ((v) => String(Math.round(v)));
    this.tooltipFormat = opts.tooltipFormat || this.yFormat;
    this.gridLines = opts.gridLines ?? 4;
    this.padding = Object.assign(
      { top: 12, right: 14, bottom: 22, left: 46 },
      opts.padding || {}
    );
    this.hoverIndex = -1;
    this.disabledSeries = new Set();
    this.animT = 1;

    this._buildDom();
    this._bindEvents();
    this.dpr = window.devicePixelRatio || 1;
    this._resize();

    this._ro = new ResizeObserver(() => {
      this._resize();
      this.draw();
    });
    this._ro.observe(this.canvas);
  }

  _buildDom() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "chart-canvas";
    this.ctx = this.canvas.getContext("2d");

    this.crosshair = document.createElement("div");
    this.crosshair.className = "chart-crosshair";

    this.tooltip = document.createElement("div");
    this.tooltip.className = "tooltip";

    this.container.classList.add("chart");
    this.container.appendChild(this.canvas);
    this.container.appendChild(this.crosshair);
    document.getElementById("tooltip-root")?.appendChild(this.tooltip) ||
      this.container.appendChild(this.tooltip);
  }

  _bindEvents() {
    // Store bound handlers so destroy() can remove them cleanly.
    this._boundMove = (e) => this._onMove(e);
    this._boundLeave = () => this._onLeave();
    this.canvas.addEventListener("mousemove", this._boundMove);
    this.canvas.addEventListener("mouseleave", this._boundLeave);
  }

  /** Tear down observers, listeners, and detached DOM. Safe to call twice. */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    if (this.canvas) {
      this.canvas.removeEventListener("mousemove", this._boundMove);
      this.canvas.removeEventListener("mouseleave", this._boundLeave);
    }
    // The tooltip may live under #tooltip-root, so remove it explicitly.
    if (this.tooltip && this.tooltip.parentNode) {
      this.tooltip.parentNode.removeChild(this.tooltip);
    }
    if (this.crosshair && this.crosshair.parentNode) {
      this.crosshair.parentNode.removeChild(this.crosshair);
    }
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
    this.series = [];
    this.timestamps = [];
  }

  setData(timestamps, series) {
    this.timestamps = timestamps || [];
    this.series = series || [];
    this.draw();
  }

  updateSeriesValues(seriesValues, timestamps) {
    if (timestamps) this.timestamps = timestamps;
    for (const s of this.series) {
      if (seriesValues[s.key]) s.values = seriesValues[s.key];
    }
    this.draw();
  }

  toggleSeries(key) {
    if (this.disabledSeries.has(key)) this.disabledSeries.delete(key);
    else this.disabledSeries.add(key);
    this.draw();
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.w = w;
    this.h = h;
  }

  _computeBounds() {
    let min = this.yMin;
    let max = this.yMax;
    if (min === undefined || max === undefined) {
      let dMin = Infinity;
      let dMax = -Infinity;
      for (const s of this.series) {
        if (this.disabledSeries.has(s.key)) continue;
        for (const v of s.values) {
          if (v < dMin) dMin = v;
          if (v > dMax) dMax = v;
        }
      }
      if (dMin === Infinity) {
        dMin = 0;
        dMax = 1;
      }
      if (min === undefined) min = Math.min(0, dMin);
      if (max === undefined) {
        // Add 12% headroom and round to a nice number.
        max = dMax <= 0 ? 1 : dMax * 1.12;
      }
    }
    if (max - min < 1e-6) max = min + 1;
    return { min, max };
  }

  /** Map a data-space y value to a canvas pixel y (respects padding). */
  _plotY(v, min, max) {
    const top = this.padding.top;
    const h = this.h - this.padding.top - this.padding.bottom;
    const frac = (v - min) / (max - min);
    return top + (1 - frac) * h;
  }

  /** Map a series index to a canvas pixel x. */
  _plotX(i, n) {
    const left = this.padding.left;
    const w = this.w - this.padding.left - this.padding.right;
    if (n <= 1) return left + w;
    return left + (i / (n - 1)) * w;
  }

  /** Render the whole chart: grid, axis labels, area fills, series lines, hover. */
  draw() {
    const ctx = this.ctx;
    if (!ctx || !this.w || !this.h) return;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.w, this.h);

    const { min, max } = this._computeBounds();
    const left = this.padding.left;
    const right = this.w - this.padding.right;
    const top = this.padding.top;
    const bottom = this.h - this.padding.bottom;

    const gridColor = cssVar("--chart-grid") || "rgba(255,255,255,0.06)";
    const axisText = cssVar("--text-3") || "rgba(255,255,255,0.4)";

    // Horizontal grid lines + y labels.
    ctx.font = "10px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    ctx.lineWidth = 1;
    const lines = Math.max(1, this.gridLines);
    for (let g = 0; g <= lines; g++) {
      const val = min + ((max - min) * g) / lines;
      const y = this._plotY(val, min, max);
      ctx.strokeStyle = gridColor;
      ctx.beginPath();
      ctx.moveTo(left, Math.round(y) + 0.5);
      ctx.lineTo(right, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = axisText;
      ctx.fillText(this.yFormat(val) + this.ySuffix, left - 6, y);
    }

    const active = this.series.filter((s) => !this.disabledSeries.has(s.key));
    const n = this.timestamps.length;

    if (n >= 2) {
      for (const s of active) {
        const vals = s.values || [];
        const count = Math.min(vals.length, n);
        if (count < 2) continue;
        // Offset so the newest sample sits at the right edge when arrays differ.
        const off = n - count;

        // Area fill under the line.
        if (s.fill || s.area) {
          const grad = ctx.createLinearGradient(0, top, 0, bottom);
          grad.addColorStop(0, rgba(s.color, 0.28));
          grad.addColorStop(1, rgba(s.color, 0.02));
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.moveTo(this._plotX(off, n), bottom);
          for (let i = 0; i < count; i++) {
            ctx.lineTo(this._plotX(off + i, n), this._plotY(vals[i], min, max));
          }
          ctx.lineTo(this._plotX(off + count - 1, n), bottom);
          ctx.closePath();
          ctx.fill();
        }

        // Line stroke.
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.75;
        ctx.lineJoin = "round";
        ctx.beginPath();
        for (let i = 0; i < count; i++) {
          const x = this._plotX(off + i, n);
          const y = this._plotY(vals[i], min, max);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // Hover markers on the crosshair index.
      if (this.hoverIndex >= 0 && this.hoverIndex < n) {
        for (const s of active) {
          const vals = s.values || [];
          const count = Math.min(vals.length, n);
          const off = n - count;
          const localIdx = this.hoverIndex - off;
          if (localIdx < 0 || localIdx >= count) continue;
          const x = this._plotX(this.hoverIndex, n);
          const y = this._plotY(vals[localIdx], min, max);
          ctx.fillStyle = cssVar("--bg-1") || "#0e1116";
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    } else {
      ctx.fillStyle = axisText;
      ctx.textAlign = "center";
      ctx.fillText("collecting…", (left + right) / 2, (top + bottom) / 2);
    }

    ctx.restore();
  }

  /** Update crosshair + tooltip as the pointer moves over the plot. */
  _onMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const n = this.timestamps.length;
    const left = this.padding.left;
    const w = this.w - this.padding.left - this.padding.right;
    if (n < 2 || x < left || x > left + w) {
      this._onLeave();
      return;
    }
    const frac = (x - left) / w;
    const idx = Math.round(frac * (n - 1));
    if (idx === this.hoverIndex) return;
    this.hoverIndex = idx;

    // Position the crosshair line.
    if (this.crosshair) {
      const px = this._plotX(idx, n);
      this.crosshair.style.display = "block";
      this.crosshair.style.left = px + "px";
    }

    // Build tooltip content.
    if (this.tooltip) {
      const active = this.series.filter((s) => !this.disabledSeries.has(s.key));
      const rows = active
        .map((s) => {
          const vals = s.values || [];
          const count = Math.min(vals.length, n);
          const off = n - count;
          const li = idx - off;
          if (li < 0 || li >= count) return "";
          const val = this.tooltipFormat(vals[li]);
          return `<div class="tt-row"><span class="tt-dot" style="background:${s.color}"></span>` +
            `<span class="tt-label">${s.label || s.key}</span><span class="tt-val">${val}</span></div>`;
        })
        .join("");
      let head = "";
      const ts = this.timestamps[idx];
      if (ts) {
        const d = new Date(ts);
        head = `<div class="tt-head">${d.toLocaleTimeString()}</div>`;
      }
      this.tooltip.innerHTML = head + rows;
      this.tooltip.classList.add("visible");
      // Position tooltip near cursor but clamped to the viewport.
      const tw = this.tooltip.offsetWidth || 120;
      let tx = e.clientX + 14;
      if (tx + tw > window.innerWidth - 8) tx = e.clientX - tw - 14;
      this.tooltip.style.left = tx + "px";
      this.tooltip.style.top = e.clientY + 14 + "px";
    }
    this.draw();
  }

  /** Hide the crosshair + tooltip when the pointer leaves. */
  _onLeave() {
    if (this.hoverIndex === -1) return;
    this.hoverIndex = -1;
    if (this.crosshair) this.crosshair.style.display = "none";
    if (this.tooltip) this.tooltip.classList.remove("visible");
    this.draw();
  }
}

export default LineChart;
