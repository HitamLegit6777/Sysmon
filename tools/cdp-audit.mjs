#!/usr/bin/env node
// Deep UI auditor over CDP. Placeholder; extended via apply_patch.
import http from "node:http";
import fs from "node:fs";
const CDP_PORT = process.env.CDP_PORT || "9222";
const APP = process.env.APP_URL || "http://localhost:8099";
const OUT = process.env.OUT_DIR || "/tmp/sysmon-audit";
const ROUTES = ["overview", "cpu", "memory", "network", "disk", "processes", "thermal", "alerts", "info"];
fs.mkdirSync(OUT, { recursive: true });

function httpGet(path) {
  return new Promise((res, rej) => {
    http.get(`http://localhost:${CDP_PORT}${path}`, (r) => {
      let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => res(JSON.parse(b)));
    }).on("error", rej);
  });
}
let msgId = 0; const pending = new Map();
function send(ws, method, params = {}) {
  const id = ++msgId; ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout " + method)); } }, 15000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evalJs(ws, expression) {
  const r = await send(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

const VIEWPORTS = [
  { name: "desktop", w: 1600, h: 1000 },
  { name: "laptop", w: 1280, h: 800 },
  { name: "tablet", w: 900, h: 1200 },
  { name: "mobile", w: 390, h: 844 },
];

const issues = [];
function addIssue(sev, ctx, msg) { issues.push({ sev, ctx, msg }); }

async function main() {
  const targets = await httpGet("/json/list");
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });

  const consoleErrors = [], exceptions = [], failedReqs = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
    else if (m.method === "Runtime.exceptionThrown")
      exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    else if (m.method === "Log.entryAdded" && m.params.entry.level === "error")
      consoleErrors.push(`[${m.params.entry.source}] ${m.params.entry.text}`);
    else if (m.method === "Network.loadingFailed") failedReqs.push(m.params.errorText);
  });
  await send(ws, "Page.enable"); await send(ws, "Runtime.enable");
  await send(ws, "Log.enable"); await send(ws, "Network.enable");
  await send(ws, "Network.setCacheDisabled", { cacheDisabled: true });

  await runAudit(ws, consoleErrors, exceptions, failedReqs);
  ws.close();
  report();
}

main().catch((e) => { console.error("auditor error:", e.message); process.exit(2); });

// The in-page probe: returns detailed layout/content diagnostics as JSON.
const PROBE = `(() => {
  const out = { overflowX: false, docW: document.documentElement.scrollWidth, winW: window.innerWidth,
    wideEls: [], badText: [], emptyStrong: [], zeroSizeVisible: [], brokenIcons: 0,
    scrollbars: [], counts: {}, transparentText: [] };
  const vw = window.innerWidth;
  out.overflowX = document.documentElement.scrollWidth > vw + 1;
  // Helper: is el inside an ancestor that scrolls horizontally (so its own
  // overflow is contained and NOT a page-level bug)?
  const inScrollContainer = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
      p = p.parentElement;
    }
    return false;
  };
  // Elements extending past viewport that are NOT contained by a scroller
  const all = document.querySelectorAll('.view *');
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > vw + 1.5 && r.width > 4 && getComputedStyle(el).position !== 'fixed') {
      if (inScrollContainer(el)) continue;
      const tag = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').filter(Boolean).slice(0,2).join('.') : '');
      out.wideEls.push({ el: tag, right: Math.round(r.right), w: Math.round(r.width) });
    }
  }
  out.wideEls = out.wideEls.slice(0, 8);
  // Text containing NaN / undefined / null / Infinity
  const walker = document.createTreeWalker(document.querySelector('.view') || document.body, NodeFilter.SHOW_TEXT);
  let n; const badRe = /\\b(NaN|undefined|null|Infinity)\\b/;
  while ((n = walker.nextNode())) {
    const t = n.nodeValue.trim();
    if (t && badRe.test(t)) out.badText.push(t.slice(0, 60));
  }
  out.badText = [...new Set(out.badText)].slice(0, 10);
  // Required-strong cells that are empty
  for (const el of document.querySelectorAll('.cell-strong, .stat-value, .r-value, .kv-value')) {
    if (!el.textContent.trim()) out.emptyStrong.push(el.className);
  }
  out.emptyStrong = [...new Set(out.emptyStrong)].slice(0, 10);
  // Icons that rendered nothing (svg with no children / 0 size)
  for (const svg of document.querySelectorAll('.view svg')) {
    const r = svg.getBoundingClientRect();
    if ((r.width === 0 || r.height === 0) || svg.children.length === 0) out.brokenIcons++;
  }
  // Counts for sanity
  out.counts = {
    cards: document.querySelectorAll('.card').length,
    canvas: document.querySelectorAll('canvas').length,
    rows: document.querySelectorAll('table tbody tr').length,
    meters: document.querySelectorAll('.meter').length,
  };
  return JSON.stringify(out);
})()`;

async function auditView(ws, route, vp, ce0, ex0) {
  const bust = Date.now() + Math.random().toString(36).slice(2);
  await send(ws, "Page.navigate", { url: "about:blank" });
  await sleep(100);
  await send(ws, "Emulation.setDeviceMetricsOverride", { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.name === "mobile" });
  await send(ws, "Page.navigate", { url: `${APP}/?t=${bust}#/${route}` });
  await sleep(route === "overview" ? 2600 : 1900);
  let probe;
  try { probe = JSON.parse(await evalJs(ws, PROBE)); }
  catch (e) { addIssue("ERR", `${route}@${vp.name}`, "probe failed: " + e.message); return; }
  const ctx = `${route}@${vp.name}`;
  if (probe.overflowX) addIssue("BUG", ctx, `horizontal overflow: doc ${probe.docW}px > win ${probe.winW}px`);
  for (const w of probe.wideEls) addIssue("BUG", ctx, `element past viewport: ${w.el} right=${w.right} w=${w.w}`);
  for (const t of probe.badText) addIssue("BUG", ctx, `bad text: "${t}"`);
  for (const s of probe.emptyStrong) addIssue("WARN", ctx, `empty value element: .${s}`);
  if (probe.brokenIcons) addIssue("WARN", ctx, `${probe.brokenIcons} icon(s) rendered empty/0-size`);
  const newErr = ce0() + ex0();
  if (newErr) addIssue("ERR", ctx, `${newErr} console error(s)/exception(s)`);
  // screenshot for eyeballing
  const shot = await send(ws, "Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${OUT}/${route}-${vp.name}.png`, Buffer.from(shot.data, "base64"));
  process.stdout.write(`  ${ctx.padEnd(22)} cards=${probe.counts.cards} canvas=${probe.counts.canvas} rows=${String(probe.counts.rows).padStart(3)} wide=${probe.wideEls.length} bad=${probe.badText.length} err=${newErr}\n`);
}

async function interactionTests(ws, ce0, ex0) {
  process.stdout.write("\n== interaction tests (desktop) ==\n");
  await send(ws, "Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  // processes: click a sortable header, then type in search
  const before = ce0() + ex0();
  await send(ws, "Page.navigate", { url: `${APP}/?t=${Date.now()}#/processes` });
  await sleep(2000);
  const sortRes = await evalJs(ws, `(() => {
    const th = [...document.querySelectorAll('th')].find(h => /MEM%/.test(h.textContent));
    if (!th) return 'no MEM% header';
    th.click(); th.click();
    return document.querySelectorAll('table tbody tr').length + ' rows after sort';
  })()`);
  const searchRes = await evalJs(ws, `(() => {
    const inp = document.querySelector('.search input');
    if (!inp) return 'no search input';
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    set.call(inp, 'systemd'); inp.dispatchEvent(new Event('input', {bubbles:true}));
    return 'search set';
  })()`);
  await sleep(400);
  const searchCount = await evalJs(ws, `document.querySelectorAll('table tbody tr').length`);
  process.stdout.write(`  processes sort: ${sortRes}; search: ${searchRes}; filtered rows=${searchCount}\n`);
  if (typeof searchCount === 'number' && searchCount === 0) addIssue("WARN", "processes", "search 'systemd' yielded 0 rows (filter may be broken)");

  // theme toggle + accent switch on info view
  await send(ws, "Page.navigate", { url: `${APP}/?t=${Date.now()}#/info` });
  await sleep(1800);
  const themeRes = await evalJs(ws, `(() => {
    const before = document.documentElement.dataset.theme || 'dark';
    const sw = document.querySelector('.switch');
    if (!sw) return 'no theme switch';
    sw.click();
    const after = document.documentElement.dataset.theme;
    return before + '->' + after;
  })()`);
  await sleep(300);
  const accentRes = await evalJs(ws, `(() => {
    const dots = document.querySelectorAll('button[title]');
    const emerald = [...dots].find(d => d.title === 'emerald');
    if (!emerald) return 'no accent picker';
    emerald.click();
    return 'accent=' + (document.documentElement.dataset.accent || 'default');
  })()`);
  process.stdout.write(`  info theme: ${themeRes}; accent: ${accentRes}\n`);
  // reset theme back to dark for consistency
  await evalJs(ws, `(document.documentElement.dataset.theme='dark')`);
  const after = ce0() + ex0();
  if (after - before) addIssue("ERR", "interactions", `${after - before} error(s) during interactions`);

  // chart hover: move mouse over overview perf chart, expect tooltip visible + no error
  await send(ws, "Page.navigate", { url: `${APP}/?t=${Date.now()}#/overview` });
  await sleep(2600);
  const box = await evalJs(ws, `(() => { const c = document.querySelector('.chart-xl canvas') || document.querySelector('canvas'); if(!c) return null; const r=c.getBoundingClientRect(); return {x:Math.round(r.left+r.width*0.6), y:Math.round(r.top+r.height*0.5)}; })()`);
  if (box) {
    await send(ws, "Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await sleep(300);
    const tip = await evalJs(ws, `(() => { const t=document.querySelector('.tooltip.visible'); return t ? (t.textContent.slice(0,40)||'empty') : 'no-tooltip'; })()`);
    process.stdout.write(`  overview chart hover tooltip: ${tip}\n`);
    if (tip === 'no-tooltip') addIssue("WARN", "overview", "chart hover produced no tooltip");
  }
}

let CE = [], EX = [], FR = [];
async function runAudit(ws, consoleErrors, exceptions, failedReqs) {
  CE = consoleErrors; EX = exceptions; FR = failedReqs;
  console.log("== per-view x per-viewport ==");
  for (const route of ROUTES) {
    for (const vp of VIEWPORTS) {
      const baseCe = consoleErrors.length, baseEx = exceptions.length;
      await auditView(ws, route, vp,
        () => consoleErrors.length - baseCe,
        () => exceptions.length - baseEx);
    }
  }
  await interactionTests(ws,
    () => consoleErrors.length,
    () => exceptions.length);
}

function report() {
  const bugs = issues.filter((i) => i.sev === "BUG" || i.sev === "ERR");
  const warns = issues.filter((i) => i.sev === "WARN");
  console.log("\n================ AUDIT REPORT ================");
  console.log(`viewports: ${VIEWPORTS.map((v) => v.name).join(", ")}`);
  console.log(`total console errors: ${CE.length} | exceptions: ${EX.length} | failed requests: ${[...new Set(FR)].length}`);
  if (CE.length) { console.log("\n-- CONSOLE ERRORS --"); CE.slice(0, 20).forEach((e) => console.log("  •", e)); }
  if (EX.length) { console.log("\n-- EXCEPTIONS --"); EX.slice(0, 20).forEach((e) => console.log("  •", e)); }
  if (FR.length) { console.log("\n-- FAILED REQUESTS --"); [...new Set(FR)].slice(0, 20).forEach((e) => console.log("  •", e)); }
  console.log(`\n-- BUGS/ERRORS (${bugs.length}) --`);
  bugs.forEach((i) => console.log(`  [${i.sev}] ${i.ctx}: ${i.msg}`));
  console.log(`\n-- WARNINGS (${warns.length}) --`);
  warns.forEach((i) => console.log(`  [WARN] ${i.ctx}: ${i.msg}`));
  const fatal = bugs.length + CE.length + EX.length;
  console.log(`\nRESULT: ${fatal === 0 ? "CLEAN ✓ (no bugs/errors)" : fatal + " issue(s) ✗"} | ${warns.length} warning(s)`);
  console.log(`screenshots: ${OUT}`);
  process.exit(fatal === 0 ? 0 : 1);
}
