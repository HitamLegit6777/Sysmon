/**
 * profile.js
 * ----------
 * Account & appearance settings: change username, change password, pick theme
 * and accent color (persisted server-side so they follow the account), and log
 * out. Reuses the shared preference helpers so changes are reflected instantly.
 */
import { h, icon } from "../util.js";
import { card } from "../components/card.js";
import { authedFetch, currentUser, logout } from "../components/auth.js";
import { getPref, setPref } from "../components/settings.js";

const ACCENTS = [
  { value: "blue", color: "#5b8cff", label: "Blue" },
  { value: "violet", color: "#b388ff", label: "Violet" },
  { value: "emerald", color: "#3ad29f", label: "Emerald" },
  { value: "amber", color: "#f5b342", label: "Amber" },
  { value: "rose", color: "#fb7185", label: "Rose" },
];

function persistPrefs() {
  const body = { theme: getPref("theme") || "dark", accent: getPref("accent") || "blue" };
  authedFetch("/api/auth/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

/** A small inline status line (success/error) shown under a form. */
function statusLine() {
  return h("div.profile-status", { style: { display: "none" } });
}
function setStatus(el, msg, ok) {
  el.textContent = msg;
  el.className = "profile-status " + (ok ? "is-ok" : "is-err");
  el.style.display = "";
}

export class ProfileView {
  constructor() {
    this._root = null;
  }

  mount(container) {
    const me = currentUser() || { username: "admin" };
    const view = h("div.view.profile-view");

    // ---- Identity card ----------------------------------------------------
    const nameInput = h("input.field-input", { type: "text", value: me.username, autocomplete: "username" });
    const namePass = h("input.field-input", { type: "password", placeholder: "Current password", autocomplete: "current-password" });
    const nameStatus = statusLine();
    const nameBtn = h("button.btn.btn-primary", { type: "submit", text: "Update username" });
    const nameForm = h("form.profile-form", {
      onsubmit: async (e) => {
        e.preventDefault();
        nameBtn.disabled = true;
        try {
          const res = await authedFetch("/api/auth/username", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ currentPassword: namePass.value, newUsername: nameInput.value.trim() }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            setStatus(nameStatus, "Username updated to " + data.username, true);
            if (currentUser()) currentUser().username = data.username;
            this._syncHeader(data.username);
            namePass.value = "";
          } else setStatus(nameStatus, data.error || "Failed", false);
        } catch { setStatus(nameStatus, "Network error", false); }
        nameBtn.disabled = false;
      },
    }, [
      h("label.field", null, [h("span.field-label", { text: "Username" }), nameInput]),
      h("label.field", null, [h("span.field-label", { text: "Confirm with current password" }), namePass]),
      nameStatus,
      h("div.form-actions", null, [nameBtn]),
    ]);

    // ---- Password card ----------------------------------------------------
    const curPass = h("input.field-input", { type: "password", placeholder: "Current password", autocomplete: "current-password" });
    const newPass = h("input.field-input", { type: "password", placeholder: "New password (min 6 chars)", autocomplete: "new-password" });
    const newPass2 = h("input.field-input", { type: "password", placeholder: "Repeat new password", autocomplete: "new-password" });
    const passStatus = statusLine();
    const passBtn = h("button.btn.btn-primary", { type: "submit", text: "Change password" });
    const passForm = h("form.profile-form", {
      onsubmit: async (e) => {
        e.preventDefault();
        if (newPass.value !== newPass2.value) { setStatus(passStatus, "New passwords do not match", false); return; }
        passBtn.disabled = true;
        try {
          const res = await authedFetch("/api/auth/password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ currentPassword: curPass.value, newPassword: newPass.value }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            setStatus(passStatus, "Password changed. Other sessions were signed out.", true);
            curPass.value = newPass.value = newPass2.value = "";
          } else setStatus(passStatus, data.error || "Failed", false);
        } catch { setStatus(passStatus, "Network error", false); }
        passBtn.disabled = false;
      },
    }, [
      h("label.field", null, [h("span.field-label", { text: "Current password" }), curPass]),
      h("label.field", null, [h("span.field-label", { text: "New password" }), newPass]),
      h("label.field", null, [h("span.field-label", { text: "Repeat new password" }), newPass2]),
      passStatus,
      h("div.form-actions", null, [passBtn]),
    ]);

    // ---- Appearance card --------------------------------------------------
    const themeToggle = this._themeControl();
    const accentPicker = this._accentControl();
    const appearance = h("div.profile-appearance", null, [
      h("div.field", null, [h("span.field-label", { text: "Theme" }), themeToggle]),
      h("div.field", null, [h("span.field-label", { text: "Accent color" }), accentPicker]),
    ]);

    // ---- Session card -----------------------------------------------------
    const logoutBtn = h("button.btn.btn-danger", {
      html: icon("logout", 16) + "<span>Sign out</span>",
      onclick: () => logout(),
    });
    const sessionCard = card({ title: "Session", iconName: "user" }, [
      h("p.muted", { text: "Signed in as " }, [h("b.profile-current-user", { text: me.username })]),
      h("div.form-actions", null, [logoutBtn]),
    ]);

    view.append(
      h("div.profile-grid", null, [
        card({ title: "Account", iconName: "user" }, [nameForm]),
        card({ title: "Password", iconName: "key" }, [passForm]),
        card({ title: "Appearance", iconName: "palette" }, [appearance]),
        sessionCard,
      ]),
    );
    container.appendChild(view);
    this._root = view;
  }

  _syncHeader(name) {
    document.querySelectorAll(".profile-current-user").forEach((el) => (el.textContent = name));
  }

  _themeControl() {
    const seg = h("div.segmented");
    const mk = (val, label, ic) => {
      const b = h("button.segmented-btn", {
        html: icon(ic, 15) + "<span>" + label + "</span>",
        onclick: () => {
          setPref("theme", val);
          persistPrefs();
          seg.querySelectorAll(".segmented-btn").forEach((x) => x.classList.remove("is-active"));
          b.classList.add("is-active");
        },
      });
      if ((getPref("theme") || "dark") === val) b.classList.add("is-active");
      return b;
    };
    seg.append(mk("dark", "Dark", "moon"), mk("light", "Light", "sun"));
    return seg;
  }

  _accentControl() {
    const wrap = h("div.accent-swatches", { role: "radiogroup" });
    const cur = getPref("accent") || "blue";
    ACCENTS.forEach((a) => {
      const btn = h("button.accent-swatch", {
        title: a.label,
        style: { "--sw": a.color },
        onclick: () => {
          setPref("accent", a.value);
          persistPrefs();
          wrap.querySelectorAll(".accent-swatch").forEach((x) => x.classList.remove("is-active"));
          btn.classList.add("is-active");
        },
      });
      if (a.value === cur) btn.classList.add("is-active");
      wrap.appendChild(btn);
    });
    return wrap;
  }

  update() {}

  unmount() {
    if (this._root) this._root.remove();
  }
}
