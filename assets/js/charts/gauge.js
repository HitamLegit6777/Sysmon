/**
 * gauge.js
 * --------
 * A radial arc gauge for showing a single 0..100 percentage, with a colored
 * progress arc, a track, and a smoothly animated needle-free fill. Used for
 * headline CPU/memory readouts. Renders on canvas at device pixel ratio.
 */

import { cssVar, rgba, clamp, usageColor } from "../util.js";

export class Gauge {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts { min, max, startAngle, endAngle, thickness, color }
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
    this.min = opts.min ?? 0;
    this.max = opts.max ?? 100;
    // Default: 135deg sweep from lower-left to lower-right (a 270deg arc).
    this.startAngle = opts.startAngle ?? Math.PI * 0.75;
    this.endAngle = opts.endAngle ?? Math.PI * 2.25;
    this.thickness = opts.thickness ?? 14;
    this.autoColor = opts.autoColor !== false;
    this.color = opts.color || cssVar("--accent");
    this.value = 0;
    this.displayValue = 0;
    this.dpr = window.devicePixelRatio || 1;
    this._resize();
    this._animating = false;

    this._ro = new ResizeObserver(() => {
      this._resize();
      this._render(this.displayValue);
    });
    this._ro.observe(this.canvas);
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const size = Math.max(1, Math.min(rect.width, rect.height) || rect.width);
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round((rect.height || rect.width) * this.dpr);
    this.cw = rect.width;
    this.ch = rect.height || rect.width;
  }

  /** Set the target value and animate toward it. */
  set(value) {
    this.value = clamp(value, this.min, this.max);
    if (!this._animating) this._animate();
  }

  _animate() {
    this._animating = true;
    const step = () => {
      const diff = this.value - this.displayValue;
      if (Math.abs(diff) < 0.15) {
        this.displayValue = this.value;
        this._render(this.displayValue);
        this._animating = false;
        return;
      }
      this.displayValue += diff * 0.18;
      this._render(this.displayValue);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  _render(value) {
    const ctx = this.ctx;
    const { cw, ch, dpr } = this;
    if (!cw || !ch) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const cx = cw / 2;
    const cy = ch / 2;
    const radius = Math.min(cw, ch) / 2 - this.thickness / 2 - 2;
    const t = clamp((value - this.min) / (this.max - this.min), 0, 1);
    const angle = this.startAngle + t * (this.endAngle - this.startAngle);
    const color = this.autoColor ? usageColor(value) : this.color;

    // Track.
    ctx.beginPath();
    ctx.arc(cx, cy, radius, this.startAngle, this.endAngle);
    ctx.strokeStyle = cssVar("--bg-3") || "rgba(255,255,255,0.08)";
    ctx.lineWidth = this.thickness;
    ctx.lineCap = "round";
    ctx.stroke();

    // Progress arc with a subtle glow.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, this.startAngle, angle);
    ctx.strokeStyle = color;
    ctx.lineWidth = this.thickness;
    ctx.lineCap = "round";
    ctx.shadowColor = rgba(color, 0.5);
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.restore();

    // Tip dot.
    const tipX = cx + Math.cos(angle) * radius;
    const tipY = cy + Math.sin(angle) * radius;
    ctx.beginPath();
    ctx.arc(tipX, tipY, this.thickness / 2 - 1, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
  }
}

export default Gauge;
