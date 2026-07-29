/**
 * Client-side authentication: a glassy login screen, the identity probe used
 * to gate the app at boot, and helpers for logout and 401 handling.
 *
 * Sessions are cookie-based (HttpOnly), so the browser attaches them
 * automatically; this module never sees the token.
 */
import { h, qs, icon } from "../util.js";

let _me = null;

/** Current identity ({ username, preferences, shellEnabled }) or null. */
export function currentUser() {
  return _me;
}

/** Probe the session. Resolves to the identity object or null (401). */
export async function fetchMe() {
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (!res.ok) {
      _me = null;
      return null;
    }
    _me = await res.json();
    return _me;
  } catch {
    _me = null;
    return null;
  }
}

/** Attempt a login. Returns { ok } or { ok:false, error }. */
export async function login(username, password) {
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      // Re-probe /me so we pick up server-only fields (shellEnabled) that the
      // login response does not include.
      await fetchMe();
      if (!_me) {
        _me = { username: data.username, preferences: data.preferences, shellEnabled: false };
      }
      return { ok: true };
    }
    return { ok: false, error: data.error || "Login failed" };
  } catch (e) {
    return { ok: false, error: "Network error" };
  }
}

/** Log out and return to the login screen. */
export async function logout() {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  } catch {}
  _me = null;
  location.reload();
}

/** Render the login screen into #app and resolve when login succeeds. */
export function showLogin(onSuccess) {
  const app = qs("#app");
  app.className = "auth-screen";
  app.replaceChildren();

  const err = h("div.auth-error", { style: { display: "none" } });
  const userInput = h("input.auth-input", {
    type: "text",
    placeholder: "Username",
    autocomplete: "username",
    value: "admin",
  });
  const passInput = h("input.auth-input", {
    type: "password",
    placeholder: "Password",
    autocomplete: "current-password",
  });
  const submitBtn = h("button.auth-submit", { type: "submit" }, [
    h("span.auth-submit-label", { text: "Sign in" }),
  ]);

  const setBusy = (busy) => {
    submitBtn.disabled = busy;
    submitBtn.classList.toggle("is-busy", busy);
  };

  const doLogin = async (e) => {
    if (e) e.preventDefault();
    err.style.display = "none";
    setBusy(true);
    const res = await login(userInput.value.trim(), passInput.value);
    setBusy(false);
    if (res.ok) {
      onSuccess();
    } else {
      err.textContent = res.error;
      err.style.display = "";
      passInput.focus();
      passInput.select();
      app.querySelector(".auth-card").classList.remove("shake");
      // reflow to restart the animation
      void app.querySelector(".auth-card").offsetWidth;
      app.querySelector(".auth-card").classList.add("shake");
    }
  };

  const form = h("form.auth-form", { onsubmit: doLogin }, [
    h("label.auth-field", null, [
      h("span.auth-label", { text: "Username" }),
      userInput,
    ]),
    h("label.auth-field", null, [
      h("span.auth-label", { text: "Password" }),
      passInput,
    ]),
    err,
    submitBtn,
  ]);

  const card = h("div.auth-card", null, [
    h("div.auth-orb.auth-orb--1"),
    h("div.auth-orb.auth-orb--2"),
    h("div.auth-brand", null, [
      h("div.auth-logo", { html: icon("activity", 30) }),
      h("div.auth-title", { text: "SysMon" }),
      h("div.auth-sub", { text: "Real-time server monitoring" }),
    ]),
    form,
    h("div.auth-hint", { html: 'Default credentials: <b>admin</b> / <b>admin123</b>' }),
  ]);

  app.append(
    h("div.auth-bg"),
    h("div.auth-shell", null, [card]),
  );
  setTimeout(() => userInput.focus(), 50);
}

/**
 * Wrap fetch so any 401 from the API bounces the user back to login. Views use
 * the normal store/ws path, but this guards ad-hoc fetches (profile, shell).
 */
export async function authedFetch(url, opts = {}) {
  const res = await fetch(url, { credentials: "same-origin", ...opts });
  if (res.status === 401) {
    _me = null;
    location.reload();
    throw new Error("unauthorized");
  }
  return res;
}
