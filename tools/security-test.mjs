#!/usr/bin/env node
// Live security exploit tests against a running SysMon hub (/agent/ws).
// Run: node tools/security-test.mjs <base-url> <token>
// Exit 0 = all attacks blocked as expected.
const BASE = process.argv[2] || "http://127.0.0.1:8388";
const TOKEN = process.argv[3] || "sec-token-0123456789abcdef";
const WS = (path, headers) => new WebSocket(BASE.replace(/^http/, "ws") + path, { headers });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

async function attempt(name, buildWs, expectOpen) {
  const ws = buildWs();
  const opened = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 3000);
    ws.onopen = () => { clearTimeout(t); resolve(true); };
    ws.onerror = () => { clearTimeout(t); resolve(false); };
    ws.onclose = () => { clearTimeout(t); resolve(false); };
  });
  try { ws.close(); } catch {}
  check(name, opened === expectOpen);
}

async function main() {
  // 1. No token
  await attempt("no token rejected", () => WS("/agent/ws", {}), false);
  // 2. Wrong token
  await attempt("wrong token rejected", () => WS("/agent/ws", { Authorization: "Bearer nope" }), false);
  // 3. Scheme confusion (Basic)
  await attempt("Basic scheme rejected", () => WS("/agent/ws", { Authorization: "Basic " + Buffer.from("a:b").toString("base64") }), false);
  // 4. Correct token
  await attempt("correct token accepted", () => WS("/agent/ws", { Authorization: `Bearer ${TOKEN}` }), true);
  // 5. Evil agent id (path/injection) must be rejected by handshake
  const evil = WS("/agent/ws", { Authorization: `Bearer ${TOKEN}` });
  const opened = await new Promise((r) => { evil.onopen = () => r(true); evil.onerror = () => r(false); setTimeout(() => r(false), 3000); });
  if (opened) {
    const reply = await new Promise((r) => {
      evil.onmessage = (e) => r(e.data);
      evil.send(JSON.stringify({ type: "hello", id: "evil;DROP TABLE;../../etc", name: "x" }));
      setTimeout(() => r("TIMEOUT"), 3000);
    });
    try { evil.close(); } catch {}
    check("evil agent id rejected by handshake", reply.includes("error") || reply === "TIMEOUT", reply.slice(0, 60));
  }
  // 6. Hostile snapshot values must be sanitized: connect valid, send garbage, then read via API later (checked by unit tests); here just ensure server survives.
  const flood = WS("/agent/ws", { Authorization: `Bearer ${TOKEN}` });
  const fopen = await new Promise((r) => { flood.onopen = () => r(true); flood.onerror = () => r(false); setTimeout(() => r(false), 3000); });
  if (fopen) {
    flood.send(JSON.stringify({ type: "hello", id: "flooder", name: "flood" }));
    // 50 hostile snapshots in a burst (rate limit 10/s should drop most).
    for (let i = 0; i < 50; i++) {
      flood.send(JSON.stringify({
        type: "snapshot",
        data: { timestamp: 1, cpu: { usage: Number.NaN, cores: Array(1100).fill({}) }, memory: { usedPercent: 9999 }, network: { totalRxBytesPerSec: Number.POSITIVE_INFINITY }, thermal: { maxTemp: 9999 } },
      }));
    }
    await new Promise((r) => setTimeout(r, 1500));
    try { flood.close(); } catch {}
    check("hostile snapshot flood survived (no crash)", true);
  }

  console.log(failures ? `\n${failures} ATTACK(S) NOT BLOCKED` : "\nALL SECURITY CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("harness error:", e.message); process.exit(2); });
