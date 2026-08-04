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
import { fetchMe, showLogin, currentUser } from "./components/auth.js";
import {
  applyAllPrefs,
  toggleTheme,
  openSettings,
  setPref,
  getPref,
} from "./components/settings.js";
import {
  registerCommands,
  registerShortcut,
  installShortcuts,
  openPalette,
  openShortcutHelp,
} from "./components/commandpalette.js";

import { OverviewView } from "./views/overview.js";
import { CpuView } from "./views/cpu.js";
import { MemoryView } from "./views/memory.js";
import { NetworkView } from "./views/network.js";
import { DiskView } from "./views/disk.js";
import { ProcessesView } from "./views/processes.js";
import { ThermalView } from "./views/thermal.js";
import { AlertsView } from "./views/alerts.js";
import { InfoView } from "./views/info.js";
import { ProfileView } from "./views/profile.js";
import { TerminalView } from "./views/terminal.js";
import { FleetView } from "./views/fleet.js";

function buildShell() {
  const app = qs("#app");
  // Reset any leftover state from the login screen (showLogin sets
  // class="auth-screen" and injects an auth background/shell). Without this
  // the dashboard mounts underneath the auth layout and only appears correct
  // after a manual refresh.
  app.className = "app";
  app.replaceChildren();

  const me = currentUser() || {};
  const sidebar = buildSidebar({ shellEnabled: !!me.shellEnabled });

  const content = h("div.content", null, [h("div.content-inner#view-root")]);
  const topbar = buildTopbar({
    onToggleTheme: toggleTheme,
    onToggleMenu: () => app.classList.toggle("drawer-open"),
    onOpenSettings: openSettings,
    onOpenPalette: openPalette,
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
  router.register("fleet", () => new FleetView());
  router.register("cpu", () => new CpuView());
  router.register("memory", () => new MemoryView());
  router.register("network", () => new NetworkView());
  router.register("disk", () => new DiskView());
  router.register("processes", () => new ProcessesView());
  router.register("thermal", () => new ThermalView());
  router.register("alerts", () => new AlertsView());
  router.register("info", () => new InfoView());
  router.register("profile", () => new ProfileView());
  router.register("terminal", () => new TerminalView());
  router.setDefault("overview");
}

/* Register command-palette entries and global keyboard shortcuts. */
function wireCommands() {
  const navs = [
    ["overview", "Overview", "dashboard", "g o"],
    ["cpu", "CPU", "cpu", "g c"],
    ["memory", "Memory", "memory", "g m"],
    ["network", "Network", "network", "g n"],
    ["disk", "Disk", "disk", "g d"],
    ["processes", "Processes", "processes", "g p"],
    ["thermal", "Thermal", "thermal", "g t"],
    ["alerts", "Alerts", "alerts", "g a"],
    ["info", "System Info", "info", "g i"],
  ];
  registerCommands(
    navs.map(([id, title, icon, shortcut]) => ({
      id: "nav-" + id,
      title: "Go to " + title,
      subtitle: "Navigation",
      section: "Navigate",
      icon,
      shortcut,
      keywords: [id, title],
      run: () => router.navigate(id),
    }))
  );
  registerCommands([
    {
      id: "toggle-theme",
      title: "Toggle light / dark theme",
      section: "Actions",
      icon: "sun",
      keywords: ["theme", "dark", "light", "appearance"],
      run: () => toggleTheme(),
    },
    {
      id: "open-settings",
      title: "Open settings",
      section: "Actions",
      icon: "settings",
      shortcut: ",",
      keywords: ["preferences", "config", "accent", "density"],
      run: () => openSettings(),
    },
    {
      id: "toggle-pause",
      title: "Pause / resume live stream",
      section: "Actions",
      icon: "pause",
      keywords: ["freeze", "stop", "stream"],
      run: () => window.dispatchEvent(new CustomEvent("sysmon:toggle-pause")),
    },
    {
      id: "cycle-density",
      title: "Cycle UI density",
      section: "Actions",
      icon: "layers",
      keywords: ["compact", "cozy", "comfy", "spacing"],
      run: () => {
        const order = ["compact", "cozy", "comfy"];
        const cur = getPref("density");
        setPref("density", order[(order.indexOf(cur) + 1) % order.length]);
      },
    },
    {
      id: "show-shortcuts",
      title: "Show keyboard shortcuts",
      section: "Help",
      icon: "info",
      shortcut: "?",
      keywords: ["help", "keys", "hotkeys"],
      run: () => openShortcutHelp(),
    },
  ]);

  // Global shortcuts.
  registerShortcut({ combo: "mod+k", description: "Open command palette", group: "General", handler: () => openPalette(), allowInInput: true });
  registerShortcut({ combo: "?", description: "Show keyboard shortcuts", group: "General", handler: () => openShortcutHelp() });
  registerShortcut({ combo: ",", description: "Open settings", group: "General", handler: () => openSettings() });
  registerShortcut({ combo: "shift+t", description: "Toggle theme", group: "General", handler: () => toggleTheme() });
  registerShortcut({ combo: "space", description: "Pause / resume stream", group: "General", handler: (e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent("sysmon:toggle-pause")); } });

  // "g" then a letter jumps to a section (vim-style).
  const gMap = { o: "overview", c: "cpu", m: "memory", n: "network", d: "disk", p: "processes", t: "thermal", a: "alerts", i: "info" };
  let gPending = false;
  let gTimer = null;
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable)) return;
    if (gPending) {
      const dest = gMap[e.key.toLowerCase()];
      gPending = false;
      clearTimeout(gTimer);
      if (dest) {
        e.preventDefault();
        router.navigate(dest);
      }
      return;
    }
    if (e.key === "g" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      gPending = true;
      gTimer = setTimeout(() => (gPending = false), 900);
    }
  });
  Object.entries(gMap).forEach(([k, dest]) => {
    registerShortcut({ combo: "g " + k, description: "Go to " + dest, group: "Navigate", handler: () => {}, when: () => false });
  });
  installShortcuts();
}

function wireStoreToRouter() {
  // Any store update is forwarded to the active view's update() hook.
  store.onAny((topic, payload, state) => {
    router.dispatch(topic, payload, state);
  });
}

function wirePause() {
  window.addEventListener("sysmon:pause", (event) => {
    if (event.detail?.paused) ws.disconnect();
    else ws.connect();
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

function startDashboard() {
  // Apply server-persisted preferences (falls back to localStorage defaults).
  const me = currentUser();
  if (me && me.preferences) {
    if (me.preferences.theme) setPref("theme", me.preferences.theme);
    if (me.preferences.accent) setPref("accent", me.preferences.accent);
  }
  applyAllPrefs();
  const viewRoot = buildShell();
  registerRoutes();
  wireCommands();
  wireStoreToRouter();
  wireAlerts();
  wirePause();
  router.start(viewRoot);
  ws.connect();

  // Expose a tiny debug handle.
  window.__sysmon = { store, ws, router, openPalette, openSettings, currentUser };
}

async function boot() {
  // Gate the entire app behind authentication.
  const me = await fetchMe();
  if (!me) {
    showLogin(() => startDashboard());
    return;
  }
  startDashboard();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
