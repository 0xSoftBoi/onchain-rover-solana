import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import * as raceStore from "./race-store.js";

type DriverSlot = "challenger" | "opponent";
type RobotName = "guard" | "courier";

type TypedDataEnvelope = {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

const LOCAL_KEYS = {
  challenger: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  opponent: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const;

const accounts = {
  challenger: privateKeyToAccount(LOCAL_KEYS.challenger),
  opponent: privateKeyToAccount(LOCAL_KEYS.opponent),
} as const;

const sidecarHttp = normalizeHttpUrl(process.env.SIDECAR_URL ?? "http://127.0.0.1:4021");
const finishThreshold = numberEnv("E2E_FIELD_FINISH_ODOMETRY", 0.14);
const guardPort = numberEnv("FIELD_GUARD_PORT", 8121);
const courierPort = numberEnv("FIELD_COURIER_PORT", 8122);
const children: ChildProcessWithoutNullStreams[] = [];

async function main() {
  const chain = await getJson("/chain/health");
  if (!chain.ok) throw new Error("local chain is not healthy");

  startHarness("guard", guardPort);
  startHarness("courier", courierPort);
  await Promise.all([
    waitForUrl(`http://127.0.0.1:${guardPort}/health`, 30_000),
    waitForUrl(`http://127.0.0.1:${courierPort}/health`, 30_000),
  ]);
  startBridge("guard", guardPort);
  startBridge("courier", courierPort);
  await waitForRobotsConnected(["guard", "courier"]);

  let round = await postJson("/race/round/challenge", {
    wallet: accounts.challenger.address,
    displayName: "challenger",
    stakeUsdc: "1.00",
    feeUsdc: "0.25",
    durationSecs: 20,
    countdownSecs: 1,
  });
  round = await postJson(`/race/round/${round.id}/accept`, {
    wallet: accounts.opponent.address,
    displayName: "opponent",
  });
  round = await postJson(`/race/round/${round.id}/chain/open`);

  await postJson("/chain/faucet", { wallet: accounts.challenger.address, amount: "20" });
  await postJson("/chain/faucet", { wallet: accounts.opponent.address, amount: "20" });

  round = await joinDriver(round.id, "challenger", accounts.challenger);
  round = await joinDriver(round.id, "opponent", accounts.opponent);
  round = await postJson(`/race/round/${round.id}/chain/lock`);
  round = await postJson(`/race/round/${round.id}/lock`, { skipRobotAuth: true });
  round = await postJson(`/race/round/${round.id}/countdown`);
  await sleep(Math.max(0, (round.roundStartsAt ?? Date.now()) - Date.now()) + 100);
  round = await postJson(`/race/round/${round.id}/start`);
  round = await postJson(`/race/round/${round.id}/chain/start`);

  const challengerPilot = await postJson(`/race/round/${round.id}/pilot/session`, {
    slot: "challenger",
    speed_mode: "high",
  });
  const opponentPilot = await postJson(`/race/round/${round.id}/pilot/session`, {
    slot: "opponent",
    speed_mode: "medium",
  });
  const challengerDrive = await openDriveSocket(challengerPilot.driveWs, challengerPilot.token);
  const opponentDrive = await openDriveSocket(opponentPilot.driveWs, opponentPilot.token);

  let odometry = 0;
  for (let i = 0; i < 80; i++) {
    challengerDrive.send(JSON.stringify({
      token: challengerPilot.token,
      left: 1,
      right: 1,
      speed_mode: "high",
      t: Date.now(),
    }));
    opponentDrive.send(JSON.stringify({
      token: opponentPilot.token,
      left: 0.35,
      right: 0.35,
      speed_mode: "medium",
      t: Date.now(),
    }));
    await sleep(90);
    odometry = await robotOdometry("guard");
    if (odometry >= finishThreshold) break;
  }

  stopDrive(challengerDrive, challengerPilot.token);
  stopDrive(opponentDrive, opponentPilot.token);
  challengerDrive.close();
  opponentDrive.close();

  if (odometry < finishThreshold) {
    throw new Error(`guard did not reach finish threshold: ${odometry}`);
  }

  const detection = await postJson(`/race/round/${round.id}/finish-detection`, {
    robot: "guard",
    source: "field-sim",
    method: "robot-harness-odometry",
    confidence: 0.99,
    metrics: { odometry, threshold: finishThreshold },
  });
  round = detection.round;
  round = await postJson(`/race/round/${round.id}/chain/settle`);
  const evidence = await getJson(`/race/round/${round.id}/evidence/hash`);
  const trace = await getJson(`/race/round/${round.id}/telemetry-trace`);
  const preflight = await getJson("/field/preflight");
  assertPersistedLedger(round, evidence);
  assertTelemetryTrace(round, trace);
  cleanup();

  console.log("Field simulator e2e passed");
  console.log(`  roundId:      ${round.id}`);
  console.log(`  chainRaceId:  ${round.chainRaceId}`);
  console.log(`  winner:       ${round.winner}`);
  console.log(`  proofHash:    ${evidence.proofHash}`);
  console.log(`  evidenceHash: ${evidence.evidenceHash}`);
  console.log(`  guard odo:    ${odometry.toFixed(3)}`);
  console.log(`  preflight:    ${preflight.ok ? "ready enough" : "needs attention"}`);
}

function startHarness(robot: RobotName, port: number) {
  spawnChild("cargo", [
    "run",
    "--quiet",
    "--",
    "--mode",
    "sim",
    "--role",
    robot,
    "--listen",
    `127.0.0.1:${port}`,
  ], "../../robot-harness");
}

function startBridge(robot: RobotName, port: number) {
  spawnChild("npx", ["tsx", "src/harness-bridge.ts"], "../", {
    SIDECAR_URL: sidecarHttp,
    ROBOT_URL: `http://127.0.0.1:${port}`,
    ROBOT: robot,
  });
}

function spawnChild(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
) {
  const child = spawn(command, args, {
    cwd: new URL(cwd, import.meta.url),
    env: { ...process.env, ...env },
  });
  children.push(child);
  child.stderr.on("data", (chunk) => {
    if (process.env.E2E_VERBOSE) process.stderr.write(chunk);
  });
  child.stdout.on("data", (chunk) => {
    if (process.env.E2E_VERBOSE) process.stdout.write(chunk);
  });
}

async function joinDriver(roundId: string, slot: DriverSlot, account: PrivateKeyAccount) {
  const request = await postJson(`/race/round/${roundId}/chain/authorization-request`, {
    slot,
    wallet: account.address,
  }) as { entry: TypedDataEnvelope; permit: TypedDataEnvelope };
  const entrySignature = await account.signTypedData({
    domain: request.entry.domain,
    types: request.entry.types,
    primaryType: request.entry.primaryType,
    message: request.entry.message,
  } as any);
  const permitSignature = await account.signTypedData({
    domain: request.permit.domain,
    types: request.permit.types,
    primaryType: request.permit.primaryType,
    message: request.permit.message,
  } as any);
  return postJson(`/race/round/${roundId}/chain/join`, {
    slot,
    entrySignature,
    permitSignature,
    entryDeadline: request.entry.message.deadline,
    permitDeadline: request.permit.message.deadline,
  });
}

async function robotOdometry(robot: RobotName) {
  const state = await getJson("/robot-link/state");
  const telemetry = state.robots?.[robot]?.telemetry;
  return (Number(telemetry?.odometry_left ?? 0) + Number(telemetry?.odometry_right ?? 0)) / 2;
}

async function waitForRobotsConnected(robots: RobotName[]) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const state = await getJson("/robot-link/state").catch(() => null);
    if (robots.every((robot) => state?.robots?.[robot]?.robotConnected)) return;
    await sleep(250);
  }
  throw new Error("not all robot bridges connected");
}

async function waitForUrl(url: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Keep waiting for the harness process.
    }
    await sleep(250);
  }
  throw new Error(`${url} did not become ready`);
}

async function openDriveSocket(url: string, token: string) {
  const driveUrl = rebaseWsUrl(url);
  const ws = new WebSocket(driveUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ token, left: 0, right: 0, speed_mode: "high", t: Date.now() }));
  return ws;
}

function stopDrive(ws: WebSocket, token: string) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ token, left: 0, right: 0, speed_mode: "medium", t: Date.now() }));
}

async function getJson(path: string) {
  const res = await fetch(`${sidecarHttp}${path}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `${path} failed ${res.status}`);
  return json;
}

async function postJson(path: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${sidecarHttp}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `${path} failed ${res.status}`);
  return json;
}

function assertPersistedLedger(round: any, evidence: any) {
  const paths = raceStore.persistedRoundPaths(round.id);
  const persistedRound = readJson(paths.round);
  const persistedEvidence = readJson(paths.evidence);
  const events = readFileSync(paths.events, "utf8");
  if (persistedRound.status !== "settled") throw new Error("persisted round is not settled");
  if (persistedRound.proofHash !== evidence.proofHash) throw new Error("persisted proof hash mismatch");
  if (persistedEvidence.proofHash !== evidence.proofHash) throw new Error("persisted evidence proof mismatch");
  if (!events.includes("\"kind\":\"round.chain_settled\"")) throw new Error("missing settlement event");
  if (!events.includes("\"source\":\"field-sim\"")) throw new Error("missing field sim evidence event");
}

function assertTelemetryTrace(round: any, trace: any) {
  if (trace.traceId !== round.telemetryTraceId) throw new Error("trace id mismatch");
  if (!(trace.frameCount > 0)) throw new Error("trace has no frames");
  const challenger = trace.drivers?.challenger;
  if (!(challenger?.frameCount > 0)) throw new Error("challenger trace missing frames");
  if (!(Number(challenger?.odometry?.last ?? 0) > 0)) throw new Error("challenger trace missing odometry");
  if (challenger?.camera?.health !== "healthy") throw new Error("challenger trace missing healthy camera summary");
  if (!trace.notableEvents?.some((event: { type?: string }) => event.type === "round-start")) {
    throw new Error("trace missing round-start event");
  }
  if (!trace.notableEvents?.some((event: { type?: string }) => event.type === "round-finish")) {
    throw new Error("trace missing round-finish event");
  }
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalizeHttpUrl(value: string) {
  return value.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/$/, "");
}

function rebaseWsUrl(value: string) {
  const target = new URL(value);
  const base = new URL(sidecarHttp.replace(/^http:/, "ws:").replace(/^https:/, "wss:"));
  target.protocol = base.protocol;
  target.host = base.host;
  return target.toString();
}

function numberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
  return value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on("exit", () => cleanup());

function cleanup() {
  for (const child of children) {
    if (!child.killed) child.kill("SIGINT");
  }
  children.splice(0, children.length);
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
