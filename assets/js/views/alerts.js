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
import { modal } from "../components/primitives.js";
import { authedFetch } from "../components/auth.js";
import { notify } from "../components/toast.js";

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
    const addRule = h("button.btn.primary.sm.rule-add-btn", {
      type: "button",
      html: icon("plus", 14) + " Add rule",
      onClick: () => this._openRuleEditor(),
    });
    const rulesCard = card({ title: "Rules", iconName: "layers", actions: [addRule] }, [this.rulesWrap]);

    this.logWrap = h("div.col.gap-2");
    const logCard = card({ title: "Event Log", iconName: "clock" }, [this.logWrap]);

    view.append(
      h("div.section", null, activeCard),
      h("div.grid.grid-2.section", null, [rulesCard, logCard])
    );
    container.appendChild(view);

    this._unsubs.push(store.on("alerts", () => this._refresh()));
    this._unsubs.push(store.on("alertEvent", () => this._refresh()));
    this._unsubs.push(store.on("alertRules", () => this._refreshRules()));
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
    const hasConfigRules = Array.isArray(cfg?.alerts?.rules);
    const rules = hasConfigRules ? cfg.alerts.rules : (store.get().alerts?.rulesConfig ?? null);
    const snap = store.get().snapshot;
    const activeIds = new Set((store.get().alerts?.active || []).map((a) => a.id));

    // Only fall back before config arrives. An explicit empty list is valid.
    const ruleList = Array.isArray(rules) ? rules : DEFAULT_RULES;

    if (ruleList.length === 0) {
      this.rulesWrap.replaceChildren(
        h("div.empty-state", null, [
          h("span", { html: icon("layers", 36) }),
          h("div.title", { text: "No alert rules" }),
          h("div.muted", { text: "Add a rule to start monitoring a threshold." }),
        ])
      );
      return;
    }

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
      h("div.rule-detail-actions", null, [
        h("button.btn.sm", {
          type: "button",
          html: icon("edit", 14) + " Edit rule",
          onClick: (event) => {
            event.stopPropagation();
            this._openRuleEditor(r);
          },
        }),
        h("button.btn.btn-danger.sm", {
          type: "button",
          html: icon("trash", 14) + " Delete rule",
          onClick: (event) => {
            event.stopPropagation();
            this._deleteRule(r);
          },
        }),
      ]),
    ]);
  }

  async _deleteRule(rule) {
    if (!confirm(`Delete alert rule "${rule.id}"?`)) return;
    try {
      const response = await authedFetch(`/api/alert-rules/${encodeURIComponent(rule.id)}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Could not delete rule");
      store.applyAlertRules(payload.rules || [], store.get().alerts?.active || []);
      this._expanded.delete(rule.id);
      notify.success("Rule deleted", `${rule.id} is no longer monitored`);
    } catch (error) {
      notify.danger("Delete failed", error.message || "Could not delete rule");
    }
  }

  _openRuleEditor(existing = null) {
    const editing = Boolean(existing);
    const defaults = existing || {
      id: "",
      metric: "cpu.usage",
      operator: ">",
      threshold: 90,
      durationMs: 15000,
      severity: "warning",
      message: "",
    };

    const field = (label, control, hint = "") =>
      h("label.rule-form-field", null, [
        h("span.field-label", { text: label }),
        control,
        hint ? h("span.rule-field-hint", { text: hint }) : null,
      ]);
    const input = (name, type, value, extra = {}) =>
      h("input.field-input", { name, type, value: String(value ?? ""), ...extra });
    const select = (name, value, options) =>
      h("select.field-input", { name, value }, options.map(([v, label]) =>
        h("option", { value: v, selected: v === value, text: label })
      ));

    const error = h("div.profile-status.is-err", { style: { display: "none" } });
    const form = h("form.rule-form", null, [
      h("div.rule-form-grid", null, [
        field("Rule ID", input("id", "text", defaults.id, {
          maxlength: "64", pattern: "[A-Za-z0-9._-]+", required: true,
          placeholder: "cpu-high-custom",
        }), "Unique: letters, numbers, dot, dash, underscore"),
        field("Severity", select("severity", defaults.severity, [
          ["warning", "Warning"], ["critical", "Critical"],
        ])),
        field("Metric", select("metric", defaults.metric, METRIC_OPTIONS)),
        field("Operator", select("operator", defaults.operator, OPERATOR_OPTIONS)),
        field("Threshold", input("threshold", "number", defaults.threshold, {
          step: "any", required: true,
        })),
        field("Sustained for (seconds)", input(
          "durationSeconds", "number", (defaults.durationMs || 0) / 1000,
          { min: "0", max: "604800", step: "1", required: true }
        ), "Use 0 to fire immediately"),
      ]),
      field("Message", h("textarea.field-input.rule-message", {
        name: "message", maxlength: "240", required: true,
        placeholder: "Describe what this alert means",
        text: defaults.message || "",
      })),
      error,
    ]);

    const cancel = h("button.btn.ghost", { type: "button" }, "Cancel");
    const save = h("button.btn.primary", {
      type: "submit",
      html: icon("check", 15) + (editing ? " Save changes" : " Add rule"),
    });
    const dialog = modal({
      title: editing ? `Edit ${existing.id}` : "Add alert rule",
      subtitle: "Changes are applied immediately and persist across restarts.",
      icon: "alerts",
      size: "lg",
      body: form,
      footer: [cancel, save],
      closeOnScrim: false,
    });
    cancel.addEventListener("click", () => dialog.close());

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const data = new FormData(form);
      const threshold = Number(data.get("threshold"));
      const durationSeconds = Number(data.get("durationSeconds"));
      if (!Number.isFinite(threshold) || !Number.isFinite(durationSeconds)) {
        this._showRuleError(error, "Threshold and duration must be valid numbers");
        return;
      }
      const rule = {
        id: String(data.get("id") || "").trim(),
        metric: String(data.get("metric") || ""),
        operator: String(data.get("operator") || ""),
        threshold,
        durationMs: Math.round(durationSeconds * 1000),
        severity: String(data.get("severity") || "warning"),
        message: String(data.get("message") || "").trim(),
      };
      save.disabled = true;
      save.classList.add("is-busy");
      error.style.display = "none";
      try {
        const url = editing
          ? `/api/alert-rules/${encodeURIComponent(existing.id)}`
          : "/api/alert-rules";
        const response = await authedFetch(url, {
          method: editing ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rule),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "Could not save rule");
        const state = store.get();
        if (!state.config) state.config = {};
        if (!state.config.alerts) state.config.alerts = {};
        state.config.alerts.rules = payload.rules || [];
        store.emit("config", state.config);
        this._expanded.delete(existing?.id);
        this._expanded.add(rule.id);
        this._refreshRules();
        dialog.close();
        notify.success(editing ? "Rule updated" : "Rule added", `${rule.id} is now active`);
      } catch (err) {
        this._showRuleError(error, err.message || "Could not save rule");
      } finally {
        save.disabled = false;
        save.classList.remove("is-busy");
      }
    });

    // Footer submit button belongs outside the form; forward it explicitly.
    save.addEventListener("click", () => form.requestSubmit());
    dialog.open();
  }

  _showRuleError(el, message) {
    el.textContent = message;
    el.style.display = "";
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
        const serverName = store.serverName(ev.serverId);
        return h("div.row-between", { style: { padding: "6px 0", borderBottom: "1px solid var(--border)" } }, [
          h("div.row.gap-2", { style: { minWidth: 0 } }, [
            h("span.status-dot" + (fired ? ".offline" : ".online")),
            h("div.col", { style: { minWidth: 0 } }, [
              h("span.truncate", { text: `${ev.id}: ${ev.message}` }),
              h("span.text-3.mono", { text: fmtDateTime(ev.timestamp), style: { fontSize: "11px" } }),
              h("span.text-3", { text: "· " + serverName, style: { fontSize: "11px" } }),
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

const METRIC_OPTIONS = [
  ["cpu.usage", "CPU usage (%)"],
  ["cpu.iowait", "CPU I/O wait (%)"],
  ["cpu.system", "CPU system (%)"],
  ["memory.usedPercent", "Memory used (%)"],
  ["memory.swapUsedPercent", "Swap used (%)"],
  ["load.load1", "Load average (1m)"],
  ["load.load1PerCore", "Load per core (1m)"],
  ["load.load5PerCore", "Load per core (5m)"],
  ["disk.maxUsedPercent", "Highest disk usage (%)"],
  ["thermal.maxTemp", "Highest temperature (°C)"],
  ["network.totalRxBytesPerSec", "Network receive (bytes/s)"],
  ["network.totalTxBytesPerSec", "Network transmit (bytes/s)"],
];

function resolveMetric(path, snap) {
  const map = {
    "cpu.usage": snap.cpu.usage,
    "cpu.iowait": snap.cpu.iowait,
    "cpu.system": snap.cpu.system,
    "memory.usedPercent": snap.memory.usedPercent,
    "memory.swapUsedPercent": snap.memory.swapUsedPercent,
    "load.load1": snap.load.load1,
    "load.load1PerCore": snap.load.load1PerCore,
    "load.load5PerCore": snap.load.load5PerCore,
    "disk.maxUsedPercent": snap.disk.maxUsedPercent,
    "thermal.maxTemp": snap.thermal.maxTemp,
    "network.totalRxBytesPerSec": snap.network.totalRxBytesPerSec,
    "network.totalTxBytesPerSec": snap.network.totalTxBytesPerSec,
  };
  const value = map[path];
  return value == null ? null : Math.round(value * 10) / 10;
}
const OPERATOR_OPTIONS = [
  [">", "Greater than (>)"],
  [">=", "Greater than or equal (>=)"],
  ["<", "Less than (<)"],
  ["<=", "Less than or equal (<=)"],
  ["==", "Equal (==)"],
  ["!=", "Not equal (!=)"],
];


export default AlertsView;
