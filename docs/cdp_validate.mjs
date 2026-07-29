#!/usr/bin/env node
// Headless-Chrome CDP validator: loads each SPA view, collects console
// errors/exceptions, and checks that expected chart canvases rendered with
// non-zero size. No external deps — raw CDP over the DevTools WebSocket.
import { spawn } from "node:child_process";
import http from "node:http";
// Node 18+ exposes a global WebSocket (undici).

const BASE = process.env.BASE || "http://127.0.0.1:8099";
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const PORT = 9331;

const views = [
  { hash: "#/overview", name: "overview", canvases: [".chart-md canvas", ".chart-lg canvas"] },
  { hash: "#/cpu", name: "cpu", canvases: [".gauge canvas"] },
  { hash: "#/memory", name: "memory", canvases: [".chart canvas"] },
  { hash: "#/network", name: "network", canvases: [".chart-lg canvas"] },
  { hash: "#/disk", name: "disk", canvases: [".chart-lg canvas"] },
  { hash: "#/processes", name: "processes", canvases: [] },
  { hash: "#/thermal", name: "thermal", canvases: [] },
  { hash: "#/alerts", name: "alerts", canvases: [] },
  { hash: "#/info", name: "info", canvases: [] },
];

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
    }).on("error", reject);
  });
}

async function main() {
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`,
    "--remote-allow-origins=*",
    "--window-size=1440,900",
    "about:blank",
  ], { stdio: "ignore" });

  // Wait for the DevTools endpoint.
  let target;
  for (let i = 0; i < 40; i++) {
    try {
      const list = await getJSON(`http://127.0.0.1:${PORT}/json`);
      target = list.find((t) => t.type === "page");
      if (target) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!target) {
    console.error("Chrome DevTools endpoint never came up");
    chrome.kill("SIGKILL");
    process.exit(2);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    } else if (msg.method === "Runtime.exceptionThrown") {
      const e = msg.params.exceptionDetails;
      errors.push("EXCEPTION: " + (e.exception?.description || e.text));
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      errors.push("CONSOLE.error: " + msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Log.enable");

  const results = [];
  let totalErrors = 0;
  for (const v of views) {
    errors.length = 0;
    await send("Page.navigate", { url: BASE + "/" + v.hash });
    // Let SPA render + a couple of stream ticks land.
    await new Promise((r) => setTimeout(r, 2600));

    // Check canvases.
    const canvasReport = [];
    for (const sel of v.canvases) {
      const r = await send("Runtime.evaluate", {
        expression: `(() => { const c = document.querySelector(${JSON.stringify(sel)}); if(!c) return 'MISSING'; const b = c.getBoundingClientRect(); return (b.width>10 && b.height>10) ? 'ok('+Math.round(b.width)+'x'+Math.round(b.height)+')' : 'zero'; })()`,
        returnByValue: true,
      });
      canvasReport.push(`${sel}=${r.result.value}`);
    }
    // Confirm the view root exists.
    const hasView = await send("Runtime.evaluate", {
      expression: `!!document.querySelector('.view')`,
      returnByValue: true,
    });

    const errs = errors.slice();
    totalErrors += errs.length;
    results.push({ view: v.name, viewMounted: hasView.result.value, canvases: canvasReport, errors: errs });
    const status = errs.length === 0 && hasView.result.value ? "PASS" : "FAIL";
    console.log(`[${status}] ${v.name.padEnd(10)} view=${hasView.result.value} ${canvasReport.join(" ")}${errs.length ? "  ERRORS: " + errs.join(" | ") : ""}`);
  }

  ws.close();
  chrome.kill("SIGKILL");
  console.log(`\n=== ${totalErrors} total console errors across ${views.length} views ===`);
  process.exit(totalErrors === 0 && results.every((r) => r.viewMounted) ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(3);
});
