/**
 * app.js
 * ------
 * Application entry point. Builds the app shell (sidebar + topbar + content),
 * registers the routes to their view modules, connects the WebSocket, and
 * wires store updates through to the active view. Also owns cross-cutting
 * concerns: theme persistence, mobile drawer, pause control, and alert toasts.
 */

import { h, qs } from "./util.js";
import store from "./store.js";
import ws from "./ws.js";
import router from "./router.js";
import { buildSidebar } from "./components/sidebar.js";
import { buildTopbar } from "./components/topbar.js";
import { notify } from "./components/toast.js";

import { OverviewView } from "./views/overview.js";
import { CpuView } from "./views/cpu.js";
import { MemoryView } from "./views/memory.js";
import { NetworkView } from "./views/network.js";
import { DiskView } from "./views/disk.js";
import { ProcessesView } from "./views/processes.js";
import { ThermalView } from "./views/thermal.js";
import { AlertsView } from "./views/alerts.js";
import { InfoView } from "./views/info.js";

const THEME_KEY = "sysmon.theme";
const ACCENT_KEY = "sysmon.accent";

function loadTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) document.documentElement.dataset.theme = saved;
  const accent = localStorage.getItem(ACCENT_KEY);
  if (accent) document.documentElement.dataset.accent = accent;
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme || "dark";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = next === "dark" ? "#0a0e17" : "#eef1f7";
}

function buildShell() {
  const app = qs("#app");
  app.classList.add("app");

  const sidebar = buildSidebar();

  const content = h("div.content", null, [h("div.content-inner#view-root")]);
  const topbar = buildTopbar({
    onToggleTheme: toggleTheme,
    onToggleMenu: () => app.classList.toggle("drawer-open"),
  });
  const main = h("div.main", null, [topbar, content]);

  app.replaceChildren(sidebar, main);

  // Mobile drawer scrim closes the menu.
  const scrim = qs("#scrim");
  if (scrim) {
    scrim.addEventListener("click", () => app.classList.remove("drawer-open"));
  }
  // Sync scrim visibility with drawer state.
  const obs = new MutationObserver(() => {
    if (scrim) scrim.classList.toggle("show", app.classList.contains("drawer-open"));
  });
  obs.observe(app, { attributes: true, attributeFilter: ["class"] });

  return qs("#view-root", content);
}

function registerRoutes() {
  router.register("overview", () => new OverviewView());
  router.register("cpu", () => new CpuView());
  router.register("memory", () => new MemoryView());
  router.register("network", () => new NetworkView());
  router.register("disk", () => new DiskView());
  router.register("processes", () => new ProcessesView());
  router.register("thermal", () => new ThermalView());
  router.register("alerts", () => new AlertsView());
  router.register("info", () => new InfoView());
  router.setDefault("overview");
}

function wireStoreToRouter() {
  // Any store update is forwarded to the active view's update() hook.
  store.onAny((topic, payload, state) => {
    router.dispatch(topic, payload, state);
  });
}

function wireAlerts() {
  store.on("alertEvent", (ev) => {
    if (ev.transition === "fired") {
      const kind = ev.severity === "critical" ? "danger" : "warning";
      notify[kind](
        (ev.severity === "critical" ? "Critical: " : "Alert: ") + ev.id,
        ev.message,
        "alert-" + ev.id
      );
    } else if (ev.transition === "cleared") {
      notify.success("Resolved: " + ev.id, ev.message, "alert-" + ev.id);
    }
  });

  let wasConnected = null;
  store.on("connection", ({ connected }) => {
    if (wasConnected === null) {
      wasConnected = connected;
      return;
    }
    if (connected && !wasConnected) {
      notify.success("Reconnected", "Live stream restored", "conn");
    } else if (!connected && wasConnected) {
      notify.warning("Disconnected", "Attempting to reconnect…", "conn");
    }
    wasConnected = connected;
  });
}

function boot() {
  loadTheme();
  const viewRoot = buildShell();
  registerRoutes();
  wireStoreToRouter();
  wireAlerts();
  router.start(viewRoot);
  ws.connect();

  // Expose a tiny debug handle.
  window.__sysmon = { store, ws, router };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
