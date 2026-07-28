/**
 * sparkline.js
 * ------------
 * A tiny, dependency-free canvas sparkline used inside stat tiles. It draws a
 * smooth area line for a single numeric series and is optimized for frequent
 * updates: it caches its device-pixel-ratio sizing and only redraws on demand.
 */

import { cssVar, rgba, clamp } from "../util.js";

export class Sparkline {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts { color, fill, min, max, lineWidth }
   */
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
    this.color = opts.color || cssVar("--accent") || "#5b8cff";
    this.fill = opts.fill !== false;
    this.min = opts.min;
    this.max = opts.max;
    this.lineWidth = opts.lineWidth || 2;
    this.data = [];
    this.dpr = window.devicePixelRatio || 1;
    this._resize();
    this._ro = new ResizeObserver(() => {
      this._resize();
      this.draw();
    });
    this._ro.observe(this.canvas);
  }

  setColor(color) {
    this.color = color;
  }

  setData(data) {
    this.data = data || [];
    this.draw();
  }

  push(value) {
    this.data.push(value);
    if (this.data.length > 240) this.data.shift();
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

  draw() {
    const ctx = this.ctx;
    const { w, h, dpr } = this;
    if (!w || !h) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const data = this.data;
    if (data.length < 2) return;

    let min = this.min;
    let max = this.max;
    if (min === undefined || max === undefined) {
      min = Infinity;
      max = -Infinity;
      for (const v of data) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (max - min < 1e-6) {
      max = min + 1;
    }

    const pad = this.lineWidth;
    const range = max - min;
    const n = data.length;
    const dx = (w - pad * 2) / (n - 1);
    const yOf = (v) => {
      const t = (v - min) / range;
      return h - pad - clamp(t, 0, 1) * (h - pad * 2);
    };
    const xOf = (i) => pad + i * dx;

    // Build a smooth path using midpoint quadratic curves.
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(data[0]));
    for (let i = 1; i < n; i++) {
      const x0 = xOf(i - 1);
      const y0 = yOf(data[i - 1]);
      const x1 = xOf(i);
      const y1 = yOf(data[i]);
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      ctx.quadraticCurveTo(x0, y0, mx, my);
    }
    ctx.lineTo(xOf(n - 1), yOf(data[n - 1]));

    if (this.fill) {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, rgba(this.color, 0.28));
      grad.addColorStop(1, rgba(this.color, 0.0));
      ctx.save();
      ctx.lineTo(xOf(n - 1), h);
      ctx.lineTo(xOf(0), h);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();

      // Redraw the stroke path since we closed it for the fill.
      ctx.beginPath();
      ctx.moveTo(xOf(0), yOf(data[0]));
      for (let i = 1; i < n; i++) {
        const x0 = xOf(i - 1);
        const y0 = yOf(data[i - 1]);
        const x1 = xOf(i);
        const y1 = yOf(data[i]);
        const mx = (x0 + x1) / 2;
        const my = (y0 + y1) / 2;
        ctx.quadraticCurveTo(x0, y0, mx, my);
      }
      ctx.lineTo(xOf(n - 1), yOf(data[n - 1]));
    }

    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.lineWidth;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    // Endpoint dot.
    ctx.beginPath();
    ctx.arc(xOf(n - 1), yOf(data[n - 1]), this.lineWidth + 0.5, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
  }
}

export default Sparkline;
