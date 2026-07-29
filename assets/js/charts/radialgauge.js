/**
 * radialgauge.js
 * --------------
 * An upgraded radial gauge with graduated tick marks, a colored value arc, a
 * threshold marker, and a large center readout. Suitable for headline metrics
 * where more context than a plain gauge is desired.
 */
import { cssVar, rgba, clamp, usageColor } from "../util.js";

export class RadialGauge {
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
    this.min = opts.min != null ? opts.min : 0;
    this.max = opts.max != null ? opts.max : 100;
    this.start = opts.startAngle != null ? opts.startAngle : Math.PI * 0.75;
    this.end = opts.endAngle != null ? opts.endAngle : Math.PI * 2.25;
    this.thickness = opts.thickness || 12;
    this.ticks = opts.ticks != null ? opts.ticks : 10;
    this.threshold = opts.threshold; // optional marker value
    this.autoColor = opts.autoColor !== false;
    this.color = opts.color || cssVar("--accent");
    this.unit = opts.unit || "";
    this.label = opts.label || "";
    this.value = 0;
    this.display = 0;
    this.dpr = window.devicePixelRatio || 1;
    this._resize();
    this._raf = null;
    this._ro = new ResizeObserver(() => {
      this._resize();
      this._draw(this.display);
    });
    this._ro.observe(this.canvas);
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.cw = Math.max(1, rect.width);
    this.ch = Math.max(1, rect.height || rect.width);
    this.canvas.width = Math.round(this.cw * this.dpr);
    this.canvas.height = Math.round(this.ch * this.dpr);
  }

  set(value) {
    this.value = clamp(value, this.min, this.max);
    this._animate();
  }

  _animate() {
    if (this._raf) cancelAnimationFrame(this._raf);
    const step = () => {
      const diff = this.value - this.display;
      if (Math.abs(diff) < 0.3) {
        this.display = this.value;
        this._draw(this.display);
        this._raf = null;
        return;
      }
      this.display += diff * 0.18;
      this._draw(this.display);
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  _angleFor(v) {
    const frac = (v - this.min) / (this.max - this.min);
    return this.start + clamp(frac, 0, 1) * (this.end - this.start);
  }

  _draw(v) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cw, this.ch);
    const cx = this.cw / 2;
    const cy = this.ch / 2 + this.ch * 0.05;
    const radius = Math.min(cx, cy) - this.thickness - 6;

    // track
    ctx.beginPath();
    ctx.arc(cx, cy, radius, this.start, this.end);
    ctx.lineWidth = this.thickness;
    ctx.lineCap = "round";
    ctx.strokeStyle = rgba(cssVar("--border") || "#2a2f3a", 0.6);
    ctx.stroke();

    // ticks
    if (this.ticks > 0) {
      ctx.strokeStyle = rgba(cssVar("--text-dim") || "#8b93a7", 0.5);
      ctx.lineWidth = 1.5;
      for (let i = 0; i <= this.ticks; i++) {
        const a = this.start + (i / this.ticks) * (this.end - this.start);
        const r0 = radius + this.thickness / 2 + 2;
        const r1 = r0 + (i % 5 === 0 ? 6 : 3);
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.stroke();
      }
    }

    // value arc
    const col = this.autoColor ? usageColor(((v - this.min) / (this.max - this.min)) * 100) : this.color;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, this.start, this._angleFor(v));
    ctx.lineWidth = this.thickness;
    ctx.lineCap = "round";
    ctx.strokeStyle = col;
    ctx.stroke();

    // threshold marker
    if (this.threshold != null) {
      const a = this._angleFor(this.threshold);
      const r0 = radius - this.thickness / 2 - 2;
      const r1 = radius + this.thickness / 2 + 2;
      ctx.beginPath();
      ctx.strokeStyle = cssVar("--danger") || "#ef4444";
      ctx.lineWidth = 2;
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
    }

    // center readout
    ctx.fillStyle = cssVar("--text") || "#e6e9ef";
    ctx.font = `700 ${Math.round(radius * 0.5)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(Math.round(v) + this.unit, cx, cy - radius * 0.06);

    if (this.label) {
      ctx.fillStyle = cssVar("--text-dim") || "#8b93a7";
      ctx.font = `${Math.round(radius * 0.2)}px system-ui, sans-serif`;
      ctx.fillText(this.label, cx, cy + radius * 0.42);
    }
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
    if (this._raf) cancelAnimationFrame(this._raf);
  }
}
