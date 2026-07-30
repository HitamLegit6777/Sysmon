/**
 * store.js
 * --------
 * A small reactive state container for the client. It holds the latest
 * snapshot, host info, process table, alert lists, and rolling history series
 * for charts. Views subscribe to slices and are re-rendered or updated when
 * the relevant slice changes. History is kept as flat typed-ish arrays for
 * fast chart rendering.
 */

import { clamp } from "./util.js";

/** Maximum number of history points retained client-side per series. */
const MAX_HISTORY = 900;

/** The series keys tracked in rolling history. */
const SERIES_KEYS = [
  "cpu",
  "mem",
  "swap",
  "load1",
  "netRx",
  "netTx",
  "diskR",
  "diskW",
  "temp",
];

class Store {
  constructor() {
    this.state = {
      connected: false,
      connecting: true,
      host: null,
      snapshot: null,
      processes: null,
      alerts: { active: [], history: [] },
      config: null,
      serverTimeOffset: 0,
      lastUpdate: 0,
      // Rolling history: { t: [...], cpu: [...], mem: [...], ... }
      history: { t: [] },
      // Per-core rolling history for the CPU heatmap: coreHistory[coreIndex] = [...]
      coreHistory: [],
      stats: {
        wsMessages: 0,
        droppedFrames: 0,
      },
    };
    for (const k of SERIES_KEYS) this.state.history[k] = [];

    this.listeners = new Map(); // topic -> Set<fn>
    this.anyListeners = new Set();
  }

  /* --------------------------- Subscription --------------------------- */

  /** Subscribe to a topic. Returns an unsubscribe function. */
  on(topic, fn) {
    if (!this.listeners.has(topic)) this.listeners.set(topic, new Set());
    this.listeners.get(topic).add(fn);
    return () => this.listeners.get(topic)?.delete(fn);
  }

  /** Subscribe to every emitted topic. */
  onAny(fn) {
    this.anyListeners.add(fn);
    return () => this.anyListeners.delete(fn);
  }

  emit(topic, payload) {
    const set = this.listeners.get(topic);
    if (set) {
      for (const fn of set) {
        try {
          fn(payload, this.state);
        } catch (err) {
          console.error(`store listener error on ${topic}:`, err);
        }
      }
    }
    for (const fn of this.anyListeners) {
      try {
        fn(topic, payload, this.state);
      } catch (err) {
        console.error("store any-listener error:", err);
      }
    }
  }

  get() {
    return this.state;
  }

  /* --------------------------- Mutations ------------------------------ */

  setConnection(connected, connecting) {
    this.state.connected = connected;
    this.state.connecting = connecting;
    this.emit("connection", { connected, connecting });
  }

  /** Apply a bootstrap payload received on WebSocket connect. */
  applyBootstrap(msg) {
    this.state.host = msg.host || null;
    this.state.snapshot = msg.snapshot || null;
    this.state.processes = msg.processes || null;
    this.state.alerts = msg.alerts || { active: [], history: [] };
    this.state.config = msg.config || null;
    if (msg.serverTime) {
      this.state.serverTimeOffset = msg.serverTime - Date.now();
    }

    // Seed rolling history from the server-provided history array.
    this.resetHistory();
    if (Array.isArray(msg.history)) {
      for (const p of msg.history) this.pushHistoryPoint(p);
    }

    this.state.lastUpdate = Date.now();
    this.emit("bootstrap", this.state);
    this.emit("host", this.state.host);
    this.emit("snapshot", this.state.snapshot);
    this.emit("processes", this.state.processes);
    this.emit("alerts", this.state.alerts);
    this.emit("history", this.state.history);
  }

  resetHistory() {
    this.state.history = { t: [] };
    for (const k of SERIES_KEYS) this.state.history[k] = [];
    this.state.coreHistory = [];
  }

  /** Append one compact history point (matches server HistoryPoint). */
  pushHistoryPoint(p) {
    const hist = this.state.history;
    hist.t.push(p.t);
    hist.cpu.push(p.cpu ?? 0);
    hist.mem.push(p.mem ?? 0);
    hist.swap.push(p.swap ?? 0);
    hist.load1.push(p.load1 ?? 0);
    hist.netRx.push(p.netRx ?? 0);
    hist.netTx.push(p.netTx ?? 0);
    hist.diskR.push(p.diskR ?? 0);
    hist.diskW.push(p.diskW ?? 0);
    hist.temp.push(p.temp ?? 0);

    // Trim to MAX_HISTORY.
    if (hist.t.length > MAX_HISTORY) {
      const excess = hist.t.length - MAX_HISTORY;
      hist.t.splice(0, excess);
      for (const k of SERIES_KEYS) hist[k].splice(0, excess);
    }
  }

  /** Update from a live snapshot message. */
  applySnapshot(snap) {
    this.state.snapshot = snap;
    this.state.lastUpdate = Date.now();

    // Track per-core history for the heatmap.
    if (snap.cpu && Array.isArray(snap.cpu.cores)) {
      const cores = snap.cpu.cores;
      if (this.state.coreHistory.length !== cores.length) {
        this.state.coreHistory = cores.map(() => []);
      }
      cores.forEach((c, i) => {
        const arr = this.state.coreHistory[i];
        arr.push(c.usage);
        if (arr.length > 120) arr.shift();
      });
    }

    this.emit("snapshot", snap);
  }

  applyHistoryPoint(p) {
    this.pushHistoryPoint(p);
    this.emit("historyPoint", p);
  }

  applyProcesses(procs) {
    this.state.processes = procs;
    this.emit("processes", procs);
  }

  applyAlertRules(rules, active = []) {
    if (!this.state.config) this.state.config = {};
    if (!this.state.config.alerts) this.state.config.alerts = {};
    this.state.config.alerts.rules = Array.isArray(rules) ? rules : [];
    if (!this.state.alerts) this.state.alerts = { active: [], history: [] };
    this.state.alerts.active = Array.isArray(active) ? active : [];
    this.emit("config", this.state.config);
    this.emit("alertRules", this.state.config.alerts.rules);
    this.emit("alerts", this.state.alerts);
  }

  applyAlertEvent(ev) {
    // Maintain the active list and history from streamed transitions.
    const alerts = this.state.alerts;
    alerts.history = alerts.history || [];
    alerts.history.push(ev);
    if (alerts.history.length > 200) alerts.history.shift();

    if (ev.transition === "fired") {
      if (!alerts.active.find((a) => a.id === ev.id)) {
        alerts.active.push({
          id: ev.id,
          severity: ev.severity,
          message: ev.message,
          value: ev.value,
          threshold: ev.threshold,
          since: ev.timestamp,
          active: true,
        });
      }
    } else if (ev.transition === "cleared") {
      alerts.active = alerts.active.filter((a) => a.id !== ev.id);
    }

    this.emit("alertEvent", ev);
    this.emit("alerts", alerts);
  }

  /* --------------------------- Selectors ------------------------------ */

  /** Return the last value of a history series. */
  lastValue(key) {
    const arr = this.state.history[key];
    return arr && arr.length ? arr[arr.length - 1] : 0;
  }

  /** Return a slice of a history series (last n points). */
  seriesLastN(key, n) {
    const arr = this.state.history[key] || [];
    return n >= arr.length ? arr.slice() : arr.slice(arr.length - n);
  }

  /** Compute min/max/avg over a series' last n points. */
  seriesStats(key, n = MAX_HISTORY) {
    const arr = this.seriesLastN(key, n);
    if (!arr.length) return { min: 0, max: 0, avg: 0, last: 0 };
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const v of arr) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    return { min, max, avg: sum / arr.length, last: arr[arr.length - 1] };
  }

  /** Estimated server time accounting for clock offset. */
  serverNow() {
    return Date.now() + this.state.serverTimeOffset;
  }
}

// Export a singleton store shared across the app.
export const store = new Store();
export default store;
