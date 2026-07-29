/**
 * sidebar.js
 * ----------
 * The left navigation sidebar. Renders the brand, grouped navigation items
 * with icons, live alert badges, and a host summary footer. Navigation uses
 * the hash router. The sidebar can collapse to an icon rail.
 */

import { h, icon } from "../util.js";
import router from "../router.js";
import store from "../store.js";

const NAV = [
  {
    section: "Monitor",
    items: [
      { path: "overview", label: "Overview", icon: "dashboard" },
      { path: "cpu", label: "CPU", icon: "cpu" },
      { path: "memory", label: "Memory", icon: "memory" },
      { path: "network", label: "Network", icon: "network" },
      { path: "disk", label: "Disk", icon: "disk" },
      { path: "processes", label: "Processes", icon: "processes" },
      { path: "thermal", label: "Thermal", icon: "thermal" },
    ],
  },
  {
    section: "System",
    items: [
      { path: "alerts", label: "Alerts", icon: "alerts", badge: "alerts" },
      { path: "info", label: "System Info", icon: "server" },
      { path: "terminal", label: "Terminal", icon: "terminal", requiresShell: true },
      { path: "profile", label: "Profile", icon: "user" },
    ],
  },
];

export function buildSidebar(opts = {}) {
  const shellEnabled = !!opts.shellEnabled;
  const navItems = new Map();
  const badges = new Map();

  const nav = h("nav.sidebar-nav");
  for (const group of NAV) {
    nav.appendChild(h("div.nav-section-label", { text: group.section }));
    for (const item of group.items) {
      if (item.requiresShell && !shellEnabled) continue;
      const badgeEl = h("span.nav-badge.hidden", { text: "0" });
      if (item.badge) badges.set(item.badge, badgeEl);
      const el = h(
        "div.nav-item",
        {
          dataset: { path: item.path },
          onClick: () => router.navigate(item.path),
        },
        [
          h("span.icon", { html: icon(item.icon, 18) }),
          h("span.nav-label", { text: item.label }),
          item.badge ? badgeEl : null,
        ]
      );
      navItems.set(item.path, el);
      nav.appendChild(el);
    }
  }

  const footer = h("div.sidebar-footer", null, [
    h("div.host-avatar", { text: "?" }),
    h("div.host-meta", null, [
      h("div.host-name.truncate", { text: "loading…" }),
      h("div.host-sub.truncate", { text: "" }),
    ]),
  ]);

  const el = h("aside.sidebar", null, [
    h("div.sidebar-brand", null, [
      h("div.brand-logo", { html: icon("activity", 20) }),
      h("div.brand-name", { html: 'Sys<span>Mon</span>' }),
    ]),
    nav,
    footer,
  ]);

  // Highlight the active route.
  const setActive = (path) => {
    for (const [p, item] of navItems) {
      item.classList.toggle("active", p === path);
    }
  };
  router.onChange(setActive);
  setActive(router.currentPath());

  // Update alert badge counts.
  const updateBadges = () => {
    const active = store.get().alerts?.active || [];
    const badgeEl = badges.get("alerts");
    if (badgeEl) {
      if (active.length > 0) {
        badgeEl.textContent = String(active.length);
        badgeEl.classList.remove("hidden");
      } else {
        badgeEl.classList.add("hidden");
      }
    }
  };
  store.on("alerts", updateBadges);
  store.on("bootstrap", updateBadges);

  // Update host footer.
  const updateHost = () => {
    const host = store.get().host;
    if (!host) return;
    const name = footer.querySelector(".host-name");
    const sub = footer.querySelector(".host-sub");
    const avatar = footer.querySelector(".host-avatar");
    name.textContent = host.hostname || "unknown";
    name.title = host.hostname || "";
    sub.textContent = host.osName
      ? `${host.osName} ${host.osVersion || ""}`.trim()
      : host.kernel || "";
    avatar.textContent = (host.hostname || "?").charAt(0).toUpperCase();
  };
  store.on("host", updateHost);
  store.on("bootstrap", updateHost);

  return el;
}

export default buildSidebar;
