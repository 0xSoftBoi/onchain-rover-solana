// Minimal browser-stub harness to runtime-smoke-test the inline broadcast scripts.
const fs = require("fs");
const path = process.argv[2];
const html = fs.readFileSync(path, "utf8");
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const script = blocks.join("\n;\n");

// ---- stubs ----------------------------------------------------------------
function classList() {
  const s = new Set();
  return {
    add: (...x) => x.forEach(v => s.add(v)),
    remove: (...x) => x.forEach(v => s.delete(v)),
    toggle: (v, f) => { const on = f === undefined ? !s.has(v) : f; on ? s.add(v) : s.delete(v); return on; },
    contains: v => s.has(v),
  };
}
function ctx() { return new Proxy({}, { get: () => () => {}, set: () => true }); }
function el() {
  const style = new Proxy({}, { get: () => "", set: () => true });
  const base = {
    textContent: "", innerHTML: "", value: "", src: "", style, classList: classList(),
    setAttribute() {}, getAttribute() { return ""; }, appendChild(c) { return c; }, removeChild() {},
    addEventListener() {}, removeEventListener() {}, animate() { return {}; }, remove() {},
    closest() { return null; }, getContext() { return ctx(); }, offsetWidth: 100, scrollWidth: 240,
    nextElementSibling: null, dataset: {}, children: [], querySelectorAll() { return []; }, focus() {},
  };
  return new Proxy(base, { get(t, p) { return p in t ? t[p] : () => {}; }, set(t, p, v) { t[p] = v; return true; } });
}
const els = {};
const body = el();
global.document = {
  hidden: false,
  body, documentElement: el(),
  getElementById(id) { return els[id] || (els[id] = el()); },
  querySelectorAll() { return []; },
  createElement() { return el(); },
  addEventListener(ev, fn) { if (ev === "visibilitychange") global.__vis = fn; },
};
global.window = global;
global.innerWidth = 1920; global.innerHeight = 1080;
global.addEventListener = () => {};
global.location = { search: process.env.QS || "", origin: "http://localhost:8080" };
global.navigator = { userAgent: "node" };
global.requestAnimationFrame = () => 0;
global.cancelAnimationFrame = () => {};
const realSetTimeout = setTimeout;
global.setTimeout = () => 0;           // don't auto-run scheduled work (avoids scene/boot loops)
global.clearTimeout = () => {};
global.setInterval = () => 0;
global.clearInterval = () => {};
global.localStorage = (() => { let m = {}; return { getItem: k => k in m ? m[k] : null, setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } }; })();
function audioNode() { return new Proxy({ frequency: { value: 0, setValueAtTime() {} }, gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, start() {}, stop() {}, type: "" }, { get(t, p) { return p in t ? t[p] : () => {}; }, set(t, p, v) { t[p] = v; return true; } }); }
global.AudioContext = global.webkitAudioContext = function () {
  return { currentTime: 0, state: "running", destination: {}, resume() {}, createOscillator: audioNode, createGain: audioNode, createBiquadFilter: audioNode, createBufferSource: audioNode, createBuffer: () => ({ getChannelData: () => new Float32Array(8) }), sampleRate: 48000 };
};
global.qrcode = function () { return { addData() {}, make() {}, createSvgTag() { return "<svg></svg>"; } }; };

// mock data per endpoint (mirrors clanker-mock shapes)
const DATA = {
  "/race/state": { id: "clanker-500", status: global.__status || "betting", winner: undefined },
  "/race/odds": { pool: { guard: 3, courier: 5 }, total: 8, odds: { guard: 2.67, courier: 1.6 }, count: 6 },
  "/onchain/feed": { events: [], settledUsdc: 12.5, count: 9 },
  "/reason/feed": { events: [{ robot: "guard", phase: "offer", text: "opening at $2", kind: "offer", t: 1 }] },
  "/reputation": { guard: { avg: 95, count: 7 }, courier: { avg: 91, count: 4 } },
  "/status": { robots: { guard: { ok: true, ens: "guard.roverfleet.eth", feed: "x", battery_v: 12.4 }, courier: { ok: true, ens: "courier.roverfleet.eth", feed: "y", battery_v: 12.1 } } },
  "/worldid/config": { configured: true, action: "rover-gp-bet", appId: "app_clanker500" },
  "/leaderboard/network": { configured: true, rows: [{ agent: "vroom.eth", feedback: 142 }] },
  "/race/markets": { roundId: "clanker-500", status: "open", markets: [
    { id: "winner-clanker-500", type: "WINNER", label: "Race Winner", outcomes: ["guard", "courier"], pools: { guard: 13, courier: 5 }, total: 18, odds: { guard: 1.38, courier: 3.6 }, status: "open", winningOutcome: null },
    { id: "margin-clanker-500", type: "MARGIN", label: "Winning Margin", outcomes: ["blowout", "photo"], pools: { blowout: 2, photo: 2 }, total: 4, odds: { blowout: 2, photo: 2 }, status: "open", winningOutcome: null },
  ] },
};
global.fetch = (u) => {
  const p = String(u).replace(global.location.origin, "").split("?")[0];
  const d = DATA[p] !== undefined ? DATA[p] : {};
  if (p === "/race/state") d.status = global.__status || "betting";
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(d) });
};
global.EventSource = function () { global.__es = this; this.onmessage = null; this.onerror = null; };

// ---- run ------------------------------------------------------------------
(async () => {
  try {
    new Function(script)();
    await new Promise(r => realSetTimeout(r, 50));          // flush loadWid().then(poll) + async polls

    // exercise the bus
    const push = e => { if (global.__es && global.__es.onmessage) global.__es.onmessage({ data: JSON.stringify(e) }); };
    push({ layer: "chain", kind: "BET", severity: "ok", usdc: 2, detail: "$2 on courier", t: 1 });
    push({ layer: "backend", kind: "x402", detail: "paid POST /pilot/courier/start", severity: "ok", t: 2 });
    push({ layer: "chain", kind: "PAY", severity: "ok", usdc: 1.25, detail: "courier → guard", t: 3 });
    push({ kind: "RACE SETTLE", t: 4 });

    // exercise status transitions through poll
    for (const s of ["racing", "finished", "betting"]) {
      global.__status = s;
      await new Promise(r => realSetTimeout(r, 20));
      // poll isn't auto-looping (setInterval is no-op), so we can't re-call it directly;
      // instead verify the visibility controller path:
    }
    // visibility toggle
    if (global.__vis) { global.document.hidden = true; global.__vis(); global.document.hidden = false; global.__vis(); }

    await new Promise(r => realSetTimeout(r, 30));
    console.log("RUNTIME OK — no exceptions");
  } catch (e) {
    console.log("RUNTIME ERROR:", e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n") : e);
    process.exit(1);
  }
})();
