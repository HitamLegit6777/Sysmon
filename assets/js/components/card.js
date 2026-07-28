/**
 * card.js
 * -------
 * Card and stat-tile factory helpers. These build the recurring surfaces used
 * across views: a titled glass card, and a KPI stat tile with an icon, a big
 * value, a subtitle, and an embedded live sparkline.
 */

import { h, icon, splitBytes } from "../util.js";
import { Sparkline } from "../charts/sparkline.js";

/**
 * Build a titled card.
 * @param {object} opts { title, iconName, actions:[HTMLElement], className, accent }
 * @param {Node|Node[]} body
 * @returns {HTMLElement}
 */
export function card(opts = {}, body = null) {
  const header =
    opts.title || opts.actions
      ? h("div.card-header", null, [
          h("div.card-title", null, [
            opts.iconName
              ? h("span.icon", { html: icon(opts.iconName, 16) })
              : null,
            opts.title ? h("span", { text: opts.title }) : null,
          ]),
          opts.actions ? h("div.card-actions", null, opts.actions) : null,
        ])
      : null;

  const el = h(
    "div.card" + (opts.className ? "." + opts.className.split(" ").join(".") : ""),
    null,
    [opts.accent ? h("div.card-accent-line") : null, header, body]
  );
  return el;
}

/**
 * A KPI stat tile. Returns { el, update(value, sub), spark }.
 * @param {object} opts { label, iconName, iconClass, unit, sparkColor }
 */
export function statTile(opts = {}) {
  const valueEl = h("div.stat-value", null, [
    h("span.v", { text: "0" }),
    opts.unit ? h("span.unit", { text: opts.unit }) : null,
  ]);
  const subEl = h("div.stat-sub", { text: opts.sub || "" });
  const canvas = h("canvas.sparkline");
  const sparkWrap = h("div.stat-spark", null, canvas);

  const el = card(
    { className: "stat-tile interactive", accent: false },
    [
      h("div.stat-top", null, [
        h("div.col.gap-2", null, [
          h("div.stat-label", { text: opts.label || "" }),
        ]),
        h(
          "div.stat-icon" + (opts.iconClass ? "." + opts.iconClass : ""),
          { html: icon(opts.iconName || "activity", 22) }
        ),
      ]),
      valueEl,
      subEl,
      sparkWrap,
    ]
  );

  // Defer sparkline construction until the canvas is in the DOM so it can size.
  let spark = null;
  requestAnimationFrame(() => {
    spark = new Sparkline(canvas, {
      color: opts.sparkColor,
      min: opts.sparkMin,
      max: opts.sparkMax,
    });
    if (opts.seed) spark.setData(opts.seed);
  });

  const vSpan = valueEl.querySelector(".v");
  const uSpan = valueEl.querySelector(".unit");

  return {
    el,
    spark: () => spark,
    setSpark(data) {
      if (spark) spark.setData(data);
    },
    pushSpark(v) {
      if (spark) spark.push(v);
    },
    update(value, sub, unit) {
      if (vSpan.textContent !== String(value)) vSpan.textContent = value;
      if (unit !== undefined && uSpan) uSpan.textContent = unit;
      if (sub !== undefined && subEl.textContent !== sub) subEl.textContent = sub;
    },
    setSparkColor(color) {
      if (spark) spark.setColor(color);
    },
  };
}

/**
 * A labeled meter row (label + value + progress bar). Returns { el, update }.
 */
export function meter(opts = {}) {
  const valueEl = h("span.value", { text: opts.value || "" });
  const bar = h("div.progress-bar");
  const el = h("div.meter", null, [
    h("div.meter-head", null, [
      h("div.label", null, [
        opts.color
          ? h("span.meter-legend-dot", { style: { background: opts.color } })
          : null,
        h("span", { text: opts.label || "" }),
      ]),
      valueEl,
    ]),
    h("div.progress" + (opts.tall ? ".tall" : ""), null, bar),
  ]);
  return {
    el,
    update(pct, valueText, statusClass) {
      bar.style.width = Math.max(0, Math.min(100, pct)) + "%";
      if (opts.color) bar.style.background = opts.color;
      if (statusClass) {
        bar.className = "progress-bar " + statusClass;
        if (opts.color) bar.style.background = opts.color;
      }
      if (valueText !== undefined && valueEl.textContent !== valueText) {
        valueEl.textContent = valueText;
      }
    },
  };
}

/** A small key/value definition list. */
export function kvList(pairs) {
  const dl = h("dl.kv-list");
  for (const [k, v] of pairs) {
    dl.appendChild(h("dt", { text: k }));
    dl.appendChild(h("dd", { text: v, title: v }));
  }
  return dl;
}

/** Update an existing kvList in place with new values (by index). */
export function updateKvList(dl, values) {
  const dds = dl.querySelectorAll("dd");
  values.forEach((v, i) => {
    if (dds[i] && dds[i].textContent !== v) {
      dds[i].textContent = v;
      dds[i].title = v;
    }
  });
}

/** A badge element. */
export function badge(text, kind = "neutral", withDot = true) {
  return h("span.badge." + kind, null, [
    withDot ? h("span.dot") : null,
    h("span", { text }),
  ]);
}
