/**
 * toast.js
 * --------
 * Transient notification toasts, used for alerts and connection status changes.
 * Toasts stack in a corner, auto-dismiss, and are de-duplicated by an optional
 * key so repeated events do not spam the UI.
 */

import { h, icon } from "../util.js";

const activeKeys = new Map();

function root() {
  let r = document.getElementById("toast-root");
  if (!r) {
    r = h("div#toast-root");
    document.body.appendChild(r);
  }
  return r;
}

/**
 * Show a toast.
 * @param {object} opts { title, message, kind, timeout, key }
 */
export function toast(opts = {}) {
  const kind = opts.kind || "info";
  const timeout = opts.timeout ?? 5000;

  if (opts.key && activeKeys.has(opts.key)) {
    // Refresh the existing toast timer instead of stacking duplicates.
    const existing = activeKeys.get(opts.key);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => dismiss(existing.el), timeout);
    return existing.el;
  }

  const iconName =
    kind === "danger"
      ? "alerts"
      : kind === "success"
      ? "check"
      : kind === "warning"
      ? "info"
      : "info";

  const el = h("div.toast." + kind, null, [
    h("div.toast-icon", { html: icon(iconName, 18) }),
    h("div.toast-body", null, [
      opts.title ? h("div.toast-title", { text: opts.title }) : null,
      opts.message ? h("div.toast-msg", { text: opts.message }) : null,
    ]),
    h("button.toast-close", {
      html: icon("x", 14),
      onClick: () => dismiss(el),
    }),
  ]);

  root().appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));

  const timer = setTimeout(() => dismiss(el), timeout);
  if (opts.key) activeKeys.set(opts.key, { el, timer });
  el._toastKey = opts.key;

  return el;
}

function dismiss(el) {
  if (!el || el._dismissing) return;
  el._dismissing = true;
  el.classList.remove("show");
  el.classList.add("hide");
  if (el._toastKey) activeKeys.delete(el._toastKey);
  setTimeout(() => el.remove(), 300);
}

export const notify = {
  info: (title, message, key) => toast({ title, message, kind: "info", key }),
  success: (title, message, key) =>
    toast({ title, message, kind: "success", key }),
  warning: (title, message, key) =>
    toast({ title, message, kind: "warning", key }),
  danger: (title, message, key) =>
    toast({ title, message, kind: "danger", key, timeout: 8000 }),
};

export default toast;
