//! Small reusable data-display widgets used across views: KPI cards, stat
//! grids, progress bars, spark bars, timelines, legends, skeleton loaders,
//! empty states, delta indicators, and labeled meters. All return DOM nodes.
import { h, iconEl, fmtNum, usageClass } from "../util.js";

export const WIDGETS_VERSION = "1.0.0";

/* ---------------------------------------------------------------- KPI card */

/**
 * A large single-metric card. opts: { label, value, unit, icon, accent,
 * delta, deltaGood, sub, spark(node) }. Returns { el, update(patch) }.
 */
export function kpi(opts = {}) {
  const valueEl = h("span.kpi-value", { text: opts.value != null ? String(opts.value) : "—" });
  const unitEl = opts.unit ? h("span.kpi-unit", { text: opts.unit }) : null;
  const deltaEl = h("span.kpi-delta");
  const subEl = h("div.kpi-sub", { text: opts.sub || "" });
  const sparkHost = h("div.kpi-spark");
  if (opts.spark) sparkHost.appendChild(opts.spark);

  const el = h(`div.kpi${opts.accent ? ".kpi--" + opts.accent : ""}`, null, [
    h("div.kpi-top", null, [
      opts.icon ? h("span.kpi-icon", { html: "" }, iconEl(opts.icon, 18)) : null,
      h("span.kpi-label", { text: opts.label || "" }),
      deltaEl,
    ]),
    h("div.kpi-mid", null, [valueEl, unitEl]),
    subEl,
    sparkHost,
  ]);

  function setDelta(delta, good) {
    if (delta == null || delta === "") {
      deltaEl.textContent = "";
      deltaEl.className = "kpi-delta";
      return;
    }
    const num = typeof delta === "number" ? delta : parseFloat(delta);
    const up = num >= 0;
    const positive = good === undefined ? up : good;
    deltaEl.className = "kpi-delta " + (positive ? "is-good" : "is-bad");
    deltaEl.textContent = (up ? "▲ " : "▼ ") + (typeof delta === "number" ? Math.abs(delta) : delta);
  }
  setDelta(opts.delta, opts.deltaGood);

  return {
    el,
    update(patch = {}) {
      if (patch.value !== undefined) valueEl.textContent = String(patch.value);
      if (patch.sub !== undefined) subEl.textContent = patch.sub;
      if (patch.delta !== undefined) setDelta(patch.delta, patch.deltaGood);
      if (patch.accent !== undefined) {
        el.className = "kpi" + (patch.accent ? " kpi--" + patch.accent : "");
      }
    },
    valueEl,
    sparkHost,
  };
}

/* --------------------------------------------------------------- stat grid */

/** A responsive grid of small label/value stats. items: [{label,value,hint}]. */
export function statGrid(items, opts = {}) {
  const cells = items.map((it) =>
    h(`div.stat-cell${it.accent ? ".is-" + it.accent : ""}`, null, [
      h("div.stat-cell-label", { text: it.label }),
      h("div.stat-cell-value", { text: it.value != null ? String(it.value) : "—" }),
      it.hint ? h("div.stat-cell-hint", { text: it.hint }) : null,
    ])
  );
  return h(`div.stat-grid${opts.cols ? ".cols-" + opts.cols : ""}`, null, cells);
}

/** Update a stat-grid in place from an array of {value} in the same order. */
export function updateStatGrid(gridEl, values) {
  const cells = gridEl.querySelectorAll(".stat-cell-value");
  values.forEach((v, i) => {
    if (cells[i] && cells[i].textContent !== String(v)) cells[i].textContent = String(v);
  });
}

/* ------------------------------------------------------------ delta badge */

/** A small up/down delta chip. */
export function deltaBadge(value, opts = {}) {
  const num = typeof value === "number" ? value : parseFloat(value) || 0;
  const up = num > 0;
  const flat = num === 0;
  const good = opts.good === undefined ? up : opts.good;
  const cls = flat ? "is-flat" : good ? "is-good" : "is-bad";
  const arrow = flat ? "→" : up ? "▲" : "▼";
  return h(`span.delta-badge.${cls}`, null, [
    h("span.delta-arrow", { text: arrow }),
    h("span.delta-num", { text: opts.format ? opts.format(num) : String(Math.abs(num)) }),
  ]);
}

/* ------------------------------------------------------------- pill badge */

/** A colored status pill. tone: neutral|info|success|warn|danger. */
export function pill(text, tone = "neutral", opts = {}) {
  return h(`span.pill.pill--${tone}${opts.dot ? ".has-dot" : ""}`, null, [
    opts.dot ? h("span.pill-dot") : null,
    opts.icon ? iconEl(opts.icon, 13) : null,
    h("span", { text: text }),
  ]);
}

/* ----------------------------------------------------------- progress bar */

/**
 * A labeled progress bar with automatic color by percent. opts: { value,
 * max, label, right, tone, height, showValue }. Returns { el, set(v) }.
 */
export function progressBar(opts = {}) {
  const max = opts.max != null ? opts.max : 100;
  const fill = h("span.pbar-fill");
  const track = h("span.pbar-track", { style: opts.height ? { height: opts.height } : null }, [fill]);
  const valueEl = opts.showValue !== false ? h("span.pbar-value") : null;
  const head =
    opts.label || opts.right
      ? h("div.pbar-head", null, [
          opts.label ? h("span.pbar-label", { text: opts.label }) : null,
          opts.right ? h("span.pbar-right", { text: opts.right }) : valueEl,
        ])
      : null;
  const el = h(`div.pbar${opts.tone ? ".pbar--" + opts.tone : ""}`, null, [
    head,
    track,
  ]);
  function set(v, rightText) {
    const pct = Math.max(0, Math.min(100, (v / max) * 100));
    fill.style.width = pct + "%";
    if (!opts.tone) {
      fill.className = "pbar-fill " + usageClass(pct);
    }
    if (valueEl) valueEl.textContent = pct.toFixed(0) + "%";
    if (rightText != null) {
      const r = el.querySelector(".pbar-right");
      if (r) r.textContent = rightText;
    }
  }
  set(opts.value != null ? opts.value : 0, opts.right);
  return { el, set, fill };
}

/* --------------------------------------------------------------- spark bar */

/** A tiny inline bar chart from an array of values. */
export function sparkBar(values, opts = {}) {
  const max = opts.max != null ? opts.max : Math.max(1, ...values);
  const bars = values.map((v) => {
    const pct = Math.max(2, (v / max) * 100);
    return h("span.sparkbar-bar", {
      style: { height: pct + "%" },
      class: opts.colorFn ? "" : null,
      title: opts.titleFn ? opts.titleFn(v) : null,
    });
  });
  if (opts.colorFn) {
    bars.forEach((b, i) => (b.style.background = opts.colorFn(values[i])));
  }
  return h(`span.sparkbar${opts.className ? "." + opts.className : ""}`, null, bars);
}

/* --------------------------------------------------------------- timeline */

/** A vertical event timeline. events: [{time,title,desc,tone,icon}]. */
export function timeline(events, opts = {}) {
  const items = events.map((ev) =>
    h(`li.tl-item${ev.tone ? ".tl--" + ev.tone : ""}`, null, [
      h("span.tl-marker", null, ev.icon ? iconEl(ev.icon, 12) : null),
      h("div.tl-body", null, [
        h("div.tl-row", null, [
          h("span.tl-title", { text: ev.title }),
          ev.time ? h("span.tl-time", { text: ev.time }) : null,
        ]),
        ev.desc ? h("div.tl-desc", { text: ev.desc }) : null,
      ]),
    ])
  );
  if (!items.length && opts.emptyText) {
    return emptyState({ text: opts.emptyText, icon: "clock", compact: true });
  }
  return h("ul.timeline", null, items);
}

/* ----------------------------------------------------------------- legend */

/** A chart legend. items: [{label,color,value}]. */
export function legend(items, opts = {}) {
  return h(`div.legend${opts.inline ? ".legend--inline" : ""}`, null,
    items.map((it) =>
      h("span.legend-item", null, [
        h("span.legend-swatch", { style: { background: it.color } }),
        h("span.legend-label", { text: it.label }),
        it.value != null ? h("span.legend-value", { text: String(it.value) }) : null,
      ])
    )
  );
}

/* --------------------------------------------------------------- skeleton */

/** A shimmering placeholder. opts: { lines, height, width }. */
export function skeleton(opts = {}) {
  const lines = opts.lines || 1;
  const arr = [];
  for (let i = 0; i < lines; i++) {
    arr.push(
      h("span.skeleton-line", {
        style: {
          height: opts.height || "12px",
          width: opts.widths ? opts.widths[i % opts.widths.length] : opts.width || "100%",
        },
      })
    );
  }
  return h("div.skeleton", null, arr);
}

/* ------------------------------------------------------------ empty state */

/** A centered empty/placeholder message. */
export function emptyState(opts = {}) {
  return h(`div.empty-state${opts.compact ? ".is-compact" : ""}`, null, [
    h("div.empty-icon", null, iconEl(opts.icon || "info", opts.compact ? 24 : 40)),
    h("div.empty-title", { text: opts.title || opts.text || "Nothing here" }),
    opts.desc ? h("div.empty-desc", { text: opts.desc }) : null,
    opts.action ? opts.action : null,
  ]);
}

/* -------------------------------------------------------------- meterRing */

/** A compact SVG ring meter (0..100). Returns { el, set(pct) }. */
export function meterRing(opts = {}) {
  const size = opts.size || 72;
  const stroke = opts.stroke || 8;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  const prog = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  [track, prog].forEach((c) => {
    c.setAttribute("cx", size / 2);
    c.setAttribute("cy", size / 2);
    c.setAttribute("r", r);
    c.setAttribute("fill", "none");
    c.setAttribute("stroke-width", stroke);
  });
  track.setAttribute("class", "ring-track");
  prog.setAttribute("class", "ring-prog");
  prog.setAttribute("stroke-dasharray", circ);
  prog.setAttribute("stroke-linecap", "round");
  prog.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("class", "meter-ring-svg");
  svg.appendChild(track);
  svg.appendChild(prog);
  const label = h("span.meter-ring-label");
  const el = h("div.meter-ring", { style: { width: size + "px", height: size + "px" } }, [
    svg,
    label,
  ]);
  function set(pct, text) {
    const p = Math.max(0, Math.min(100, pct));
    prog.setAttribute("stroke-dashoffset", circ * (1 - p / 100));
    prog.setAttribute("class", "ring-prog " + usageClass(p));
    label.textContent = text != null ? text : p.toFixed(0) + "%";
  }
  set(opts.value != null ? opts.value : 0, opts.text);
  return { el, set };
}
