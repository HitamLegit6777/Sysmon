//! Reusable UI primitives: overlays (modal/drawer), tabs, dropdown, toggle,
//! segmented control, slider. All built on the h() DOM builder and emit plain
//! DOM nodes so views can compose them freely. No external dependencies.
import { h, iconEl } from "../util.js";

export const PRIMITIVES_VERSION = "1.0.0";

/* ======================================================================== *
 *  Overlay base — shared scrim + focus trap + escape handling for modal
 *  and drawer. Returns an object with open()/close()/destroy().
 * ======================================================================== */

let _overlayStack = [];

function trapFocus(container, e) {
  const focusables = container.querySelectorAll(
    'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
  );
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Create a managed overlay. `panel` is the content node. `variant` controls
 * the CSS class ("modal" or "drawer"), `side` is used by drawers.
 */
export function createOverlay(panel, opts = {}) {
  const variant = opts.variant || "modal";
  const side = opts.side || "right";
  const closeOnScrim = opts.closeOnScrim !== false;
  const closeOnEsc = opts.closeOnEsc !== false;

  const scrim = h("div.overlay-scrim", { dataset: { variant } });
  const wrap = h(
    `div.overlay.overlay--${variant}`,
    { dataset: { side } },
    [panel]
  );
  scrim.appendChild(wrap);

  let lastFocused = null;
  let onKey = null;

  const api = {
    el: scrim,
    panel,
    isOpen: false,
    open() {
      if (api.isOpen) return api;
      lastFocused = document.activeElement;
      document.body.appendChild(scrim);
      document.body.classList.add("overlay-open");
      // force reflow then add active for transition
      void scrim.offsetWidth;
      scrim.classList.add("is-active");
      wrap.classList.add("is-active");
      api.isOpen = true;
      _overlayStack.push(api);
      onKey = (e) => {
        if (e.key === "Escape" && closeOnEsc) {
          e.stopPropagation();
          api.close();
        } else if (e.key === "Tab") {
          trapFocus(panel, e);
        }
      };
      document.addEventListener("keydown", onKey, true);
      // autofocus first focusable or panel
      const target =
        panel.querySelector("[autofocus]") ||
        panel.querySelector(
          'button, input, select, textarea, a[href], [tabindex]'
        ) ||
        panel;
      if (target && target.focus) setTimeout(() => target.focus(), 30);
      if (opts.onOpen) opts.onOpen();
      return api;
    },
    close() {
      if (!api.isOpen) return api;
      scrim.classList.remove("is-active");
      wrap.classList.remove("is-active");
      api.isOpen = false;
      _overlayStack = _overlayStack.filter((o) => o !== api);
      if (onKey) document.removeEventListener("keydown", onKey, true);
      if (!_overlayStack.length) document.body.classList.remove("overlay-open");
      const done = () => {
        if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
        if (lastFocused && lastFocused.focus) lastFocused.focus();
        if (opts.onClose) opts.onClose();
      };
      // wait for CSS transition
      setTimeout(done, opts.animMs != null ? opts.animMs : 200);
      return api;
    },
    destroy() {
      if (onKey) document.removeEventListener("keydown", onKey, true);
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
    },
  };

  if (closeOnScrim) {
    scrim.addEventListener("mousedown", (e) => {
      if (e.target === scrim) api.close();
    });
  }
  return api;
}

/* ======================================================================== *
 *  Modal — centered dialog with header/body/footer.
 * ======================================================================== */

/**
 * Build a modal. opts: { title, subtitle, body, footer, size, icon,
 * onClose }. `body` and `footer` may be nodes, arrays, or strings.
 * Returns the overlay api (call .open()).
 */
export function modal(opts = {}) {
  const size = opts.size || "md"; // sm | md | lg | xl
  const header = h("div.modal-head", null, [
    opts.icon ? iconEl(opts.icon, 20) : null,
    h("div.modal-titles", null, [
      h("div.modal-title", { text: opts.title || "" }),
      opts.subtitle ? h("div.modal-subtitle", { text: opts.subtitle }) : null,
    ]),
    h(
      "button.modal-close.icon-btn",
      { title: "Close (Esc)", onClick: () => api.close() },
      iconEl("x", 18)
    ),
  ]);
  const body = h("div.modal-body", null, opts.body || null);
  const parts = [header, body];
  if (opts.footer) parts.push(h("div.modal-foot", null, opts.footer));
  const panel = h(
    `div.modal.modal--${size}`,
    { role: "dialog", "aria-modal": "true", "aria-label": opts.title || "Dialog" },
    parts
  );
  const api = createOverlay(panel, {
    variant: "modal",
    onClose: opts.onClose,
    closeOnScrim: opts.closeOnScrim,
    closeOnEsc: opts.closeOnEsc,
  });
  api.setBody = (content) => {
    body.replaceChildren();
    appendAny(body, content);
    return api;
  };
  return api;
}

/** Convenience confirm dialog resolving a Promise<boolean>. */
export function confirmDialog(opts = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (v) => {
      if (resolved) return;
      resolved = true;
      resolve(v);
    };
    const dlg = modal({
      title: opts.title || "Are you sure?",
      subtitle: opts.subtitle,
      icon: opts.icon || "alerts",
      size: "sm",
      body: h("p.confirm-text", { text: opts.message || "" }),
      footer: [
        h(
          "button.btn.btn-ghost",
          { onClick: () => { dlg.close(); finish(false); } },
          opts.cancelText || "Cancel"
        ),
        h(
          `button.btn.${opts.danger ? "btn-danger" : "btn-primary"}`,
          { onClick: () => { dlg.close(); finish(true); } },
          opts.confirmText || "Confirm"
        ),
      ],
      onClose: () => finish(false),
    });
    dlg.open();
  });
}

/* ======================================================================== *
 *  Drawer — slide-in panel from a side (left/right/bottom).
 * ======================================================================== */

/**
 * Build a drawer. opts: { title, subtitle, body, footer, side, width, icon }.
 */
export function drawer(opts = {}) {
  const side = opts.side || "right";
  const header = h("div.drawer-head", null, [
    opts.icon ? iconEl(opts.icon, 20) : null,
    h("div.drawer-titles", null, [
      h("div.drawer-title", { text: opts.title || "" }),
      opts.subtitle ? h("div.drawer-subtitle", { text: opts.subtitle }) : null,
    ]),
    h(
      "button.drawer-close.icon-btn",
      { title: "Close (Esc)", onClick: () => api.close() },
      iconEl("x", 18)
    ),
  ]);
  const body = h("div.drawer-body", null, opts.body || null);
  const parts = [header, body];
  if (opts.footer) parts.push(h("div.drawer-foot", null, opts.footer));
  const panel = h(
    "div.drawer-panel",
    {
      role: "dialog",
      "aria-modal": "true",
      "aria-label": opts.title || "Panel",
      style: opts.width ? { "--drawer-width": opts.width } : null,
    },
    parts
  );
  const api = createOverlay(panel, {
    variant: "drawer",
    side,
    onClose: opts.onClose,
  });
  api.setBody = (content) => {
    body.replaceChildren();
    appendAny(body, content);
    return api;
  };
  api.body = body;
  return api;
}

function appendAny(el, content) {
  if (content == null) return;
  if (Array.isArray(content)) content.forEach((c) => appendAny(el, c));
  else if (content instanceof Node) el.appendChild(content);
  else el.appendChild(document.createTextNode(String(content)));
}

/* ======================================================================== *
 *  Tabs — accessible tab bar with lazy panel rendering.
 * ======================================================================== */

/**
 * Build a tab group. `items` is an array of { id, label, icon, render() }.
 * render() is called (lazily) to produce the panel content the first time a
 * tab is shown. Returns { el, select(id), active }.
 */
export function tabs(items, opts = {}) {
  const rendered = new Map();
  const bar = h("div.tabbar", { role: "tablist" });
  const panelHost = h("div.tabpanels");
  const btns = new Map();
  let active = null;

  function select(id) {
    if (active === id) return;
    active = id;
    btns.forEach((btn, key) => {
      const on = key === id;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
      btn.tabIndex = on ? 0 : -1;
    });
    let panel = rendered.get(id);
    if (!panel) {
      const item = items.find((i) => i.id === id);
      panel = h("div.tabpanel", { role: "tabpanel" });
      const content = item && item.render ? item.render() : null;
      appendAny(panel, content);
      rendered.set(id, panel);
      panelHost.appendChild(panel);
    }
    panelHost.querySelectorAll(".tabpanel").forEach((p) => {
      p.classList.toggle("is-active", p === panel);
    });
    if (opts.onChange) opts.onChange(id);
  }

  items.forEach((item, idx) => {
    const btn = h(
      "button.tab",
      {
        role: "tab",
        id: `tab-${item.id}`,
        onClick: () => select(item.id),
        onKeydown: (e) => {
          const keys = items.map((i) => i.id);
          const cur = keys.indexOf(active);
          if (e.key === "ArrowRight") select(keys[(cur + 1) % keys.length]);
          else if (e.key === "ArrowLeft")
            select(keys[(cur - 1 + keys.length) % keys.length]);
          else if (e.key === "Home") select(keys[0]);
          else if (e.key === "End") select(keys[keys.length - 1]);
        },
      },
      [
        item.icon ? iconEl(item.icon, 16) : null,
        h("span.tab-label", { text: item.label }),
        item.badge != null ? h("span.tab-badge", { text: String(item.badge) }) : null,
      ]
    );
    btns.set(item.id, btn);
    bar.appendChild(btn);
  });

  const el = h("div.tabs", null, [bar, panelHost]);
  const first = opts.initial || (items[0] && items[0].id);
  if (first) select(first);
  return {
    el,
    select,
    get active() {
      return active;
    },
    setBadge(id, value) {
      const btn = btns.get(id);
      if (!btn) return;
      let b = btn.querySelector(".tab-badge");
      if (!b) {
        b = h("span.tab-badge");
        btn.appendChild(b);
      }
      b.textContent = String(value);
    },
  };
}

/* ======================================================================== *
 *  Dropdown menu — button that opens a floating list of actions.
 * ======================================================================== */

let _openDropdown = null;
document.addEventListener("mousedown", (e) => {
  if (_openDropdown && !_openDropdown.root.contains(e.target)) {
    _openDropdown.close();
  }
});

/**
 * Build a dropdown. `trigger` is text or a node. `items` is an array of
 * { label, icon, onClick, danger, disabled } or { separator:true } or
 * { header: "..." }.
 */
export function dropdown(trigger, items, opts = {}) {
  const btn =
    trigger instanceof Node
      ? trigger
      : h("button.btn.btn-ghost.dropdown-trigger", null, [
          typeof trigger === "string" ? h("span", { text: trigger }) : trigger,
          iconEl("chevron", 14),
        ]);
  const menu = h("div.dropdown-menu", {
    role: "menu",
    dataset: { align: opts.align || "start" },
  });
  const root = h("div.dropdown", null, [btn]);

  items.forEach((item) => {
    if (item.separator) {
      menu.appendChild(h("div.dropdown-sep"));
    } else if (item.header) {
      menu.appendChild(h("div.dropdown-header", { text: item.header }));
    } else {
      const mi = h(
        `button.dropdown-item${item.danger ? ".is-danger" : ""}`,
        {
          role: "menuitem",
          disabled: item.disabled || false,
          onClick: () => {
            close();
            if (item.onClick) item.onClick();
          },
        },
        [
          item.icon ? iconEl(item.icon, 16) : h("span.dropdown-icon-gap"),
          h("span.dropdown-label", { text: item.label }),
          item.shortcut ? h("kbd.dropdown-kbd", { text: item.shortcut }) : null,
        ]
      );
      menu.appendChild(mi);
    }
  });

  function open() {
    if (_openDropdown && _openDropdown !== api) _openDropdown.close();
    root.appendChild(menu);
    root.classList.add("is-open");
    void menu.offsetWidth;
    menu.classList.add("is-active");
    _openDropdown = api;
  }
  function close() {
    menu.classList.remove("is-active");
    root.classList.remove("is-open");
    setTimeout(() => {
      if (menu.parentNode) menu.parentNode.removeChild(menu);
    }, 140);
    if (_openDropdown === api) _openDropdown = null;
  }
  const api = { root, open, close, toggle: () => (root.classList.contains("is-open") ? close() : open()) };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    api.toggle();
  });
  return api;
}

/* ======================================================================== *
 *  Toggle switch.
 * ======================================================================== */

/** A labeled on/off switch. opts: { checked, onChange, label, id }. */
export function toggle(opts = {}) {
  const input = h("input.switch-input", {
    type: "checkbox",
    id: opts.id || null,
    checked: opts.checked || false,
  });
  input.addEventListener("change", () => {
    if (opts.onChange) opts.onChange(input.checked);
  });
  const track = h("span.switch-track", null, [h("span.switch-thumb")]);
  const el = h("label.switch", null, [
    input,
    track,
    opts.label ? h("span.switch-label", { text: opts.label }) : null,
  ]);
  el.setChecked = (v) => {
    input.checked = !!v;
  };
  el.isChecked = () => input.checked;
  return el;
}

/* ======================================================================== *
 *  Segmented control — mutually-exclusive button group.
 * ======================================================================== */

/**
 * opts: { options: [{value,label,icon}], value, onChange, size }.
 */
export function segmented(opts = {}) {
  const options = opts.options || [];
  let value = opts.value != null ? opts.value : options[0] && options[0].value;
  const btns = new Map();
  const el = h(`div.segmented${opts.size ? ".segmented--" + opts.size : ""}`, {
    role: "radiogroup",
  });

  function select(v, fire = true) {
    value = v;
    btns.forEach((btn, key) => {
      const on = key === v;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-checked", on ? "true" : "false");
    });
    if (fire && opts.onChange) opts.onChange(v);
  }

  options.forEach((o) => {
    const btn = h(
      "button.segmented-btn",
      { role: "radio", title: o.title || o.label, onClick: () => select(o.value) },
      [
        o.icon ? iconEl(o.icon, 15) : null,
        o.label ? h("span", { text: o.label }) : null,
      ]
    );
    btns.set(o.value, btn);
    el.appendChild(btn);
  });
  select(value, false);
  el.select = (v) => select(v, false);
  el.getValue = () => value;
  return el;
}

/* ======================================================================== *
 *  Slider — range input with live value bubble.
 * ======================================================================== */

/** opts: { min, max, step, value, onInput, format, label, unit }. */
export function slider(opts = {}) {
  const min = opts.min != null ? opts.min : 0;
  const max = opts.max != null ? opts.max : 100;
  const fmt = opts.format || ((v) => v + (opts.unit || ""));
  const input = h("input.slider-input", {
    type: "range",
    min,
    max,
    step: opts.step != null ? opts.step : 1,
    value: opts.value != null ? opts.value : min,
  });
  const bubble = h("span.slider-bubble", { text: fmt(Number(input.value)) });
  function paint() {
    const v = Number(input.value);
    const pct = ((v - min) / (max - min)) * 100;
    input.style.setProperty("--slider-pct", pct + "%");
    bubble.textContent = fmt(v);
  }
  input.addEventListener("input", () => {
    paint();
    if (opts.onInput) opts.onInput(Number(input.value));
  });
  const el = h("div.slider", null, [
    opts.label
      ? h("div.slider-head", null, [
          h("span.slider-label", { text: opts.label }),
          bubble,
        ])
      : null,
    input,
  ]);
  paint();
  el.getValue = () => Number(input.value);
  el.setValue = (v) => {
    input.value = v;
    paint();
  };
  return el;
}
