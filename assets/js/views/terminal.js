/**
 * terminal.js
 * -----------
 * A real terminal, backed by xterm.js (vendored locally under /vendor). It is a
 * full VT/ANSI emulator: cursor movement, line/screen clears, colors, TUI apps
 * (top, vim, htop), history, tab-completion and progress bars all render exactly
 * as they would in a native terminal. We do NOT re-implement any of that.
 *
 * Wire protocol (JSON text frames over /shell/ws):
 *   client -> server: {type:"input", data} | {type:"resize", cols, rows}
 *   server -> client: UTF-8 text frames decoded lossily from PTY bytes
 * Only reachable when the server was started with --enable-shell (the sidebar
 * link is hidden otherwise, and the socket itself is auth + flag gated).
 */
import { h, icon } from "../util.js";

// Vendored xterm.js assets (UMD globals: window.Terminal, window.FitAddon).
const XTERM_JS = "/vendor/xterm.js";
const XTERM_CSS = "/vendor/xterm.css";
const XTERM_FIT = "/vendor/xterm-addon-fit.js";

let _loadPromise = null;

/** Load xterm.js + fit addon + stylesheet once, resolving when globals exist. */
function loadXterm() {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  if (_loadPromise) return _loadPromise;

  const loadScript = (src) =>
    new Promise((resolve, reject) => {
      // Reuse an existing tag if present.
      const existing = document.querySelector(`script[data-src="${src}"]`);
      if (existing) {
        if (existing.dataset.loaded === "1") return resolve();
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () => reject(new Error("load " + src)));
        return;
      }
      const s = document.createElement("script");
      s.src = src;
      s.async = false;
      s.dataset.src = src;
      s.addEventListener("load", () => {
        s.dataset.loaded = "1";
        resolve();
      });
      s.addEventListener("error", () => reject(new Error("load " + src)));
      document.head.appendChild(s);
    });

  const loadCss = (href) => {
    if (document.querySelector(`link[data-href="${href}"]`)) return;
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = href;
    l.dataset.href = href;
    document.head.appendChild(l);
  };

  loadCss(XTERM_CSS);
  // xterm core must be present before the fit addon evaluates.
  _loadPromise = loadScript(XTERM_JS)
    .then(() => loadScript(XTERM_FIT))
    .catch((e) => {
      _loadPromise = null;
      throw e;
    });
  return _loadPromise;
}

export class TerminalView {
  constructor() {
    this._ws = null;
    this._term = null;
    this._fit = null;
    this._ro = null;
    this._closed = false;
    this._mount = null;
    this._status = null;
    this._onWinResize = null;
  }

  mount(container) {
    const view = h("div.view.terminal-view");

    const status = h("span.term-status", { text: "loading…" });
    const clearBtn = h("button.btn.btn-ghost.btn-sm", {
      html: icon("refresh", 14) + "<span>Clear</span>",
      onclick: () => {
        if (this._term) {
          this._term.clear();
          this._term.focus();
        }
      },
    });
    const header = h("div.term-header", null, [
      h("div.term-dots", null, [h("i.term-dot.is-red"), h("i.term-dot.is-amber"), h("i.term-dot.is-green")]),
      h("span.term-title", null, [h("span", { html: icon("terminal", 15) }), h("span", { text: "server shell" })]),
      h("div.term-tools", null, [status, clearBtn]),
    ]);

    // xterm mounts into this element and manages its own DOM/canvas.
    const mountEl = h("div.term-xterm");
    const body = h("div.term-body", null, [mountEl]);

    view.append(h("div.term-window", null, [header, body]));
    container.appendChild(view);
    this._status = status;
    this._mount = mountEl;

    loadXterm()
      .then(() => {
        if (this._closed) return;
        this._initTerm();
        this._connect();
      })
      .catch(() => {
        this._status.textContent = "failed to load terminal";
      });
  }

  _initTerm() {
    const term = new window.Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: "#0b0e1a",
        foreground: "#c0caf5",
        cursor: "#7aa2f7",
        cursorAccent: "#0b0e1a",
        selectionBackground: "rgba(122,162,247,0.35)",
        black: "#1e1e28",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#c0caf5",
        brightBlack: "#414868",
        brightRed: "#ff899d",
        brightGreen: "#b9f27c",
        brightYellow: "#ffc777",
        brightBlue: "#8db0ff",
        brightMagenta: "#c9a9ff",
        brightCyan: "#a4e5ff",
        brightWhite: "#ffffff",
      },
    });
    this._term = term;

    // Fit addon keeps cols/rows in sync with the container size.
    const FitAddon =
      (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon;
    try {
      this._fit = new FitAddon();
      term.loadAddon(this._fit);
    } catch {
      this._fit = null;
    }

    term.open(this._mount);
    this._safeFit();
    term.focus();

    // Every keystroke / paste xterm produces is forwarded verbatim to the PTY.
    term.onData((data) => this._send({ type: "input", data }));
    // If xterm's own resize fires (e.g. font metrics), tell the server.
    term.onResize(({ cols, rows }) => this._send({ type: "resize", cols, rows }));

    // Re-fit on container resize (sidebar toggles, window resize, etc.).
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this._safeFit());
      this._ro.observe(this._mount);
    }
    this._onWinResize = () => this._safeFit();
    window.addEventListener("resize", this._onWinResize);
  }

  _safeFit() {
    if (!this._fit || !this._term) return;
    try {
      this._fit.fit();
    } catch {
      /* fit can throw if the element has zero size during transitions */
    }
  }

  _connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/shell/ws`);
    this._ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this._status.textContent = "connected";
      this._status.classList.add("is-live");
      // Send the true geometry so the remote PTY wraps correctly.
      this._safeFit();
      if (this._term) {
        this._send({ type: "resize", cols: this._term.cols, rows: this._term.rows });
      }
    };
    ws.onmessage = (ev) => {
      const data = typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data);
      if (this._term) this._term.write(data);
    };
    ws.onclose = () => {
      if (this._closed) return;
      this._status.textContent = "disconnected";
      this._status.classList.remove("is-live");
      if (this._term) this._term.write("\r\n\x1b[90m[session closed]\x1b[0m\r\n");
    };
    ws.onerror = () => {
      this._status.textContent = "error";
    };
  }

  _send(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  update() {}

  unmount() {
    this._closed = true;
    if (this._onWinResize) window.removeEventListener("resize", this._onWinResize);
    if (this._ro) {
      try {
        this._ro.disconnect();
      } catch {}
    }
    if (this._ws) {
      try {
        this._ws.close();
      } catch {}
    }
    if (this._term) {
      try {
        this._term.dispose();
      } catch {}
    }
    this._term = null;
    this._ws = null;
  }
}
