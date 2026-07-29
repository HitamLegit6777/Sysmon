/**
 * stackedbars.js
 * --------------
 * A stacked (or grouped) vertical bar chart with a hover column highlight and
 * tooltip callback. Good for showing composition over discrete time buckets
 * (e.g. network in/out per interval, per-core aggregates).
 */
import { cssVar, rgba, clamp } from "../util.js";

export class StackedBars {
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
    this.series = opts.series || []; // [{key,color,label}]
    this.grouped = !!opts.grouped;
    this.maxBars = opts.maxBars || 48;
    this.radius = opts.radius != null ? opts.radius : 2;
    this.gapRatio = opts.gapRatio != null ? opts.gapRatio : 0.3;
    this.yMax = opts.yMax;
    this.grid = opts.grid !== false;
    this.padding = opts.padding || { top: 8, right: 8, bottom: 18, left: 34 };
    this.data = []; // [{t, values:{key:v}}]
    this.hoverIndex = -1;
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
    this.data = points.slice(-this.maxBars);
    this.render();
  }

  push(point) {
    this.data.push(point);
    if (this.data.length > this.maxBars) this.data.shift();
    this.render();
  }

  _area() {
    const p = this.padding;
    return { x: p.left, y: p.top, w: this.cw - p.left - p.right, h: this.ch - p.top - p.bottom };
  }

  _max() {
    if (this.yMax != null) return this.yMax;
    let m = 0;
    for (const d of this.data) {
      if (this.grouped) {
        for (const s of this.series) m = Math.max(m, d.values[s.key] || 0);
      } else {
        let sum = 0;
        for (const s of this.series) sum += d.values[s.key] || 0;
        m = Math.max(m, sum);
      }
    }
    return m || 1;
  }

  render() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cw, this.ch);
    const area = this._area();
    const max = this._max();
    if (this.grid) this._grid(ctx, area, max);
    const n = this.data.length;
    if (!n) return;

    const slot = area.w / n;
    const barW = slot * (1 - this.gapRatio);
    const groupW = this.grouped ? barW / this.series.length : barW;

    for (let i = 0; i < n; i++) {
      const d = this.data[i];
      const x0 = area.x + i * slot + (slot - barW) / 2;
      if (this.grouped) {
        this.series.forEach((s, si) => {
          const v = d.values[s.key] || 0;
          const bh = (v / max) * area.h;
          const bx = x0 + si * groupW;
          this._bar(ctx, bx, area.y + area.h - bh, groupW - 1, bh, s.color, i === this.hoverIndex);
        });
      } else {
        let yBase = area.y + area.h;
        this.series.forEach((s) => {
          const v = d.values[s.key] || 0;
          const bh = (v / max) * area.h;
          this._bar(ctx, x0, yBase - bh, barW, bh, s.color, i === this.hoverIndex);
          yBase -= bh;
        });
      }
    }
  }

  _bar(ctx, x, y, w, hgt, color, hot) {
    if (hgt <= 0) return;
    ctx.fillStyle = hot ? color : rgba(color || cssVar("--accent"), 0.85);
    const r = Math.min(this.radius, w / 2, hgt / 2);
    ctx.beginPath();
    ctx.moveTo(x, y + hgt);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + hgt);
    ctx.closePath();
    ctx.fill();
  }

  _grid(ctx, area, max) {
    ctx.strokeStyle = rgba(cssVar("--border") || "#2a2f3a", 0.5);
    ctx.fillStyle = cssVar("--text-dim") || "#8b93a7";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const y = area.y + (i / steps) * area.h;
      ctx.beginPath();
      ctx.moveTo(area.x, y + 0.5);
      ctx.lineTo(area.x + area.w, y + 0.5);
      ctx.stroke();
      const val = max - (i / steps) * max;
      ctx.fillText(this.opts.formatY ? this.opts.formatY(val) : this._fmt(val), area.x - 6, y);
    }
  }

  _fmt(v) {
    if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + "k";
    return v.toFixed(v < 10 ? 1 : 0);
  }

  _bindHover() {
    const move = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const area = this._area();
      const n = this.data.length;
      if (!n || x < area.x || x > area.x + area.w) {
        this._setHover(-1, e);
        return;
      }
      const slot = area.w / n;
      const idx = clamp(Math.floor((x - area.x) / slot), 0, n - 1);
      this._setHover(idx, e);
    };
    this.canvas.addEventListener("mousemove", move);
    this.canvas.addEventListener("mouseleave", (e) => this._setHover(-1, e));
  }

  _setHover(idx, e) {
    if (this.hoverIndex !== idx) {
      this.hoverIndex = idx;
      this.render();
    }
    if (this.onHover) {
      this.onHover(
        idx >= 0
          ? { index: idx, point: this.data[idx], clientX: e.clientX, clientY: e.clientY }
          : null
      );
    }
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
  }
}
