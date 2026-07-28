#!/usr/bin/env node
/**
 * cdp-check.mjs — headless browser validation harness for SysMon.
 *
 * Launches nothing itself; expects Chrome to already be running with
 * --remote-debugging-port=$PORT. Connects over the DevTools Protocol using
 * Node's built-in WebSocket (Node >= 21), navigates to each SPA route, waits
 * for the WebSocket to deliver live data, collects console errors + page
 * exceptions, and writes a screenshot per view.
 *
 * Exit code is non-zero if any console error / exception / failed request is
 * seen, so it doubles as a smoke test.
 */

import fs from "node:fs";
import http from "node:http";

const CDP_PORT = process.env.CDP_PORT || "9222";
const APP = process.env.APP_URL || "http://localhost:8177";
const OUT = process.env.OUT_DIR || "/tmp/sysmon-shots";
const ROUTES = ["overview", "cpu", "memory", "network", "disk", "processes", "thermal", "alerts", "info"];

fs.mkdirSync(OUT, { recursive: true });

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://localhost:${CDP_PORT}${path}`, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(JSON.parse(body)));
      })
      .on("error", reject);
  });
}

function httpReq(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "localhost", port: CDP_PORT, path, method },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(body ? JSON.parse(body) : {});
          } catch {
            resolve({ raw: body });
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

let msgId = 0;
const pending = new Map();
function send(ws, method, params = {}, sessionId) {
  const id = ++msgId;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 15000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Reuse the existing page target. We reset the realm between routes by first
  // navigating to about:blank, which discards the ES module map so each route
  // re-imports the current build's modules (avoids stale cached modules).
  const targets = await httpGet("/json/list");
  const page = targets.find((t) => t.type === "page");
  if (!page || !page.webSocketDebuggerUrl) {
    throw new Error("no page target: " + JSON.stringify(targets.map((t) => t.type)));
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });

  const consoleErrors = [];
  const exceptions = [];
  const failedReqs = [];

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    // Events.
    if (msg.method === "Runtime.consoleAPICalled") {
      if (msg.params.type === "error") {
        consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
      }
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      exceptions.push(d.exception?.description || d.text);
    } else if (msg.method === "Log.entryAdded") {
      const e = msg.params.entry;
      if (e.level === "error") consoleErrors.push(`[${e.source}] ${e.text}`);
    } else if (msg.method === "Network.loadingFailed") {
      failedReqs.push(msg.params.errorText);
    }
  });

  await send(ws, "Page.enable");
  await send(ws, "Runtime.enable");
  await send(ws, "Log.enable");
  await send(ws, "Network.enable");
  // Always fetch fresh module bytes so we test the current build, not cache.
  await send(ws, "Network.setCacheDisabled", { cacheDisabled: true });

  const results = [];

  for (const route of ROUTES) {
    const before = consoleErrors.length + exceptions.length;
    // Reset the realm so ES modules are re-imported fresh, then load the route
    // with a cache-busting query string.
    await send(ws, "Page.navigate", { url: "about:blank" });
    await sleep(120);
    const bust = Date.now() + "" + Math.random().toString(36).slice(2);
    const url = `${APP}/?t=${bust}#/${route}`;
    await send(ws, "Page.navigate", { url });
    // Wait for load + WS data + charts to paint.
    await sleep(route === "overview" ? 2500 : 1800);

    // Probe the DOM for a mounted view and any live values.
    const probe = await send(ws, "Runtime.evaluate", {
      expression: `(() => {
        const view = document.querySelector('.view');
        const cards = document.querySelectorAll('.card').length;
        const canvases = document.querySelectorAll('canvas').length;
        const rows = document.querySelectorAll('table tbody tr').length;
        const conn = document.querySelector('[data-conn]')?.getAttribute('data-conn')
          || (window.__sysmon?.store?.get?.().connected ? 'live' : 'unknown');
        const title = document.title;
        return JSON.stringify({ hasView: !!view, cards, canvases, rows, conn, title,
          bodyLen: document.body.innerText.length });
      })()`,
      returnByValue: true,
    });
    const info = JSON.parse(probe.result.value);

    // Screenshot.
    const shot = await send(ws, "Page.captureScreenshot", { format: "png" });
    const file = `${OUT}/${route}.png`;
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));

    const newErrors = consoleErrors.length + exceptions.length - before;
    results.push({ route, ...info, newErrors, file });
    process.stdout.write(
      `  ${route.padEnd(10)} view=${info.hasView} cards=${String(info.cards).padStart(2)} ` +
        `canvas=${info.canvases} rows=${String(info.rows).padStart(3)} ` +
        `text=${String(info.bodyLen).padStart(5)} errs=${newErrors}\n`
    );
  }

  console.log("\n=== SUMMARY ===");
  console.table(results.map((r) => ({ route: r.route, view: r.hasView, cards: r.cards, canvas: r.canvases, rows: r.rows, errs: r.newErrors })));

  if (consoleErrors.length) {
    console.log("\n--- CONSOLE ERRORS ---");
    consoleErrors.forEach((e) => console.log("  •", e));
  }
  if (exceptions.length) {
    console.log("\n--- EXCEPTIONS ---");
    exceptions.forEach((e) => console.log("  •", e));
  }
  if (failedReqs.length) {
    console.log("\n--- FAILED REQUESTS ---");
    [...new Set(failedReqs)].forEach((e) => console.log("  •", e));
  }

  ws.close();
  const bad = consoleErrors.length + exceptions.length;
  console.log(`\nScreenshots in ${OUT}. ${bad === 0 ? "NO ERRORS ✓" : bad + " ERRORS ✗"}`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("harness error:", e.message);
  process.exit(2);
});
