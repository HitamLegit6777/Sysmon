//! Settings drawer: a slide-in panel to control theme, accent, UI density,
//! chart smoothing, byte/bit units, refresh behavior, and reduced motion. All
//! preferences persist to localStorage and apply live via document dataset and
//! CSS classes. Other modules can read prefs via getPref()/onPrefChange().
import { h } from "../util.js";
import { drawer, segmented, toggle, slider } from "./primitives.js";

export const SETTINGS_VERSION = "1.0.0";

const PREFIX = "sysmon.";

const DEFAULTS = {
  theme: "dark",
  accent: "blue",
  density: "cozy", // compact | cozy | comfy
  units: "bytes", // bytes | bits
  smoothing: true,
  reduceMotion: false,
  gridLines: true,
  historyWindow: 60, // seconds shown in charts
  sidebarCollapsed: false,
};

const ACCENTS = [
  { value: "blue", color: "#5b8cff", label: "Blue" },
  { value: "violet", color: "#b388ff", label: "Violet" },
  { value: "emerald", color: "#3ad29f", label: "Emerald" },
  { value: "amber", color: "#f5b342", label: "Amber" },
  { value: "rose", color: "#fb7185", label: "Rose" },
];

const _listeners = new Set();
let _prefs = null;

function load() {
  if (_prefs) return _prefs;
  _prefs = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw != null) {
      try {
        _prefs[key] = JSON.parse(raw);
      } catch (_) {
        _prefs[key] = raw;
      }
    }
  }
  return _prefs;
}

/** Read a preference value. */
export function getPref(key) {
  return load()[key];
}

/** Read all preferences (a shallow copy). */
export function getPrefs() {
  return { ...load() };
}

/** Set a preference, persist it, apply side effects, and notify listeners. */
export function setPref(key, value) {
  load();
  _prefs[key] = value;
  localStorage.setItem(PREFIX + key, JSON.stringify(value));
  applyPref(key, value);
  for (const fn of _listeners) {
    try {
      fn(key, value, _prefs);
    } catch (_) {}
  }
}

/** Subscribe to preference changes. Returns an unsubscribe function. */
export function onPrefChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Apply a single preference to the DOM. */
function applyPref(key, value) {
  const root = document.documentElement;
  switch (key) {
    case "theme":
      root.dataset.theme = value;
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", value === "light" ? "#f4f6fb" : "#0d1017");
      break;
    case "accent":
      if (value && value !== "blue") root.dataset.accent = value;
      else delete root.dataset.accent;
      break;
    case "density":
      root.dataset.density = value;
      break;
    case "reduceMotion":
      root.classList.toggle("reduce-motion", !!value);
      break;
    case "gridLines":
      root.classList.toggle("no-grid", !value);
      break;
    case "sidebarCollapsed":
      root.classList.toggle("sidebar-collapsed", !!value);
      break;
    default:
      break;
  }
}

/** Apply all stored preferences (call once at boot). */
export function applyAllPrefs() {
  const p = load();
  for (const key of Object.keys(p)) applyPref(key, p[key]);
}

/** Toggle theme quickly (used by topbar button) and persist. */
export function toggleTheme() {
  const next = getPref("theme") === "light" ? "dark" : "light";
  setPref("theme", next);
  return next;
}

/* ------------------------------ drawer UI ------------------------------- */

function row(label, control, hint) {
  return h("div.setrow", null, [
    h("div.setrow-info", null, [
      h("div.setrow-label", { text: label }),
      hint ? h("div.setrow-hint", { text: hint }) : null,
    ]),
    h("div.setrow-control", null, control),
  ]);
}

function section(title, rows) {
  return h("section.setsection", null, [
    h("h3.setsection-title", { text: title }),
    ...rows,
  ]);
}

function accentSwatches() {
  const wrap = h("div.accent-swatches", { role: "radiogroup" });
  const current = getPref("accent");
  ACCENTS.forEach((a) => {
    const btn = h("button.accent-swatch", {
      role: "radio",
      title: a.label,
      "aria-checked": a.value === current ? "true" : "false",
      style: { "--sw": a.color },
      onClick: () => {
        setPref("accent", a.value);
        wrap.querySelectorAll(".accent-swatch").forEach((s) =>
          s.setAttribute("aria-checked", s === btn ? "true" : "false")
        );
      },
    });
    if (a.value === current) btn.classList.add("is-active");
    wrap.appendChild(btn);
  });
  return wrap;
}

let _open = false;

/** Open the settings drawer. */
export function openSettings() {
  if (_open) return;
  _open = true;
  const p = getPrefs();

  const body = h("div.settings-body", null, [
    section("Appearance", [
      row(
        "Theme",
        segmented({
          options: [
            { value: "dark", label: "Dark", icon: "moon" },
            { value: "light", label: "Light", icon: "sun" },
          ],
          value: p.theme,
          onChange: (v) => setPref("theme", v),
        }),
        "Overall color scheme"
      ),
      row("Accent", accentSwatches(), "Primary highlight color"),
      row(
        "Density",
        segmented({
          options: [
            { value: "compact", label: "Compact" },
            { value: "cozy", label: "Cozy" },
            { value: "comfy", label: "Comfy" },
          ],
          value: p.density,
          onChange: (v) => setPref("density", v),
        }),
        "Spacing of cards and rows"
      ),
    ]),
    section("Charts", [
      row(
        "Line smoothing",
        toggle({ checked: p.smoothing, onChange: (v) => setPref("smoothing", v) }),
        "Curved vs. straight line segments"
      ),
      row(
        "Grid lines",
        toggle({ checked: p.gridLines, onChange: (v) => setPref("gridLines", v) }),
        "Show horizontal gridlines"
      ),
      row(
        "History window",
        slider({
          min: 30,
          max: 300,
          step: 30,
          value: p.historyWindow,
          unit: "s",
          onInput: (v) => setPref("historyWindow", v),
        }),
        "Seconds of history shown in charts"
      ),
    ]),
    section("Units & Motion", [
      row(
        "Data units",
        segmented({
          options: [
            { value: "bytes", label: "Bytes" },
            { value: "bits", label: "Bits" },
          ],
          value: p.units,
          onChange: (v) => setPref("units", v),
        }),
        "Display network rates in bytes or bits"
      ),
      row(
        "Reduce motion",
        toggle({ checked: p.reduceMotion, onChange: (v) => setPref("reduceMotion", v) }),
        "Minimize animations and transitions"
      ),
    ]),
  ]);

  const footer = h("div.settings-footer", null, [
    h(
      "button.btn.btn-ghost",
      {
        onClick: () => {
          Object.keys(DEFAULTS).forEach((k) => setPref(k, DEFAULTS[k]));
          dlg.close();
          _open = false;
          setTimeout(openSettings, 50);
        },
      },
      "Reset to defaults"
    ),
    h("span.settings-version", { text: "SysMon UI v" + SETTINGS_VERSION }),
  ]);

  const dlg = drawer({
    title: "Settings",
    subtitle: "Personalize your dashboard",
    icon: "settings",
    side: "right",
    width: "380px",
    body,
    footer,
    onClose: () => {
      _open = false;
    },
  });
  dlg.open();
}

export { ACCENTS };
