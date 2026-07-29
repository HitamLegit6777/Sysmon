/**
 * alerts.js
 * ---------
 * The alerts view: active alerts as prominent cards, the configured rule set
 * with current values and pass/fail state, and a chronological event log of
 * recent fired/cleared transitions.
 */

import {
  h,
  icon,
  fmtDateTime,
  timeAgo,
  cssVar,
  fmtPct,
  usageColor,
  clamp,
} from "../util.js";
import store from "../store.js";
import { card, badge } from "../components/card.js";

export class AlertsView {
  constructor() {
    this._unsubs = [];
    this._expanded = new Set();
  }

  mount(container) {
    const view = h("div.view");

    this.activeWrap = h("div.grid.grid-auto");
    const activeCard = card({ title: "Active Alerts", iconName: "alerts", accent: true }, [this.activeWrap]);

    this.rulesWrap = h("div.col.gap-2");
    const rulesCard = card({ title: "Rules", iconName: "layers" }, [this.rulesWrap]);

    this.logWrap = h("div.col.gap-2");
    const logCard = card({ title: "Event Log", iconName: "clock" }, [this.logWrap]);

    view.append(
      h("div.section", null, activeCard),
      h("div.grid.grid-2.section", null, [rulesCard, logCard])
    );
    container.appendChild(view);

    this._unsubs.push(store.on("alerts", () => this._refresh()));
    this._unsubs.push(store.on("alertEvent", () => this._refresh()));
    this._unsubs.push(store.on("snapshot", () => this._refreshRules()));
    this._unsubs.push(store.on("bootstrap", () => this._refresh()));
    this._refresh();
  }

  _refresh() {
    this._refreshActive();
    this._refreshRules();
    this._refreshLog();
  }

  _refreshActive() {
    const active = store.get().alerts?.active || [];
    if (active.length === 0) {
      this.activeWrap.replaceChildren(
        h("div.empty-state", null, [
          h("span", { html: icon("check", 40), style: { color: cssVar("--success") } }),
          h("div.title", { text: "All systems nominal" }),
          h("div.muted", { text: "No active alerts" }),
        ])
      );
      return;
    }
    this.activeWrap.replaceChildren(
      ...active.map((a) => {
        const kind = a.severity === "critical" ? "danger" : "warning";
        return h("div.card." + kind, { style: { borderLeft: `3px solid var(--${kind})` } }, [
          h("div.row-between", null, [
            h("div.row.gap-2", null, [
              h("span", { html: icon("alerts", 18), style: { color: `var(--${kind})` } }),
              h("span.cell-strong", { text: a.id }),
            ]),
            badge(a.severity, kind),
          ]),
          h("div.text-2", { text: a.message, style: { margin: "8px 0" } }),
          h("div.row-between.mono", { style: { fontSize: "12px" } }, [
            h("span.text-3", { text: `value ${a.value} / threshold ${a.threshold}` }),
            h("span.text-3", { text: "since " + timeAgo(a.since) }),
          ]),
        ]);
      })
    );
  }

  _refreshRules() {
    const cfg = store.get().config;
    const rules = cfg?.alerts?.rules || (store.get().alerts?.rulesConfig ?? []);
    const snap = store.get().snapshot;
    const activeIds = new Set((store.get().alerts?.active || []).map((a) => a.id));

    // Rules come from the /api/config bootstrap; fall back to a static list.
    const ruleList = rules && rules.length ? rules : DEFAULT_RULES;

    this.rulesWrap.replaceChildren(
      ...ruleList.map((r) => {
        const value = snap ? resolveMetric(r.metric, snap) : null;
        const firing = activeIds.has(r.id);
        const kind = firing
          ? r.severity === "critical"
            ? "danger"
            : "warning"
          : "neutral";
        const isOpen = this._expanded.has(r.id);

        const header = h(
          "div.rule-head",
          {
            role: "button",
            title: "Click for details",
            onClick: () => {
              if (this._expanded.has(r.id)) this._expanded.delete(r.id);
              else this._expanded.add(r.id);
              this._refreshRules();
            },
          },
          [
            h("div.row.gap-2", { style: { minWidth: 0, alignItems: "center" } }, [
              h("span.chevron" + (isOpen ? ".open" : ""), { html: icon("chevron", 14) }),
              h("div.col", { style: { minWidth: 0 } }, [
                h("span.cell-strong", { text: r.id }),
                h("span.text-3", {
                  text: `${r.metric} ${r.operator} ${r.threshold}`,
                  style: { fontSize: "11px" },
                }),
              ]),
            ]),
            h("div.row.gap-2", { style: { alignItems: "center" } }, [
              value != null ? h("span.mono.text-2", { text: this._fmtValue(r.metric, value) }) : null,
              badge(firing ? "firing" : "ok", firing ? kind : "success"),
            ]),
          ]
        );

        const children = [header];
        if (isOpen) children.push(this._ruleDetail(r, value, firing));
        return h("div.rule-item" + (firing ? ".firing" : ""), null, children);
      })
    );
  }

  // Format a metric value with a sensible unit.
  _fmtValue(metric, v) {
    if (v == null) return "-";
    if (metric.includes("Percent") || metric === "cpu.usage" || metric === "cpu.iowait")
      return fmtPct(v, 1);
    if (metric.includes("temp") || metric === "thermal.maxTemp") return v.toFixed(1) + "\u00b0C";
    return String(v);
  }

  // Build the expandable detail panel for a rule.
  _ruleDetail(r, value, firing) {
    // Progress bar: how close current value is to threshold (0..1, clamped 1.3x).
    const thr = Number(r.threshold) || 0;
    const pct = thr > 0 && value != null ? clamp((value / thr) * 100, 0, 130) : 0;
    const barColor = firing ? cssVar("--danger") : usageColor(Math.min(pct, 100));
    const durSec = Math.round((r.durationMs || 0) / 1000);

    const kv = (label, val) =>
      h("div.rule-kv", null, [
        h("span.k", { text: label }),
        h("span.v", { text: val }),
      ]);

    return h("div.rule-detail", null, [
      r.message ? h("div.rule-msg", { text: r.message }) : null,
      // value vs threshold bar
      h("div.rule-bar-wrap", null, [
        h("div.rule-bar-track", null, [
          h("i.rule-bar-fill", { style: { width: Math.min(pct, 100) + "%", background: barColor } }),
          // threshold marker at value==threshold => 100/1.3 of a 130% scale
          h("i.rule-bar-thr", { style: { left: (100 / 130) * 100 + "%" } }),
        ]),
        h("div.rule-bar-labels", null, [
          h("span", { text: "now " + (value != null ? this._fmtValue(r.metric, value) : "-") }),
          h("span", { text: "limit " + this._fmtValue(r.metric, thr) }),
        ]),
      ]),
      h("div.rule-kv-grid", null, [
        kv("Metric", r.metric),
        kv("Condition", `${r.operator} ${r.threshold}`),
        kv("Severity", r.severity),
        kv("Sustained for", durSec > 0 ? durSec + "s" : "instant"),
        kv("Current", value != null ? this._fmtValue(r.metric, value) : "n/a"),
        kv("Status", firing ? "FIRING" : "OK"),
      ]),
    ]);
  }

  _refreshLog() {
    const history = (store.get().alerts?.history || []).slice().reverse().slice(0, 50);
    if (history.length === 0) {
      this.logWrap.replaceChildren(h("div.muted", { text: "No events yet" }));
      return;
    }
    this.logWrap.replaceChildren(
      ...history.map((ev) => {
        const fired = ev.transition === "fired";
        const kind = fired
          ? ev.severity === "critical"
            ? "danger"
            : "warning"
          : "success";
        return h("div.row-between", { style: { padding: "6px 0", borderBottom: "1px solid var(--border)" } }, [
          h("div.row.gap-2", { style: { minWidth: 0 } }, [
            h("span.status-dot" + (fired ? ".offline" : ".online")),
            h("div.col", { style: { minWidth: 0 } }, [
              h("span.truncate", { text: `${ev.id}: ${ev.message}` }),
              h("span.text-3.mono", { text: fmtDateTime(ev.timestamp), style: { fontSize: "11px" } }),
            ]),
          ]),
          badge(ev.transition, kind, false),
        ]);
      })
    );
  }

  update() {}

  unmount() {
    for (const u of this._unsubs) u();
    this._unsubs = [];
  }
}

const DEFAULT_RULES = [
  { id: "cpu-high", metric: "cpu.usage", operator: ">", threshold: 90, severity: "warning" },
  { id: "mem-high", metric: "memory.usedPercent", operator: ">", threshold: 90, severity: "warning" },
  { id: "disk-full", metric: "disk.maxUsedPercent", operator: ">", threshold: 92, severity: "critical" },
  { id: "load-high", metric: "load.load1PerCore", operator: ">", threshold: 2, severity: "warning" },
  { id: "temp-high", metric: "thermal.maxTemp", operator: ">", threshold: 85, severity: "warning" },
  { id: "swap-high", metric: "memory.swapUsedPercent", operator: ">", threshold: 80, severity: "warning" },
];

function resolveMetric(path, snap) {
  const map = {
    "cpu.usage": snap.cpu.usage,
    "cpu.iowait": snap.cpu.iowait,
    "memory.usedPercent": snap.memory.usedPercent,
    "memory.swapUsedPercent": snap.memory.swapUsedPercent,
    "load.load1": snap.load.load1,
    "load.load1PerCore": snap.load.load1PerCore,
    "load.load5PerCore": snap.load.load5PerCore,
    "disk.maxUsedPercent": snap.disk.maxUsedPercent,
    "thermal.maxTemp": snap.thermal.maxTemp,
  };
  const v = map[path];
  return v == null ? null : Math.round(v * 10) / 10;
}

export default AlertsView;
