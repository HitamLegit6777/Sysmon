//! Floating tooltip engine + context menu. Smart edge-aware positioning, rich
//! HTML/DOM content, hover-intent delay, and a global singleton layer so only
//! one tooltip shows at a time. Also provides a right-click context menu.
import { h, iconEl } from "../util.js";

export const TOOLTIP_VERSION = "1.0.0";

/* --- singleton layer ---------------------------------------------------- */
let _layer = null;
function layer() {
  if (!_layer) {
    _layer = h("div.tooltip-layer");
    document.body.appendChild(_layer);
  }
  return _layer;
}

let _current = null;
let _showTimer = null;
let _hideTimer = null;

/**
 * Position `el` relative to a target rect, choosing the side that keeps it in
 * the viewport. Preferred order derived from `place` ("top"|"bottom"|"left"|
 * "right"|"auto").
 */
function place(el, rect, prefer = "top", gap = 10) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  const order =
    prefer === "auto"
      ? ["top", "bottom", "right", "left"]
      : [prefer, opposite(prefer), "top", "bottom", "right", "left"];

  for (const side of order) {
    let x, y, ok = true;
    if (side === "top") {
      x = rect.left + rect.width / 2 - w / 2;
      y = rect.top - hgt - gap;
      ok = y >= 4;
    } else if (side === "bottom") {
      x = rect.left + rect.width / 2 - w / 2;
      y = rect.bottom + gap;
      ok = y + hgt <= vh - 4;
    } else if (side === "left") {
      x = rect.left - w - gap;
      y = rect.top + rect.height / 2 - hgt / 2;
      ok = x >= 4;
    } else {
      x = rect.right + gap;
      y = rect.top + rect.height / 2 - hgt / 2;
      ok = x + w <= vw - 4;
    }
    if (ok) {
      x = Math.max(6, Math.min(x, vw - w - 6));
      y = Math.max(6, Math.min(y, vh - hgt - 6));
      el.style.left = x + "px";
      el.style.top = y + "px";
      el.dataset.side = side;
      // arrow offset
      if (side === "top" || side === "bottom") {
        const ax = rect.left + rect.width / 2 - x;
        el.style.setProperty("--arrow-x", ax + "px");
      } else {
        const ay = rect.top + rect.height / 2 - y;
        el.style.setProperty("--arrow-y", ay + "px");
      }
      return;
    }
  }
  // fallback: clamp to viewport
  el.style.left = Math.max(6, (vw - w) / 2) + "px";
  el.style.top = "6px";
  el.dataset.side = "top";
}

function opposite(side) {
  return { top: "bottom", bottom: "top", left: "right", right: "left" }[side] || "bottom";
}

/** Immediately show a tooltip near a target element or rect. */
export function showTooltip(target, content, opts = {}) {
  hideTooltip(true);
  const tip = h(`div.tooltip${opts.variant ? ".tooltip--" + opts.variant : ""}`, {
    role: "tooltip",
  });
  if (typeof content === "string") tip.innerHTML = content;
  else if (content instanceof Node) tip.appendChild(content);
  tip.appendChild(h("span.tooltip-arrow"));
  layer().appendChild(tip);
  const rect =
    target instanceof Element ? target.getBoundingClientRect() : target;
  place(tip, rect, opts.place || "top", opts.gap);
  void tip.offsetWidth;
  tip.classList.add("is-visible");
  _current = tip;
  return tip;
}

/** Hide any visible tooltip. */
export function hideTooltip(immediate = false) {
  clearTimeout(_showTimer);
  clearTimeout(_hideTimer);
  const tip = _current;
  if (!tip) return;
  _current = null;
  if (immediate) {
    if (tip.parentNode) tip.parentNode.removeChild(tip);
    return;
  }
  tip.classList.remove("is-visible");
  setTimeout(() => {
    if (tip.parentNode) tip.parentNode.removeChild(tip);
  }, 140);
}

/**
 * Attach a hover tooltip to an element. `content` may be a string, node, or a
 * function returning either (called each show). Returns a detach function.
 */
export function attachTooltip(el, content, opts = {}) {
  const delay = opts.delay != null ? opts.delay : 350;
  const resolve = () =>
    typeof content === "function" ? content(el) : content;
  const onEnter = () => {
    clearTimeout(_hideTimer);
    _showTimer = setTimeout(() => {
      const c = resolve();
      if (c != null) showTooltip(el, c, opts);
    }, delay);
  };
  const onLeave = () => {
    clearTimeout(_showTimer);
    _hideTimer = setTimeout(() => hideTooltip(), 80);
  };
  const onMove = opts.followCursor
    ? (e) => {
        if (_current) {
          const r = { left: e.clientX, top: e.clientY, width: 0, height: 0, right: e.clientX, bottom: e.clientY };
          place(_current, r, opts.place || "top", opts.gap);
        }
      }
    : null;
  el.addEventListener("mouseenter", onEnter);
  el.addEventListener("mouseleave", onLeave);
  el.addEventListener("focus", onEnter);
  el.addEventListener("blur", onLeave);
  if (onMove) el.addEventListener("mousemove", onMove);
  return () => {
    el.removeEventListener("mouseenter", onEnter);
    el.removeEventListener("mouseleave", onLeave);
    el.removeEventListener("focus", onEnter);
    el.removeEventListener("blur", onLeave);
    if (onMove) el.removeEventListener("mousemove", onMove);
  };
}

window.addEventListener("scroll", () => hideTooltip(true), true);
window.addEventListener("resize", () => hideTooltip(true));

/* ======================================================================== *
 *  Rich tooltip content builder — a titled key/value card used by charts.
 * ======================================================================== */

/**
 * Build a structured tooltip node. opts: { title, subtitle, rows:[{label,
 * value, color, strong}], footer }.
 */
export function tooltipCard(opts = {}) {
  const rows = (opts.rows || []).map((r) =>
    h("div.tt-row", null, [
      r.color
        ? h("span.tt-dot", { style: { background: r.color } })
        : null,
      h("span.tt-label", { text: r.label }),
      h(`span.tt-value${r.strong ? ".is-strong" : ""}`, { text: String(r.value) }),
    ])
  );
  return h("div.tt-card", null, [
    opts.title ? h("div.tt-title", { text: opts.title }) : null,
    opts.subtitle ? h("div.tt-subtitle", { text: opts.subtitle }) : null,
    rows.length ? h("div.tt-rows", null, rows) : null,
    opts.footer ? h("div.tt-footer", { text: opts.footer }) : null,
  ]);
}

/* ======================================================================== *
 *  Context menu — right-click menu reusing dropdown-item styling.
 * ======================================================================== */

let _ctxMenu = null;
function closeContext() {
  if (_ctxMenu && _ctxMenu.parentNode) _ctxMenu.parentNode.removeChild(_ctxMenu);
  _ctxMenu = null;
}
document.addEventListener("mousedown", (e) => {
  if (_ctxMenu && !_ctxMenu.contains(e.target)) closeContext();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeContext();
});

/**
 * Show a context menu at (x,y) with items like dropdown(). Returns nothing;
 * the menu closes on outside click / escape / selection.
 */
export function contextMenu(x, y, items) {
  closeContext();
  const menu = h("div.context-menu", { role: "menu" });
  items.forEach((item) => {
    if (item.separator) menu.appendChild(h("div.dropdown-sep"));
    else if (item.header) menu.appendChild(h("div.dropdown-header", { text: item.header }));
    else {
      menu.appendChild(
        h(
          `button.dropdown-item${item.danger ? ".is-danger" : ""}`,
          {
            role: "menuitem",
            disabled: item.disabled || false,
            onClick: () => {
              closeContext();
              if (item.onClick) item.onClick();
            },
          },
          [
            item.icon ? iconEl(item.icon, 16) : h("span.dropdown-icon-gap"),
            h("span.dropdown-label", { text: item.label }),
            item.shortcut ? h("kbd.dropdown-kbd", { text: item.shortcut }) : null,
          ]
        )
      );
    }
  });
  layer().appendChild(menu);
  // position within viewport
  const w = menu.offsetWidth;
  const hgt = menu.offsetHeight;
  const px = Math.min(x, window.innerWidth - w - 8);
  const py = Math.min(y, window.innerHeight - hgt - 8);
  menu.style.left = Math.max(6, px) + "px";
  menu.style.top = Math.max(6, py) + "px";
  void menu.offsetWidth;
  menu.classList.add("is-active");
  _ctxMenu = menu;
}

/** Attach a context menu to an element; `itemsFn(e)` returns the item list. */
export function attachContextMenu(el, itemsFn) {
  const handler = (e) => {
    e.preventDefault();
    const items = typeof itemsFn === "function" ? itemsFn(e) : itemsFn;
    if (items && items.length) contextMenu(e.clientX, e.clientY, items);
  };
  el.addEventListener("contextmenu", handler);
  return () => el.removeEventListener("contextmenu", handler);
}
