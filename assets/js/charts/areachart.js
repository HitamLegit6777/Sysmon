/**
 * areachart.js
 * ------------
 * A smooth, gradient-filled area chart supporting one or more stacked or
 * overlaid series with an interactive crosshair + callback for tooltips.
 * Canvas-based, DPR-aware, animation-free for steady live updates.
 */
import { cssVar, rgba, clamp } from "../util.js";

export class AreaChart {
  constructor(target, opts = {}) {
    if (target && target.tagName === "CANVAS") {
      this.canvas = target;
    } else {
      this.canvas = document.createElement("canvas");
      this.canvas.className = "chart-canvas";
      target.appendChild(this.canvas);
    }
    this.ctx = this.canvas.getContext("2d");
    this.opts = opts;
    this.series = opts.series || []; // [{ key, color, label }]
    this.stacked = !!opts.stacked;
    this.maxPoints = opts.maxPoints || 120;
    this.yMin = opts.yMin;
    this.yMax = opts.yMax;
    this.smooth = opts.smooth !== false;
    this.grid = opts.grid !== false;
    this.fillAlpha = opts.fillAlpha != null ? opts.fillAlpha : 0.22;
    this.data = []; // array of { t, values: {key:number} }
    this.hoverIndex = -1;
    this.padding = opts.padding || { top: 8, right: 8, bottom: 18, left: 34 };
    this.onHover = opts.onHover || null;
    this.dpr = window.devicePixelRatio || 1;
    this._resize();
    this._ro = new ResizeObserver(() => {
      this._resize();
      this.render();
    });
    this._ro.observe(this.canvas);
    this._bindHover();
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.cw = Math.max(1, rect.width);
    this.ch = Math.max(1, rect.height || 160);
    this.canvas.width = Math.round(this.cw * this.dpr);
    this.canvas.height = Math.round(this.ch * this.dpr);
  }

  setData(points) {
    this.data = points.slice(-this.maxPoints);
    this.render();
  }

  push(point) {
    this.data.push(point);
    if (this.data.length > this.maxPoints) this.data.shift();
    this.render();
  }

  _plotArea() {
    const p = this.padding;
    return {
      x: p.left,
      y: p.top,
      w: this.cw - p.left - p.right,
      h: this.ch - p.top - p.bottom,
    };
  }

  _bounds() {
    let min = this.yMin != null ? this.yMin : Infinity;
    let max = this.yMax != null ? this.yMax : -Infinity;
    if (this.yMin != null && this.yMax != null) return { min, max };
    for (const d of this.data) {
      if (this.stacked) {
        let sum = 0;
        for (const s of this.series) sum += d.values[s.key] || 0;
        if (sum > max) max = sum;
        if (sum < min) min = sum;
      } else {
        for (const s of this.series) {
          const v = d.values[s.key] || 0;
          if (v > max) max = v;
          if (v < min) min = v;
        }
      }
    }
    if (!isFinite(min)) min = 0;
    if (!isFinite(max)) max = 1;
    if (min === max) max = min + 1;
    if (this.yMin != null) min = this.yMin;
    if (this.yMax != null) max = this.yMax;
    return { min, max };
  }

  render() {
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cw, this.ch);
    const area = this._plotArea();
    const { min, max } = this._bounds();
    const n = this.data.length;

    if (this.grid) this._drawGrid(ctx, area, min, max);
    if (n < 2) return;

    const xFor = (i) => area.x + (i / (n - 1)) * area.w;
    const yFor = (v) => area.y + area.h - ((v - min) / (max - min)) * area.h;

    // stacked baseline tracking
    const baseline = new Array(n).fill(area.y + area.h);
    const seriesOrder = this.stacked ? this.series : this.series;

    for (let si = 0; si < seriesOrder.length; si++) {
      const s = seriesOrder[si];
      const color = s.color || cssVar("--accent");
      const pts = [];
      for (let i = 0; i < n; i++) {
        let v = this.data[i].values[s.key] || 0;
        let yTop;
        if (this.stacked) {
          const prevBase = baseline[i];
          const vy = ((v) / (max - min)) * area.h;
          yTop = prevBase - vy;
          baseline[i] = yTop;
        } else {
          yTop = yFor(v);
        }
        pts.push([xFor(i), yTop]);
      }
      this._drawSeries(ctx, pts, color, area, this.stacked ? this._baselineCopy(baseline, pts) : null);
    }

    if (this.hoverIndex >= 0 && this.hoverIndex < n) {
      this._drawCrosshair(ctx, area, xFor(this.hoverIndex));
    }
  }

  _baselineCopy() {
    // For stacked fills we close down to the previous baseline; simplified to
    // fill to bottom for clarity and performance.
    return null;
  }

  _drawSeries(ctx, pts, color, area) {
    // fill
    ctx.beginPath();
    this._traceLine(ctx, pts);
    ctx.lineTo(pts[pts.length - 1][0], area.y + area.h);
    ctx.lineTo(pts[0][0], area.y + area.h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, area.y, 0, area.y + area.h);
    grad.addColorStop(0, rgba(color, this.fillAlpha + 0.12));
    grad.addColorStop(1, rgba(color, 0.02));
    ctx.fillStyle = grad;
    ctx.fill();
    // stroke
    ctx.beginPath();
    this._traceLine(ctx, pts);
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  _traceLine(ctx, pts) {
    if (!pts.length) return;
    ctx.moveTo(pts[0][0], pts[0][1]);
    if (!this.smooth || pts.length < 3) {
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      return;
    }
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const cx = (x0 + x1) / 2;
      ctx.bezierCurveTo(cx, y0, cx, y1, x1, y1);
    }
  }

  _drawGrid(ctx, area, min, max) {
    ctx.strokeStyle = rgba(cssVar("--border") || "#2a2f3a", 0.5);
    ctx.lineWidth = 1;
    ctx.fillStyle = cssVar("--text-dim") || "#8b93a7";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const y = area.y + (i / steps) * area.h;
      ctx.beginPath();
      ctx.moveTo(area.x, y + 0.5);
      ctx.lineTo(area.x + area.w, y + 0.5);
      ctx.stroke();
      const val = max - (i / steps) * (max - min);
      ctx.fillText(this._fmtY(val), area.x - 6, y);
    }
  }

  _fmtY(v) {
    if (this.opts.formatY) return this.opts.formatY(v);
    if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + "k";
    return v.toFixed(v < 10 ? 1 : 0);
  }

  _drawCrosshair(ctx, area, x) {
    ctx.save();
    ctx.strokeStyle = rgba(cssVar("--text") || "#e6e9ef", 0.35);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x + 0.5, area.y);
    ctx.lineTo(x + 0.5, area.y + area.h);
    ctx.stroke();
    ctx.restore();
  }

  _bindHover() {
    const move = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const area = this._plotArea();
      const n = this.data.length;
      if (n < 2 || x < area.x || x > area.x + area.w) {
        this.hoverIndex = -1;
        this.render();
        if (this.onHover) this.onHover(null);
        return;
      }
      const rel = (x - area.x) / area.w;
      const idx = Math.round(rel * (n - 1));
      this.hoverIndex = clamp(idx, 0, n - 1);
      this.render();
      if (this.onHover) {
        this.onHover({
          index: this.hoverIndex,
          point: this.data[this.hoverIndex],
          clientX: e.clientX,
          clientY: e.clientY,
        });
      }
    };
    this.canvas.addEventListener("mousemove", move);
    this.canvas.addEventListener("mouseleave", () => {
      this.hoverIndex = -1;
      this.render();
      if (this.onHover) this.onHover(null);
    });
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
  }
}
