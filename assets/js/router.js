/**
 * router.js
 * ---------
 * A minimal hash-based single-page router. Routes register a view factory that
 * returns an object with mount(container) and optional update() and unmount().
 * The router calls unmount() on the outgoing view and mount() on the incoming
 * one, and forwards store updates to the active view's update() when present.
 */

class Router {
  constructor() {
    this.routes = new Map();
    this.defaultRoute = null;
    this.current = null;
    this.currentView = null;
    this.container = null;
    this.changeListeners = [];
    window.addEventListener("hashchange", () => this._onHashChange());
  }

  register(path, factory, meta = {}) {
    this.routes.set(path, { factory, meta });
    if (!this.defaultRoute) this.defaultRoute = path;
    return this;
  }

  setDefault(path) {
    this.defaultRoute = path;
    return this;
  }

  start(container) {
    this.container = container;
    this._onHashChange();
  }

  onChange(fn) {
    this.changeListeners.push(fn);
  }

  currentPath() {
    const hash = location.hash.replace(/^#\/?/, "");
    return hash.split("?")[0] || this.defaultRoute;
  }

  navigate(path) {
    if (location.hash !== "#/" + path) {
      location.hash = "#/" + path;
    } else {
      this._onHashChange();
    }
  }

  _onHashChange() {
    const path = this.currentPath();
    const route = this.routes.get(path) || this.routes.get(this.defaultRoute);
    if (!route) return;

    // Tear down the previous view.
    if (this.currentView && typeof this.currentView.unmount === "function") {
      try {
        this.currentView.unmount();
      } catch (err) {
        console.error("view unmount error:", err);
      }
    }

    // Build and mount the new view.
    this.current = path;
    this.currentView = route.factory();
    if (this.container) {
      this.container.replaceChildren();
      try {
        this.currentView.mount(this.container);
      } catch (err) {
        console.error("view mount error:", err);
      }
    }

    for (const fn of this.changeListeners) {
      try {
        fn(path, route.meta);
      } catch (_) {}
    }
  }

  /** Forward a store update to the active view if it wants updates. */
  dispatch(topic, payload, state) {
    if (this.currentView && typeof this.currentView.update === "function") {
      try {
        this.currentView.update(topic, payload, state);
      } catch (err) {
        console.error("view update error:", err);
      }
    }
  }
}

export const router = new Router();
export default router;
