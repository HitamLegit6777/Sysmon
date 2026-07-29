/**
 * donut.js
 * --------
 * A segmented donut/ring chart for part-to-whole breakdowns (memory
 * composition, filesystem usage, connection states). Supports a center label,
 * hover highlight with a callback, and rounded segment caps.
 */
import { cssVar, rgba, clamp } from "../util.js";

export class Donut {
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
    this.thickness = opts.thickness || 18;
    this.gap = opts.gap != null ? opts.gap : 0.02; // radians between segments
    this.startAngle = opts.startAngle != null ? opts.startAngle : -Math.PI / 2;
    this.rounded = opts.rounded !== false;
    this.segments = []; // { label, value, color }
    this.centerTitle = opts.centerTitle || "";
    this.centerSub = opts.centerSub || "";
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
    this.ch = Math.max(1, rect.height || rect.width);
    this.canvas.width = Math.round(this.cw * this.dpr);
    this.canvas.height = Math.round(this.ch * this.dpr);
  }

  setSegments(segments, center = {}) {
    this.segments = segments || [];
    if (center.title !== undefined) this.centerTitle = center.title;
    if (center.sub !== undefined) this.centerSub = center.sub;
    this.render();
  }

  setCenter(title, sub) {
    this.centerTitle = title;
    if (sub !== undefined) this.centerSub = sub;
    this.render();
  }

  _geom() {
    const cx = this.cw / 2;
    const cy = this.ch / 2;
    const radius = Math.min(cx, cy) - 4;
    return { cx, cy, radius };
  }

  render() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cw, this.ch);
    const { cx, cy, radius } = this._geom();
    const inner = radius - this.thickness;
    const total = this.segments.reduce((a, s) => a + (s.value || 0), 0);

    // track ring
    ctx.beginPath();
    ctx.arc(cx, cy, radius - this.thickness / 2, 0, Math.PI * 2);
    ctx.lineWidth = this.thickness;
    ctx.strokeStyle = rgba(cssVar("--border") || "#2a2f3a", 0.5);
    ctx.stroke();

    if (total > 0) {
      let angle = this.startAngle;
      this.segments.forEach((seg, i) => {
        const frac = (seg.value || 0) / total;
        if (frac <= 0) return;
        const sweep = frac * (Math.PI * 2);
        const a0 = angle + this.gap / 2;
        const a1 = angle + sweep - this.gap / 2;
        if (a1 > a0) {
          ctx.beginPath();
          ctx.arc(cx, cy, radius - this.thickness / 2, a0, a1);
          ctx.lineWidth = this.hoverIndex === i ? this.thickness + 3 : this.thickness;
          ctx.strokeStyle = seg.color || cssVar("--accent");
          if (this.rounded) ctx.lineCap = "round";
          ctx.stroke();
        }
        angle += sweep;
      });
    }

    // center text
    if (this.centerTitle) {
      ctx.fillStyle = cssVar("--text") || "#e6e9ef";
      ctx.font = `600 ${Math.round(inner * 0.42)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const subOffset = this.centerSub ? -inner * 0.14 : 0;
      ctx.fillText(this.centerTitle, cx, cy + subOffset);
    }
    if (this.centerSub) {
      ctx.fillStyle = cssVar("--text-dim") || "#8b93a7";
      ctx.font = `${Math.round(inner * 0.2)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.centerSub, cx, cy + inner * 0.22);
    }
  }

  _bindHover() {
    const move = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const { cx, cy, radius } = this._geom();
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const inner = radius - this.thickness;
      if (dist < inner - 2 || dist > radius + 2) {
        this._setHover(-1, e);
        return;
      }
      let ang = Math.atan2(dy, dx);
      // normalize relative to startAngle
      let rel = ang - this.startAngle;
      while (rel < 0) rel += Math.PI * 2;
      const total = this.segments.reduce((a, s) => a + (s.value || 0), 0) || 1;
      let acc = 0;
      let found = -1;
      for (let i = 0; i < this.segments.length; i++) {
        const frac = (this.segments[i].value || 0) / total;
        const sweep = frac * Math.PI * 2;
        if (rel >= acc && rel < acc + sweep) {
          found = i;
          break;
        }
        acc += sweep;
      }
      this._setHover(found, e);
    };
    this.canvas.addEventListener("mousemove", move);
    this.canvas.addEventListener("mouseleave", (e) => this._setHover(-1, e));
  }

  _setHover(idx, e) {
    if (this.hoverIndex === idx) {
      if (this.onHover && idx >= 0) {
        this.onHover({ index: idx, segment: this.segments[idx], clientX: e.clientX, clientY: e.clientY });
      }
      return;
    }
    this.hoverIndex = idx;
    this.render();
    if (this.onHover) {
      this.onHover(
        idx >= 0
          ? { index: idx, segment: this.segments[idx], clientX: e.clientX, clientY: e.clientY }
          : null
      );
    }
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
  }
}
