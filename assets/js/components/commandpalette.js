//! Command palette (Ctrl/Cmd+K): a fuzzy-searchable overlay of navigation
//! destinations and actions, plus global keyboard shortcut registration and a
//! help overlay listing all shortcuts. Self-contained; wired from app.js.
import { h, iconEl } from "../util.js";
import { modal } from "./primitives.js";

export const COMMAND_VERSION = "1.0.0";

/* ----------------------------- fuzzy matcher ---------------------------- */

/**
 * Score a candidate against a query. Returns { score, ranges } or null. Higher
 * score = better. Consecutive and word-boundary matches are boosted.
 */
export function fuzzyMatch(query, text) {
  if (!query) return { score: 1, ranges: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  const ranges = [];
  let lastMatch = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      const boundary = ti === 0 || /[\s\-_/.]/.test(t[ti - 1]);
      streak = ti === lastMatch + 1 ? streak + 1 : 1;
      score += 10 + streak * 4 + (boundary ? 15 : 0);
      ranges.push(ti);
      lastMatch = ti;
      qi++;
    }
  }
  if (qi < q.length) return null;
  // prefer shorter targets
  score -= t.length * 0.1;
  return { score, ranges };
}

/** Build a highlighted label node from match ranges. */
function highlight(text, ranges) {
  const set = new Set(ranges);
  const frag = document.createDocumentFragment();
  let buf = "";
  let inMark = false;
  const flush = () => {
    if (!buf) return;
    if (inMark) {
      const m = document.createElement("mark");
      m.className = "cmd-hl";
      m.textContent = buf;
      frag.appendChild(m);
    } else {
      frag.appendChild(document.createTextNode(buf));
    }
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const mark = set.has(i);
    if (mark !== inMark) {
      flush();
      inMark = mark;
    }
    buf += text[i];
  }
  flush();
  return frag;
}

/* --------------------------- command registry --------------------------- */

const _commands = [];

/**
 * Register a command. { id, title, subtitle, icon, section, keywords,
 * shortcut, run() }.
 */
export function registerCommand(cmd) {
  _commands.push(cmd);
}

export function registerCommands(list) {
  list.forEach(registerCommand);
}

export function getCommands() {
  return _commands.slice();
}

/* ------------------------------ palette UI ------------------------------ */

let _paletteOpen = false;

/** Open the command palette. */
export function openPalette() {
  if (_paletteOpen) return;
  _paletteOpen = true;

  const input = h("input.cmd-input", {
    type: "text",
    placeholder: "Type a command or search…",
    autofocus: true,
    spellcheck: "false",
  });
  const list = h("ul.cmd-list", { role: "listbox" });
  const footer = h("div.cmd-footer", null, [
    h("span.cmd-hint", null, [h("kbd", { text: "↑↓" }), " navigate"]),
    h("span.cmd-hint", null, [h("kbd", { text: "↵" }), " select"]),
    h("span.cmd-hint", null, [h("kbd", { text: "esc" }), " close"]),
  ]);
  const panel = h("div.cmd-palette", null, [
    h("div.cmd-search", null, [iconEl("search", 18), input]),
    list,
    footer,
  ]);

  const overlay = modal({ body: panel, size: "cmd", closeOnScrim: true });
  overlay.panel.classList.add("modal--cmd");
  let active = 0;
  let results = [];

  function score(q) {
    const scored = [];
    for (const cmd of _commands) {
      const hay = [cmd.title, cmd.subtitle, cmd.section, ...(cmd.keywords || [])]
        .filter(Boolean)
        .join(" ");
      const m = fuzzyMatch(q, hay);
      const titleMatch = fuzzyMatch(q, cmd.title);
      if (m) scored.push({ cmd, score: (titleMatch ? titleMatch.score * 2 : 0) + m.score, ranges: titleMatch ? titleMatch.ranges : [] });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 40);
  }

  function render() {
    list.replaceChildren();
    if (!results.length) {
      list.appendChild(h("li.cmd-empty", { text: "No matching commands" }));
      return;
    }
    let section = null;
    results.forEach((r, i) => {
      if (r.cmd.section && r.cmd.section !== section) {
        section = r.cmd.section;
        list.appendChild(h("li.cmd-section", { text: section }));
      }
      const li = h(
        `li.cmd-item${i === active ? ".is-active" : ""}`,
        {
          role: "option",
          onMouseenter: () => {
            active = i;
            paintActive();
          },
          onClick: () => run(i),
        },
        [
          h("span.cmd-item-icon", null, iconEl(r.cmd.icon || "chevron", 16)),
          h("span.cmd-item-body", null, [
            h("span.cmd-item-title", null, highlight(r.cmd.title, r.ranges)),
            r.cmd.subtitle ? h("span.cmd-item-sub", { text: r.cmd.subtitle }) : null,
          ]),
          r.cmd.shortcut ? h("kbd.cmd-item-kbd", { text: r.cmd.shortcut }) : null,
        ]
      );
      li._idx = i;
      list.appendChild(li);
    });
  }

  function paintActive() {
    list.querySelectorAll(".cmd-item").forEach((li) => {
      li.classList.toggle("is-active", li._idx === active);
      if (li._idx === active) li.scrollIntoView({ block: "nearest" });
    });
  }

  function run(i) {
    const r = results[i];
    if (!r) return;
    overlay.close();
    _paletteOpen = false;
    setTimeout(() => r.cmd.run && r.cmd.run(), 10);
  }

  function update() {
    results = score(input.value.trim());
    active = 0;
    render();
  }

  input.addEventListener("input", update);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = Math.min(results.length - 1, active + 1);
      paintActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(0, active - 1);
      paintActive();
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(active);
    }
  });

  overlay.open();
  update();
  const origClose = overlay.close;
  overlay.close = () => {
    _paletteOpen = false;
    return origClose();
  };
}

/* --------------------------- shortcut manager --------------------------- */

const _shortcuts = [];

/**
 * Register a global keyboard shortcut. { combo: "mod+k", handler, description,
 * group, when() }. `mod` maps to Ctrl (or Cmd on macOS).
 */
export function registerShortcut(sc) {
  _shortcuts.push(sc);
}

export function getShortcuts() {
  return _shortcuts.slice();
}

function comboMatches(combo, e) {
  const parts = combo.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  const needMod = parts.includes("mod");
  const needShift = parts.includes("shift");
  const needAlt = parts.includes("alt");
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (needMod !== mod) return false;
  if (needShift !== e.shiftKey) return false;
  if (needAlt !== e.altKey) return false;
  const pressed = e.key.toLowerCase();
  return pressed === key || (key === "?" && pressed === "/");
}

/** Start listening for registered shortcuts. Call once. */
export function installShortcuts() {
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    const typing = /INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable);
    for (const sc of _shortcuts) {
      if (sc.allowInInput || !typing) {
        if (comboMatches(sc.combo, e)) {
          if (sc.when && !sc.when()) continue;
          e.preventDefault();
          sc.handler(e);
          return;
        }
      }
    }
  });
}

/* ----------------------------- help overlay ----------------------------- */

/** Open the keyboard-shortcuts help modal. */
export function openShortcutHelp() {
  const groups = new Map();
  for (const sc of _shortcuts) {
    if (!sc.description) continue;
    const g = sc.group || "General";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(sc);
  }
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const pretty = (combo) =>
    combo
      .split("+")
      .map((p) =>
        p === "mod" ? (isMac ? "⌘" : "Ctrl") : p === "shift" ? "⇧" : p.length === 1 ? p.toUpperCase() : p
      )
      .join(" ");
  const sections = [];
  for (const [g, list] of groups) {
    sections.push(
      h("div.help-group", null, [
        h("div.help-group-title", { text: g }),
        h(
          "div.help-rows",
          null,
          list.map((sc) =>
            h("div.help-row", null, [
              h("span.help-desc", { text: sc.description }),
              h("kbd.help-kbd", { text: pretty(sc.combo) }),
            ])
          )
        ),
      ])
    );
  }
  const dlg = modal({
    title: "Keyboard shortcuts",
    icon: "info",
    size: "md",
    body: h("div.help-grid", null, sections),
  });
  dlg.open();
}
