// Shared CDP helper: launches headless Chrome in its own process group and
// guarantees the entire group (renderer/GPU children included) is reaped, so a
// SIGKILL on the launcher can never leave an orphaned child pinned at 100% CPU.
import { spawn, execSync } from "node:child_process";
import http from "node:http";

const CHROME = process.env.CHROME || "/usr/bin/google-chrome";

function getJSON(u) {
  return new Promise((res, rej) => {
    http
      .get(u, (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => res(JSON.parse(d)));
      })
      .on("error", rej);
  });
}

// Launch Chrome in a fresh process group. --no-zygote keeps Chrome from forking
// a persistent zygote that survives the parent; detached:true gives us a group
// id we can signal as a whole.
export async function launchChrome(port, extraArgs = []) {
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-zygote",
      "--disable-dev-shm-usage",
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      ...extraArgs,
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );

  let target;
  for (let i = 0; i < 40; i++) {
    try {
      const list = await getJSON(`http://127.0.0.1:${port}/json`);
      target = list.find((t) => t.type === "page");
      if (target) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!target) {
    killChrome(chrome);
    throw new Error("no CDP page target");
  }
  return { chrome, target };
}

// Reap the whole process group, then belt-and-suspenders: pkill any headless
// child that still points at our debugging port.
export function killChrome(chrome, port) {
  try {
    if (chrome?.pid) process.kill(-chrome.pid, "SIGKILL");
  } catch {}
  try {
    if (chrome?.pid) process.kill(chrome.pid, "SIGKILL");
  } catch {}
  if (port) {
    try {
      execSync(`pkill -9 -f 'remote-debugging-port=${port}'`, { stdio: "ignore" });
    } catch {}
  }
}

export function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      errors.push("EXC:" + (d.exception?.description || d.text));
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      errors.push("ERR:" + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  });
  const send = (method, params = {}) =>
    new Promise((r) => {
      const mid = ++id;
      pending.set(mid, r);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evalx = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  };
  return { ws, ready, send, evalx, errors };
}
