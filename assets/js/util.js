/**
 * util.js
 * -------
 * Foundational browser-side helpers with no dependencies: number/byte/time
 * formatting, a tiny hyperscript-style DOM builder, class utilities, event
 * helpers, color interpolation, and an inline SVG icon set. Every UI module
 * imports from here.
 */

/* ----------------------------- Formatting ------------------------------ */

const IEC = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** Format a byte count using IEC (1024) units. */
export function fmtBytes(bytes, decimals = 1) {
  if (!isFinite(bytes) || bytes === 0) return "0 B";
  const neg = bytes < 0;
  let v = Math.abs(bytes);
  let i = 0;
  while (v >= 1024 && i < IEC.length - 1) {
    v /= 1024;
    i++;
  }
  return (neg ? "-" : "") + v.toFixed(i === 0 ? 0 : decimals) + " " + IEC[i];
}

/** Format a byte-per-second rate. */
export function fmtRate(bps, decimals = 1) {
  return fmtBytes(bps, decimals) + "/s";
}

/** Split a byte value into { value, unit } for separate styling. */
export function splitBytes(bytes, decimals = 1) {
  if (!isFinite(bytes) || bytes === 0) return { value: "0", unit: "B" };
  const neg = bytes < 0;
  let v = Math.abs(bytes);
  let i = 0;
  while (v >= 1024 && i < IEC.length - 1) {
    v /= 1024;
    i++;
  }
  return {
    value: (neg ? "-" : "") + v.toFixed(i === 0 ? 0 : decimals),
    unit: IEC[i],
  };
}

/** Split a rate into { value, unit } where unit already ends with /s. */
export function splitRate(bps, decimals = 1) {
  const s = splitBytes(bps, decimals);
  s.unit += "/s";
  return s;
}

/** Format a percentage. */
export function fmtPct(v, decimals = 1) {
  if (!isFinite(v)) return "0%";
  return v.toFixed(decimals) + "%";
}

/** Format a duration in seconds into a compact string. */
export function fmtUptime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "0s";
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor((seconds / 3600) % 24);
  const d = Math.floor(seconds / 86400);
  const parts = [];
  if (d) parts.push(d + "d");
  if (h || d) parts.push(h + "h");
  if (m || h || d) parts.push(m + "m");
  parts.push(s + "s");
  return parts.join(" ");
}

/** Short duration for compact areas (e.g. "3d 4h"). */
export function fmtUptimeShort(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds / 3600) % 24);
  const m = Math.floor((seconds / 60) % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Format a number with thousands separators. */
export function fmtNum(n, decimals = 0) {
  if (!isFinite(n)) return "0";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Compact large integers (e.g. 12.4k). */
export function fmtCompact(n) {
  if (!isFinite(n)) return "0";
  if (Math.abs(n) < 1000) return String(Math.round(n));
  const units = ["k", "M", "B", "T"];
  let v = n;
  let i = -1;
  while (Math.abs(v) >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return v.toFixed(1) + units[i];
}

/** Format a clock time from a Date. */
export function fmtClock(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** Format a full date-time. */
export function fmtDateTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Relative "time ago" string from an epoch-ms value. */
export function timeAgo(ms) {
  const diff = Date.now() - ms;
  if (diff < 1500) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return sec + "s ago";
  const min = Math.floor(sec / 60);
  if (min < 60) return min + "m ago";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + "h ago";
  return Math.floor(hr / 24) + "d ago";
}

/* ------------------------------- Math ---------------------------------- */

/** Clamp a number to a range. */
export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/** Linear interpolation. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Map a value from one range to another, clamped. */
export function mapRange(v, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) return outMin;
  const t = clamp((v - inMin) / (inMax - inMin), 0, 1);
  return outMin + t * (outMax - outMin);
}

/** Round to n decimals returning a Number. */
export function round(v, decimals = 2) {
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

/** Truncate a string to maxLen, adding an ellipsis when needed. */
export function truncate(str, maxLen) {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.slice(0, Math.max(0, maxLen - 1)) + "…";
}

/** Escape a string for safe insertion into innerHTML. */
export function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Average of an array. */
export function avg(arr) {
  if (!arr || arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

/** Max of an array (numeric), safe for empty. */
export function maxOf(arr, fallback = 0) {
  if (!arr || arr.length === 0) return fallback;
  let m = -Infinity;
  for (const v of arr) if (v > m) m = v;
  return m === -Infinity ? fallback : m;
}

/* ------------------------------- DOM ----------------------------------- */

/**
 * Hyperscript-style element factory.
 * h("div.card#main", { onClick }, [child, "text"])
 * The tag string supports .class and #id shorthands.
 */
export function h(tag, props = null, children = null) {
  let tagName = "div";
  const classes = [];
  let id = null;

  const parts = tag.split(/(?=[.#])/);
  parts.forEach((p, idx) => {
    if (p.startsWith(".")) classes.push(p.slice(1));
    else if (p.startsWith("#")) id = p.slice(1);
    else if (idx === 0) tagName = p;
  });

  const el = document.createElement(tagName);
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(" ");

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === "class" || key === "className") {
        el.className = (el.className ? el.className + " " : "") + value;
      } else if (key === "style" && typeof value === "object") {
        Object.assign(el.style, value);
      } else if (key === "dataset" && typeof value === "object") {
        Object.assign(el.dataset, value);
      } else if (key.startsWith("on") && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === "html") {
        el.innerHTML = value;
      } else if (key === "text") {
        el.textContent = value;
      } else if (value === true) {
        el.setAttribute(key, "");
      } else {
        el.setAttribute(key, value);
      }
    }
  }

  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  if (children == null) return;
  if (Array.isArray(children)) {
    for (const c of children) appendChildren(el, c);
  } else if (children instanceof Node) {
    el.appendChild(children);
  } else {
    el.appendChild(document.createTextNode(String(children)));
  }
}

/** Query a single element. */
export function qs(sel, root = document) {
  return root.querySelector(sel);
}

/** Query all elements as an array. */
export function qsa(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

/** Remove all children of a node. */
export function clear(el) {
  if (el) el.replaceChildren();
  return el;
}

/** Toggle a class based on a boolean. */
export function toggleClass(el, cls, on) {
  if (!el) return;
  el.classList.toggle(cls, !!on);
}

/** Set text content only if it changed (avoids layout thrash). */
export function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

/** Set an inline width percentage. */
export function setWidthPct(el, pct) {
  if (el) el.style.width = clamp(pct, 0, 100) + "%";
}

/* --------------------------- Async helpers ----------------------------- */

/** Debounce a function. */
export function debounce(fn, ms) {
  let t = null;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

/** Throttle a function to at most once per ms. */
export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return function (...args) {
    const now = Date.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      clearTimeout(timer);
      timer = null;
      last = now;
      fn.apply(this, args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn.apply(this, args);
      }, remaining);
    }
  };
}

/** Promise-based delay. */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------ Colors --------------------------------- */

/** Read a CSS custom property from :root. */
export function cssVar(name) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

/** Parse a hex color into [r,g,b]. */
export function hexToRgb(hex) {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  const num = parseInt(h, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

/** Compose an rgba() string from a hex color and alpha. */
export function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Interpolate between two hex colors, returning an rgb() string. */
export function mixColor(hexA, hexB, t) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const r = Math.round(lerp(a[0], b[0], t));
  const g = Math.round(lerp(a[1], b[1], t));
  const bl = Math.round(lerp(a[2], b[2], t));
  return `rgb(${r}, ${g}, ${bl})`;
}

/**
 * Map a 0..100 utilization value to a semantic color: green -> amber -> red.
 * Returns an rgb() string suitable for canvas or inline styles.
 */
export function usageColor(pct) {
  const green = "#3ad29f";
  const amber = "#f5b342";
  const red = "#ff5c7a";
  if (pct <= 50) return mixColor(green, amber, pct / 50);
  if (pct <= 85) return mixColor(amber, red, (pct - 50) / 35);
  return red;
}

/** Return a semantic status class for a utilization percentage. */
export function usageClass(pct) {
  if (pct >= 90) return "danger";
  if (pct >= 75) return "warning";
  return "success";
}

/** Return a semantic status class for a temperature in Celsius. */
export function tempClass(t) {
  if (t >= 85) return "danger";
  if (t >= 70) return "warning";
  return "success";
}

/* ------------------------------- Icons --------------------------------- */

/**
 * A small inline SVG icon set. Each entry is the inner markup of a 24x24
 * stroke icon. icon(name) returns an <svg> string ready to be injected.
 */
const ICON_PATHS = {
  dashboard:
    '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  cpu:
    '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/><rect x="10" y="10" width="4" height="4" rx="1"/>',
  memory:
    '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 7v10M12 7v10M17 7v10M4 20v-1M9 20v-1M15 20v-1M20 20v-1"/>',
  network:
    '<path d="M12 20v-6"/><circle cx="12" cy="4" r="2"/><circle cx="5" cy="20" r="2"/><circle cx="19" cy="20" r="2"/><path d="M12 6v4M12 10l-6 8M12 10l6 8"/>',
  disk:
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v3M18.5 7.5l-2.1 2.1"/>',
  processes:
    '<path d="M4 6h16M4 12h16M4 18h10"/><circle cx="19" cy="18" r="2"/>',
  thermal:
    '<path d="M10 13.5V5a2 2 0 1 1 4 0v8.5a4 4 0 1 1-4 0z"/><path d="M12 9v5"/>',
  alerts:
    '<path d="M12 3a6 6 0 0 0-6 6c0 5-2 6-2 6h16s-2-1-2-6a6 6 0 0 0-6-6z"/><path d="M10.5 20a2 2 0 0 0 3 0"/>',
  system:
    '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  sun:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  refresh:
    '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  pause: '<rect x="7" y="5" width="3" height="14" rx="1"/><rect x="14" y="5" width="3" height="14" rx="1"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  gauge:
    '<path d="M12 14l4-4"/><path d="M3.5 18a9 9 0 1 1 17 0"/><circle cx="12" cy="14" r="1.5"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  server:
    '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5M4 3h16"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 7 2.6h.1A1.6 1.6 0 0 0 8 1.1V1a2 2 0 1 1 4 0v.1A1.6 1.6 0 0 0 15 2.6a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1h.1a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.4 1z"/>',
  chip:
    '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  layers: '<path d="M12 2l9 5-9 5-9-5 9-5z"/><path d="M3 12l9 5 9-5M3 17l9 5 9-5"/>',
  wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01"/>',
  battery:
    '<rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 10v4"/>',
};

/** Build an SVG icon string for the given name. */
export function icon(name, size = 24) {
  const inner = ICON_PATHS[name] || ICON_PATHS.info;
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" ` +
    `stroke="currentColor" stroke-width="1.9" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${inner}</svg>`
  );
}

/** Create an element containing an icon. */
export function iconEl(name, size = 20) {
  const span = document.createElement("span");
  span.className = "icon";
  span.innerHTML = icon(name, size);
  return span;
}
