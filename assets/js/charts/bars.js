/**
 * bars.js
 * -------
 * A lightweight horizontal or vertical bar chart on canvas for categorical
 * breakdowns (per-core CPU, per-filesystem usage, per-interface throughput).
 * Values animate toward their targets for a lively feel.
 */

import { cssVar, rgba, clamp, usageColor } from "../util.js";

export class Bars {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts { orientation:'vertical'|'horizontal', max, autoColor, color, gap }
   */
  constructor(target, opts = {}) {
    // Accept either a <canvas> or a container element (create our own canvas).
    if (target && target.tagName === "CANVAS") {
      this.canvas = target;
    } else {
      this.canvas = document.createElement("canvas");
      this.canvas.className = "chart-canvas";
      target.appendChild(this.canvas);
    }
    this.ctx = this.canvas.getContext("2d");
    this.orientation = opts.orientation || "vertical";
    this.max = opts.max;
    this.autoColor = opts.autoColor || false;
    this.color = opts.color || cssVar("--accent");
    this.gap = opts.gap ?? 4;
    this.radius = opts.radius ?? 3;
    this.data = []; // [{ label, value }]
    this.display = [];
    this.dpr = window.devicePixelRatio || 1;
    this._resize();
    this._animating = false;

    this._ro = new ResizeObserver(() => {
      this._resize();
      this._render();
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
    if (this.display.length !== this.data.length) {
      this.display = this.data.map((d) => d.value);
    }
    if (!this._animating) this._animate();
  }

  _animate() {
    this._animating = true;
    const step = () => {
      let moving = false;
      for (let i = 0; i < this.data.length; i++) {
        const target = this.data[i].value;
        const cur = this.display[i] ?? target;
        const diff = target - cur;
        if (Math.abs(diff) > 0.2) {
          this.display[i] = cur + diff * 0.2;
          moving = true;
        } else {
          this.display[i] = target;
        }
      }
      this._render();
      if (moving) requestAnimationFrame(step);
      else this._animating = false;
    };
    requestAnimationFrame(step);
  }

  _maxValue() {
    if (this.max !== undefined) return this.max;
    let m = 0;
    for (const d of this.data) if (d.value > m) m = d.value;
    return m <= 0 ? 1 : m;
  }

  _render() {
    const ctx = this.ctx;
    const { w, h, dpr } = this;
    if (!w || !h) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const n = this.data.length;
    if (n === 0) return;
    const max = this._maxValue();

    if (this.orientation === "vertical") {
      const barW = (w - this.gap * (n - 1)) / n;
      for (let i = 0; i < n; i++) {
        const v = this.display[i] ?? 0;
        const t = clamp(v / max, 0, 1);
        const barH = t * h;
        const x = i * (barW + this.gap);
        const y = h - barH;
        const color = this.autoColor ? usageColor(v) : this.color;
        this._roundRect(ctx, x, y, barW, barH, this.radius);
        const grad = ctx.createLinearGradient(0, y, 0, h);
        grad.addColorStop(0, color);
        grad.addColorStop(1, rgba(color, 0.5));
        ctx.fillStyle = grad;
        ctx.fill();
      }
    } else {
      const barH = (h - this.gap * (n - 1)) / n;
      for (let i = 0; i < n; i++) {
        const v = this.display[i] ?? 0;
        const t = clamp(v / max, 0, 1);
        const barW = t * w;
        const y = i * (barH + this.gap);
        const color = this.autoColor ? usageColor(v) : this.color;
        // Track.
        this._roundRect(ctx, 0, y, w, barH, this.radius);
        ctx.fillStyle = cssVar("--bg-3") || "rgba(255,255,255,0.06)";
        ctx.fill();
        // Value.
        this._roundRect(ctx, 0, y, Math.max(barW, this.radius * 2), barH, this.radius);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
  }

  _roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
  }
}

export default Bars;
