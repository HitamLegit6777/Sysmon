/**
 * terminal.js
 * -----------
 * A lightweight PTY terminal view. Connects to /shell/ws, streams keystrokes to
 * the server's shell, and renders output. To stay dependency-free it uses a
 * pre-formatted text buffer with a minimal ANSI SGR (color) and control
 * interpreter rather than bundling xterm.js.
 *
 * Only reachable when the server was started with --enable-shell (the sidebar
 * link is hidden otherwise, and the socket itself is auth+flag gated).
 */
import { h, icon } from "../util.js";

// Basic 16-color ANSI palette (SGR 30-37 / 90-97).
const ANSI = [
  "#1e1e28", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5",
  "#414868", "#ff899d", "#b9f27c", "#ffc777", "#8db0ff", "#c9a9ff", "#a4e5ff", "#ffffff",
];

export class TerminalView {
  constructor() {
    this._ws = null;
    this._out = null;
    this._buf = "";
    this._closed = false;
  }

  mount(container) {
    const view = h("div.view.terminal-view");

    const status = h("span.term-status", { text: "connecting…" });
    const clearBtn = h("button.btn.btn-ghost.btn-sm", { html: icon("refresh", 14) + "<span>Clear</span>", onclick: () => { this._out.textContent = ""; } });
    const header = h("div.term-header", null, [
      h("div.term-dots", null, [h("i.term-dot.is-red"), h("i.term-dot.is-amber"), h("i.term-dot.is-green")]),
      h("span.term-title", null, [h("span", { html: icon("terminal", 15) }), h("span", { text: "server shell" })]),
      h("div.term-tools", null, [status, clearBtn]),
    ]);

    this._out = h("pre.term-output", { tabindex: "0" });
    const body = h("div.term-body", null, [this._out]);

    view.append(h("div.term-window", null, [header, body]));
    container.appendChild(view);
    this._status = status;

    this._connect();

    // Capture keystrokes when the terminal has focus.
    this._keyHandler = (e) => this._onKey(e);
    this._out.addEventListener("keydown", this._keyHandler);
    this._out.addEventListener("click", () => this._out.focus());
    setTimeout(() => this._out.focus(), 50);

    // Handle paste.
    this._pasteHandler = (e) => {
      const text = (e.clipboardData || window.clipboardData).getData("text");
      if (text) { this._send({ type: "input", data: text }); e.preventDefault(); }
    };
    this._out.addEventListener("paste", this._pasteHandler);
  }

  _connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/shell/ws`);
    this._ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this._status.textContent = "connected";
      this._status.classList.add("is-live");
      this._sendResize();
    };
    ws.onmessage = (ev) => {
      const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
      this._write(text);
    };
    ws.onclose = () => {
      if (this._closed) return;
      this._status.textContent = "disconnected";
      this._status.classList.remove("is-live");
      this._write("\r\n\x1b[90m[session closed]\x1b[0m\r\n");
    };
    ws.onerror = () => {
      this._status.textContent = "error";
    };
  }

  _send(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) this._ws.send(JSON.stringify(obj));
  }

  _sendResize() {
    // Estimate cols/rows from the output box using a monospace cell size.
    const style = getComputedStyle(this._out);
    const fontSize = parseFloat(style.fontSize) || 13;
    const cellW = fontSize * 0.6;
    const cellH = fontSize * 1.35;
    const cols = Math.max(20, Math.floor(this._out.clientWidth / cellW));
    const rows = Math.max(6, Math.floor(this._out.clientHeight / cellH));
    this._send({ type: "resize", cols, rows });
  }

  _onKey(e) {
    if (this._ws?.readyState !== WebSocket.OPEN) return;
    // Let copy (Ctrl/Cmd+C with a selection) pass through to the browser.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && String(getSelection())) return;
    let data = null;
    if (e.key === "Enter") data = "\r";
    else if (e.key === "Backspace") data = "\x7f";
    else if (e.key === "Tab") data = "\t";
    else if (e.key === "Escape") data = "\x1b";
    else if (e.key === "ArrowUp") data = "\x1b[A";
    else if (e.key === "ArrowDown") data = "\x1b[B";
    else if (e.key === "ArrowRight") data = "\x1b[C";
    else if (e.key === "ArrowLeft") data = "\x1b[D";
    else if (e.ctrlKey && e.key.length === 1) {
      // Control characters (Ctrl+C, Ctrl+D, ...).
      const code = e.key.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
    } else if (e.key.length === 1) data = e.key;

    if (data !== null) {
      this._send({ type: "input", data });
      e.preventDefault();
    }
  }

  /**
   * Minimal terminal writer: honours \r, \b, and a subset of ANSI SGR color
   * codes; strips other escape sequences so raw control bytes don't leak.
   */
  _write(text) {
    const out = this._out;
    // Fast path: append with a light SGR → span transform.
    const frag = document.createDocumentFragment();
    // Split on ESC sequences.
    const parts = text.split(/\x1b\[([0-9;]*)m/);
    let curColor = null;
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        // SGR parameters.
        const codes = parts[i].split(";").filter(Boolean).map(Number);
        if (codes.length === 0 || codes.includes(0)) curColor = null;
        for (const c of codes) {
          if (c >= 30 && c <= 37) curColor = ANSI[c - 30];
          else if (c >= 90 && c <= 97) curColor = ANSI[c - 90 + 8];
        }
        continue;
      }
      let chunk = parts[i];
      if (!chunk) continue;
      // Strip other CSI/OSC sequences we don't render.
      chunk = chunk.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][AB012]/g, "");
      // Handle carriage-return by trimming back to line start is complex in a
      // pre; for a monitor shell we simply normalize lone \r before \n away.
      chunk = chunk.replace(/\r(?!\n)/g, "").replace(/\x07/g, "");
      if (!chunk) continue;
      if (curColor) {
        frag.appendChild(h("span", { text: chunk, style: { color: curColor } }));
      } else {
        frag.appendChild(document.createTextNode(chunk));
      }
    }
    out.appendChild(frag);
    // Cap the scrollback to avoid unbounded growth.
    const MAX = 4000;
    while (out.childNodes.length > MAX) out.removeChild(out.firstChild);
    out.scrollTop = out.scrollHeight;
  }

  update() {}

  unmount() {
    this._closed = true;
    if (this._ws) { try { this._ws.close(); } catch {} }
    if (this._out) {
      this._out.removeEventListener("keydown", this._keyHandler);
      this._out.removeEventListener("paste", this._pasteHandler);
    }
  }
}
