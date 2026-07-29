// Headless-Chrome validation for all SPA views. Uses cdp_util for guaranteed
// Chrome process-group cleanup (no orphaned 100%-CPU renderers).
import { launchChrome, killChrome, connect } from "./cdp_util.mjs";

const PORT = 9330;
const BASE = process.env.BASE || "http://127.0.0.1:8099";
const views = [
  ["overview", ".chart-md canvas", ".chart-lg canvas"],
  ["cpu", ".gauge canvas"],
  ["memory", ".chart canvas"],
  ["network", ".chart-lg canvas"],
  ["disk", ".chart-lg canvas"],
  ["processes"],
  ["thermal"],
  ["alerts"],
  ["info"],
];

let chrome, port = PORT;
// Safety nets: reap Chrome on any exit path.
const cleanup = () => killChrome(chrome, port);
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });
process.on("uncaughtException", (e) => { console.error("uncaught:", e.message); cleanup(); process.exit(4); });

try {
  const launched = await launchChrome(port);
  chrome = launched.chrome;
  const { ready, send, evalx, errors } = connect(launched.target);
  await ready;
  await send("Page.enable");
  await send("Runtime.enable");

  let total = 0;
  for (const [view, ...selectors] of views) {
    errors.length = 0;
    await send("Page.navigate", { url: `${BASE}/#/${view}` });
    await new Promise((r) => setTimeout(r, 1600));
    const mounted = await evalx(`(()=>{const r=document.querySelector('#view-root');return !!r && r.children.length>0;})()`);
    let selInfo = "";
    for (const sel of selectors) {
      const dim = await evalx(
        `(()=>{const c=document.querySelector('${sel}');if(!c)return 'MISSING';const b=c.getBoundingClientRect();return 'ok('+Math.round(b.width)+'x'+Math.round(b.height)+')';})()`,
      );
      selInfo += ` ${sel}=${dim}`;
    }
    total += errors.length;
    const tag = errors.length ? "FAIL" : "PASS";
    console.log(`[${tag}] ${view.padEnd(10)} view=${mounted}${selInfo}`);
    if (errors.length) console.log("       errors:", errors.slice(0, 4).join(" | "));
  }
  console.log(`\n=== ${total} total console errors across ${views.length} views ===`);
  process.exit(total === 0 ? 0 : 1);
} catch (e) {
  console.error("FATAL:", e.message);
  process.exit(2);
}
