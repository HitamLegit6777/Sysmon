/**
 * ws.js
 * -----
 * WebSocket client with automatic reconnection (exponential backoff with
 * jitter), a heartbeat/liveness ping, and dispatch of typed messages into the
 * reactive store. Also exposes a small command API so views can request data
 * (for example a fuller history) without extra HTTP calls.
 */

import store from "./store.js";
import { clamp } from "./util.js";

class WSClient {
  constructor(store) {
    this.store = store;
    this.socket = null;
    this.url = this._buildUrl();
    this.reconnectAttempts = 0;
    this.maxBackoff = 15000;
    this.baseBackoff = 500;
    this.shouldReconnect = true;
    this.pingTimer = null;
    this.pongDeadline = 0;
    this.lastMessageAt = 0;
    this.connectListeners = [];
  }

  _buildUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }

  connect() {
    this.shouldReconnect = true;
    this._open();
  }

  _open() {
    this.store.setConnection(false, true);
    try {
      this.socket = new WebSocket(this.url);
    } catch (err) {
      console.error("ws construct failed", err);
      this._scheduleReconnect();
      return;
    }

    this.socket.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();
      this.store.setConnection(true, false);
      this._startHeartbeat();
      for (const fn of this.connectListeners) {
        try {
          fn();
        } catch (_) {}
      }
    });

    this.socket.addEventListener("message", (ev) => {
      this.lastMessageAt = Date.now();
      this._handleMessage(ev.data);
    });

    this.socket.addEventListener("close", () => {
      this._stopHeartbeat();
      this.store.setConnection(false, this.shouldReconnect);
      if (this.shouldReconnect) this._scheduleReconnect();
    });

    this.socket.addEventListener("error", () => {
      // The close handler will drive reconnection.
      try {
        this.socket.close();
      } catch (_) {}
    });
  }

  _handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (err) {
      return;
    }
    this.store.state.stats.wsMessages++;

    switch (msg.type) {
      case "bootstrap":
        this.store.applyBootstrap(msg);
        break;
      case "snapshot":
        this.store.applySnapshot(msg.data);
        break;
      case "history":
        this.store.applyHistoryPoint(msg.data);
        break;
      case "processes":
        this.store.applyProcesses(msg.data);
        break;
      case "alert":
        this.store.applyAlertEvent(msg.data);
        break;
      case "alertRules":
        this.store.applyAlertRules(msg.data, msg.active);
        break;
      case "pong":
        this.pongDeadline = 0;
        break;
      case "lagged":
        this.store.state.stats.droppedFrames += msg.skipped || 0;
        break;
      case "historyFull":
        // A requested full history resend: reseed the store history.
        this.store.resetHistory();
        if (Array.isArray(msg.data)) {
          for (const p of msg.data) this.store.pushHistoryPoint(p);
        }
        this.store.emit("history", this.store.state.history);
        break;
      case "processesFull":
        this.store.applyProcesses(msg.data);
        break;
      case "snapshotFull":
        this.store.applySnapshot(msg.data);
        break;
      default:
        break;
    }
  }

  /** Send a JSON command to the server. */
  send(obj) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(obj));
        return true;
      } catch (err) {
        return false;
      }
    }
    return false;
  }

  requestHistory(points = 600) {
    this.send({ cmd: "history", points });
  }

  requestProcesses() {
    this.send({ cmd: "processes" });
  }

  onConnect(fn) {
    this.connectListeners.push(fn);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.pingTimer = setInterval(() => {
      // If we have not heard anything recently, actively ping.
      const idle = Date.now() - this.lastMessageAt;
      if (idle > 8000) {
        this.pongDeadline = Date.now() + 6000;
        this.send({ cmd: "ping" });
      }
      // If a ping went unanswered past its deadline, force a reconnect.
      if (this.pongDeadline && Date.now() > this.pongDeadline) {
        this.pongDeadline = 0;
        try {
          this.socket.close();
        } catch (_) {}
      }
    }, 4000);
  }

  _stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  _scheduleReconnect() {
    this.reconnectAttempts++;
    const backoff = clamp(
      this.baseBackoff * Math.pow(1.7, this.reconnectAttempts),
      this.baseBackoff,
      this.maxBackoff
    );
    const jitter = Math.random() * 0.3 * backoff;
    const delay = backoff + jitter;
    setTimeout(() => {
      if (this.shouldReconnect) this._open();
    }, delay);
  }

  disconnect() {
    this.shouldReconnect = false;
    this._stopHeartbeat();
    if (this.socket) {
      try {
        this.socket.close();
      } catch (_) {}
    }
  }
}

export const ws = new WSClient(store);
export default ws;
