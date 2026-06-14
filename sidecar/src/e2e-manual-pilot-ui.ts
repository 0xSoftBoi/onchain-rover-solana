import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

type CdpReply = {
  id?: number;
  sessionId?: string;
  method?: string;
  result?: any;
  error?: { message?: string };
};

const chromeBin = process.env.CHROME_BIN
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const debugPort = Number(process.env.CHROME_DEBUG_PORT ?? 9303);
const robot = process.env.ROBOT ?? "guard";
const sidecarBase = (process.env.SIDECAR_URL ?? "http://127.0.0.1:4021").replace(/\/$/, "");
const robotBase = (process.env.ROBOT_URL ?? "http://192.168.0.192:8000").replace(/\/$/, "");
const pilotUrl = process.env.PILOT_URL
  ?? `${sidecarBase}/pilot.html?robot=${encodeURIComponent(robot)}&mode=manual&speed=low&v=manual-drive-proof`;

async function assertSidecarReady() {
  const res = await fetch(`${sidecarBase}/robot-link/state`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`sidecar state failed ${res.status}`);
}

async function launchChrome() {
  const userDataDir = mkdtempSync(join(tmpdir(), "onchain-rover-chrome-"));
  const chrome = spawn(chromeBin, [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--disable-gpu",
    "about:blank",
  ]);
  chrome.stderr.on("data", () => undefined);

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      const body = await res.json() as { webSocketDebuggerUrl?: string };
      if (body.webSocketDebuggerUrl) return { chrome, userDataDir, webSocketDebuggerUrl: body.webSocketDebuggerUrl };
    } catch {
      await sleep(150);
    }
  }
  chrome.kill();
  throw new Error("chrome devtools endpoint did not start");
}

class CdpClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>();

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as CdpReply;
      if (!msg.id) return;
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        waiter.reject(new Error(msg.error.message || "cdp command failed"));
      } else {
        waiter.resolve(msg.result);
      }
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return new CdpClient(ws);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    this.ws.close();
  }
}

async function main() {
  let chrome: ChildProcessWithoutNullStreams | null = null;
  let cdp: CdpClient | null = null;
  let userDataDir = "";

  try {
    await assertSidecarReady();
    await stopRobot();
    const launched = await launchChrome();
    chrome = launched.chrome;
    userDataDir = launched.userDataDir;
    cdp = await CdpClient.connect(launched.webSocketDebuggerUrl);

    const target = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attach = await cdp.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    const sessionId = attach.sessionId as string;

    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.navigate", { url: pilotUrl }, sessionId);
    await waitForExpression(cdp, sessionId, "document.readyState !== 'loading'");
    await waitForExpression(cdp, sessionId, "window.__pilotReady === true");

    await evaluate(cdp, sessionId, "document.querySelector('#startButton')?.click(); true");
    await waitForExpression(cdp, sessionId, "document.querySelector('#startModal')?.classList.contains('hidden') === true");

    const box = await evaluate<{ x: number; y: number; width: number; height: number }>(cdp, sessionId, `(() => {
      const el = document.querySelector('#driveZone');
      if (!el) throw new Error('missing drive zone');
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`);
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const targetPoint = {
      x: center.x + Math.min(62, box.width * 0.32),
      y: center.y - Math.min(70, box.height * 0.36),
    };

    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: center.x,
      y: center.y,
      button: "none",
    }, sessionId);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: center.x,
      y: center.y,
      button: "left",
      clickCount: 1,
    }, sessionId);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: targetPoint.x,
      y: targetPoint.y,
      button: "left",
    }, sessionId);
    await sleep(650);

    const held = await readRobotState(cdp, sessionId);
    assertNonZero(held, "held joystick");

    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: targetPoint.x,
      y: targetPoint.y,
      button: "left",
      clickCount: 1,
    }, sessionId);
    await sleep(450);
    const afterRelease = await readRobotState(cdp, sessionId);
    assertNonZero(afterRelease, "released joystick hold");

    await evaluate(cdp, sessionId, "document.querySelector('#estop')?.click(); true");
    await sleep(450);
    const stopped = await readRobotState(cdp, sessionId);
    assertZero(stopped, "stop button");
    await stopRobot();

    console.log(JSON.stringify({
      ok: true,
      pilotUrl,
      held: commandSummary(held),
      afterRelease: commandSummary(afterRelease),
      stopped: commandSummary(stopped),
    }, null, 2));
  } catch (err) {
    await stopRobot().catch(() => undefined);
    throw err;
  } finally {
    await cdp?.send("Browser.close").catch(() => undefined);
    cdp?.close();
    if (chrome && !chrome.killed) chrome.kill();
    if (userDataDir) await removeTempDir(userDataDir);
  }
}

async function evaluate<T>(client: CdpClient, sessionId: string, expression: string): Promise<T> {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "browser evaluation failed");
  }
  return result.result.value as T;
}

async function waitForExpression(client: CdpClient, sessionId: string, expression: string) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await evaluate<boolean>(client, sessionId, `Boolean(${expression})`)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${expression}`);
}

async function readRobotState(client: CdpClient, sessionId: string): Promise<any> {
  return evaluate(client, sessionId, `fetch('/robot-link/state').then((res) => res.json()).then((state) => state.robots.${robot})`);
}

function assertNonZero(state: any, label: string) {
  const { left, right } = state?.lastCommand ?? {};
  if (Math.abs(Number(left)) + Math.abs(Number(right)) <= 0.001) {
    throw new Error(`${label} did not produce nonzero drive command: ${JSON.stringify(state?.lastCommand)}`);
  }
}

function assertZero(state: any, label: string) {
  const { left, right } = state?.lastCommand ?? {};
  if (Math.abs(Number(left)) + Math.abs(Number(right)) > 0.001) {
    throw new Error(`${label} did not zero drive command: ${JSON.stringify(state?.lastCommand)}`);
  }
}

function commandSummary(state: any) {
  return {
    pilotClients: state?.pilotClients,
    sessions: state?.sessions,
    lastCommand: state?.lastCommand,
    telemetry: {
      left_cmd: state?.telemetry?.left_cmd,
      right_cmd: state?.telemetry?.right_cmd,
      deadman_ok: state?.telemetry?.deadman_ok,
      source: state?.telemetry?.source,
    },
  };
}

async function stopRobot() {
  await fetch(`${sidecarBase}/robot/${encodeURIComponent(robot)}/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(2000),
  }).catch(() => undefined);
  await fetch(`${robotBase}/motors/stop`, {
    method: "POST",
    signal: AbortSignal.timeout(2000),
  }).catch(() => undefined);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeTempDir(path: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await sleep(150);
    }
  }
}

await main();
