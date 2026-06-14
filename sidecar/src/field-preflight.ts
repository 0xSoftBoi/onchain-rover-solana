import { ARC, ROBOTS } from "./config.js";
import * as chain from "./chain.js";
import * as robotLink from "./robot-link.js";
import * as rounds from "./rounds.js";

export type PreflightStatus = "pass" | "warn" | "fail";

export type PreflightCheck = {
  name: string;
  category: string;
  ok: boolean;
  status: PreflightStatus;
  detail: string;
  remediation: string;
};

type BuildOptions = {
  publicBaseUrl: string;
  allowFreePilot: boolean;
  allowLocalDevWallets: boolean;
};

type ProbeResult = {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  body?: any;
  error?: string;
};

const TELEMETRY_STALE_MS = 1600;

export async function buildFieldPreflight(opts: BuildOptions) {
  const checks: PreflightCheck[] = [];
  const add = (
    category: string,
    name: string,
    status: PreflightStatus,
    detail: string,
    remediation: string,
  ) => checks.push({ category, name, status, ok: status !== "fail", detail, remediation });

  addCoordinatorChecks(add, opts.publicBaseUrl);
  addClockCheck(add);
  addConfigChecks(add, opts);

  const [chainHealth, treasury, robotProbes] = await Promise.all([
    chain.localChainHealth().catch((e: any) => ({ ok: false, error: e.message })),
    chain.localTreasuryInfo().catch((e: any) => ({ error: e.message })),
    probeRobots(),
  ]);

  add("chain", "local chain", Boolean((chainHealth as any).ok) ? "pass" : "fail",
    Boolean((chainHealth as any).ok)
      ? `chain ${(chainHealth as any).chainId} block ${(chainHealth as any).blockNumber}`
      : String((chainHealth as any).error ?? "unavailable"),
    "Start the local chain, deploy contracts, then refresh this check.");

  add("chain", "treasury", "error" in treasury ? "fail" : "pass",
    "error" in treasury ? treasury.error : `${treasury.totalFees} local units collected`,
    "Run the local deployment and confirm the treasury address in generated contracts.");

  const bridge = robotLink.robotLinkState() as Record<string, any>;
  for (const name of ["guard", "courier"] as const) {
    addRobotChecks(add, name, robotProbes[name], bridge[name]);
  }

  const latestRounds = rounds.listRounds().slice(0, 8);
  addRoundChecks(add, latestRounds);

  const latestCalibration = latestRounds[0]?.stageCalibration ?? null;
  add("race", "stage calibration", latestCalibration ? "pass" : "warn",
    latestCalibration
      ? `${latestCalibration.finishLineFt - latestCalibration.startLineFt}ft run, ${latestCalibration.laneWidthFt}ft lane`
      : "no round calibration yet",
    "Create or load a round and save stage calibration before field setup.");

  const urls = {
    field: `${opts.publicBaseUrl}/field.html`,
    lobby: `${opts.publicBaseUrl}/lobby.html`,
    round: `${opts.publicBaseUrl}/round.html`,
    finishCamera: `${opts.publicBaseUrl}/finish-camera.html`,
    pilotChallengerTemplate: `${opts.publicBaseUrl}/pilot.html?robot=guard&round=<roundId>&slot=challenger&transport=ws&speed=high&entry=x402`,
    pilotOpponentTemplate: `${opts.publicBaseUrl}/pilot.html?robot=courier&round=<roundId>&slot=opponent&transport=ws&speed=high&entry=x402`,
  };

  const summary = {
    pass: checks.filter((check) => check.status === "pass").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length,
  };

  return {
    ok: summary.fail === 0,
    generatedAt: Date.now(),
    publicBaseUrl: opts.publicBaseUrl,
    summary,
    checks,
    chain: chainHealth,
    treasury,
    stageCalibration: latestCalibration,
    robots: bridge,
    rounds: latestRounds,
    urls,
    env: {
      allowFreePilot: opts.allowFreePilot,
      allowLocalDevWallets: opts.allowLocalDevWallets,
      raceDataDir: process.env.RACE_DATA_DIR ?? "sidecar/data/races",
      publicSidecarUrl: process.env.PUBLIC_SIDECAR_URL ?? null,
      publicLocalChainRpcUrl: process.env.PUBLIC_LOCAL_CHAIN_RPC_URL ?? null,
      x402: {
        enabled: /^0x[a-fA-F0-9]{40}$/.test(process.env.TREASURY_ADDRESS ?? ""),
        network: ARC.caip2,
        chainId: ARC.chainId,
        rpcUrl: ARC.rpc,
        usdc: ARC.usdc,
        gatewayWallet: ARC.gatewayWallet,
        facilitatorUrl: ARC.facilitatorUrl,
        treasuryAddress: process.env.TREASURY_ADDRESS ?? null,
        raceNetworkFeeUsdc: process.env.RACE_NETWORK_FEE_USDC ?? "0.25",
      },
    },
  };
}

function addCoordinatorChecks(
  add: (category: string, name: string, status: PreflightStatus, detail: string, remediation: string) => void,
  publicBaseUrl: string,
) {
  const localOnly = /\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(publicBaseUrl);
  add("network", "coordinator", localOnly ? "warn" : "pass",
    localOnly ? `${publicBaseUrl} is local-only` : `sidecar serving ${publicBaseUrl}`,
    localOnly
      ? "Set PUBLIC_SIDECAR_URL to the LAN URL phones and detector devices can reach."
      : "Keep this URL stable for phones, finish camera, and robot bridge links.");
}

function addClockCheck(
  add: (category: string, name: string, status: PreflightStatus, detail: string, remediation: string) => void,
) {
  const now = new Date();
  const plausible = now.getUTCFullYear() >= 2026 && now.getUTCFullYear() <= 2030;
  add("system", "clock", plausible ? "pass" : "fail",
    now.toISOString(),
    "Enable network time sync before signing authorizations or comparing telemetry timestamps.");
}

function addConfigChecks(
  add: (category: string, name: string, status: PreflightStatus, detail: string, remediation: string) => void,
  opts: BuildOptions,
) {
  add("config", "pilot mode", opts.allowFreePilot || opts.allowLocalDevWallets ? "pass" : "warn",
    opts.allowFreePilot
      ? "ALLOW_FREE_PILOT enabled"
      : opts.allowLocalDevWallets
        ? "ALLOW_LOCAL_DEV_WALLETS enabled"
        : "paid/on-chain entry required",
    "For local rehearsals set ALLOW_FREE_PILOT=1 or ALLOW_LOCAL_DEV_WALLETS=1.");

  const facilitatorKey = process.env.FACILITATOR_PRIVATE_KEY || process.env.LOCAL_FACILITATOR_PRIVATE_KEY;
  add("config", "facilitator key", facilitatorKey ? "pass" : "fail",
    facilitatorKey ? "configured" : "missing",
    "Set LOCAL_FACILITATOR_PRIVATE_KEY or FACILITATOR_PRIVATE_KEY before chain join/lock steps.");

  add("config", "token faucet key", process.env.LOCAL_TOKEN_OWNER_PRIVATE_KEY ? "pass" : "warn",
    process.env.LOCAL_TOKEN_OWNER_PRIVATE_KEY ? "configured" : "missing",
    "Set LOCAL_TOKEN_OWNER_PRIVATE_KEY if operators need the Fund Driver Wallets button.");

  for (const [name, robot] of Object.entries(ROBOTS)) {
    add("config", `${name} URL`, robot.url ? "pass" : "fail",
      robot.url || "missing",
      `Set ${name.toUpperCase()}_URL to the robot service base URL.`);
    add("config", `${name} wallet`, /^0x[a-fA-F0-9]{40}$/.test(robot.wallet) ? "pass" : "warn",
      robot.wallet || "missing",
      `Set ${name.toUpperCase()}_WALLET before paid or on-chain flows.`);
  }
}

async function probeRobots() {
  const entries = await Promise.all(Object.entries(ROBOTS).map(async ([name, robot]) => {
    const [health, capabilities, sensors] = await Promise.all([
      probeJson(`${robot.url}/health`, 2500),
      probeJson(`${robot.url}/capabilities`, 2500),
      probeJson(`${robot.url}/sensors`, 2500),
    ]);
    return [name, { health, capabilities, sensors }] as const;
  }));
  return Object.fromEntries(entries) as Record<string, { health: ProbeResult; capabilities: ProbeResult; sensors: ProbeResult }>;
}

async function probeJson(url: string, timeoutMs: number): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text ? { raw: text.slice(0, 160) } : null;
    }
    return { ok: res.ok, status: res.status, latencyMs: Date.now() - started, body };
  } catch (e: any) {
    const message = e?.name === "TimeoutError" ? "network timeout" : String(e?.message ?? e);
    return { ok: false, latencyMs: Date.now() - started, error: message };
  }
}

function addRobotChecks(
  add: (category: string, name: string, status: PreflightStatus, detail: string, remediation: string) => void,
  name: "guard" | "courier",
  probe: { health: ProbeResult; capabilities: ProbeResult; sensors: ProbeResult },
  bridge: any,
) {
  const health = probe.health;
  add("robot", `${name} service`, health.ok && health.body?.ok !== false ? "pass" : "fail",
    probeDetail(health, `${ROBOTS[name].url}/health`),
    "Check robot power, WiFi or USB-net, service port, and stale ROBOT_URL values.");

  const capabilities = probe.capabilities;
  add("robot", `${name} Rust capabilities`, capabilities.ok && capabilities.body?.ok !== false ? "pass" : "warn",
    capabilities.ok ? rustCapabilitiesDetail(capabilities.body) : probeDetail(capabilities, `${ROBOTS[name].url}/capabilities`),
    "Start the Rust robot-harness service or confirm this robot is intentionally using a legacy adapter.");

  const bridgeConnected = Boolean(bridge?.robotConnected);
  add("robot", `${name} bridge`, bridgeConnected ? "pass" : "warn",
    bridgeConnected
      ? `attached, telemetry age ${bridge.robotAgeMs ?? 0}ms`
      : "not attached to sidecar websocket",
    "Start the Rust robot server bridge or connect the simulator before race start.");

  const telemetryAge = finiteAny(bridge?.robotAgeMs);
  add("robot", `${name} telemetry freshness`, bridgeConnected && telemetryAge !== null && telemetryAge <= TELEMETRY_STALE_MS ? "pass" : bridgeConnected ? "fail" : "warn",
    bridgeConnected
      ? telemetryAge !== null
        ? `${telemetryAge}ms since last robot frame`
        : "bridge attached but telemetry age missing"
      : "no robot websocket telemetry",
    "Restart the harness bridge and confirm `/ws/telemetry` is streaming from the Rust robot service.");

  const telemetry = bridge?.telemetry ?? health.body ?? probe.sensors.body ?? {};
  const battery = batteryVoltage(telemetry);
  add("robot", `${name} battery telemetry`, battery ? "pass" : "warn",
    battery ? `${battery.toFixed(2)}V` : "no battery voltage in health, sensors, or bridge telemetry",
    "Confirm ESP32 telemetry frames are flowing and battery fields are mapped.");

  const sensors = sensorGroupStatus(probe.sensors.body ?? telemetry);
  add("robot", `${name} sensor groups`, sensors.status, sensors.detail,
    "Check `/sensors` on the Rust server for battery, odometry, IMU, lidar, camera, and raw frame fields.");

  const camera = cameraStatus(telemetry);
  add("robot", `${name} camera`, camera.status === "available" ? "pass" : "warn",
    camera.detail,
    "Check camera cable, permissions, and whether another process owns the device.");

  const serial = serialStatus(probe.sensors.body ?? telemetry);
  add("robot", `${name} serial`, serial.status, serial.detail,
    "Stop the old Python/Waveshare app, release the serial device, and restart the Rust server.");

  const motors = motorStatus(bridge, telemetry);
  add("robot", `${name} motors`, motors.status, motors.detail,
    "Use `/robot/:robot/stop` or Rust `/motors/stop`; clear estop only after the stage is safe.");
}

function probeDetail(probe: ProbeResult, url: string) {
  if (probe.ok) return `HTTP ${probe.status} in ${probe.latencyMs}ms at ${url}`;
  if (probe.status) return `HTTP ${probe.status} from ${url}`;
  return `${probe.error ?? "network failure"} at ${url}`;
}

function rustCapabilitiesDetail(value: any): string {
  const mode = String(value?.mode ?? "unknown");
  const role = String(value?.role ?? "unknown");
  const serialPort = String(value?.serial_port ?? "no serial");
  const endpoints = Array.isArray(value?.endpoints) ? value.endpoints.length : 0;
  const camera = String(value?.camera?.status ?? "no camera");
  return `${role} ${mode} on ${serialPort}; camera ${camera}; ${endpoints} endpoints`;
}

function batteryVoltage(value: any): number | null {
  const direct = finite(value?.battery_v);
  if (direct) return direct;
  return finite(value?.sensors?.battery?.voltage_v)
    ?? finite(value?.battery?.voltage_v)
    ?? null;
}

function cameraStatus(value: any): { status: "available" | "missing"; detail: string } {
  const raw = String(value?.camera?.status ?? value?.sensors?.camera?.status ?? "").toLowerCase();
  if (raw && !/(missing|unavailable|error|busy|denied|absent)/.test(raw)) {
    return { status: "available", detail: raw };
  }
  return { status: "missing", detail: raw || "no camera status reported" };
}

function sensorGroupStatus(value: any): { status: PreflightStatus; detail: string } {
  const sensors = value?.sensors ?? value;
  const parts = {
    battery: String(sensors?.battery?.status ?? (finite(value?.battery_v) ? "available" : "")).toLowerCase(),
    odometry: String(sensors?.odometry?.status ?? (finite(value?.odometry_left) || finite(value?.odometry_right) ? "available" : "")).toLowerCase(),
    imu: String(sensors?.imu?.status ?? "").toLowerCase(),
    lidar: String(sensors?.lidar?.status ?? value?.lidar?.status ?? "").toLowerCase(),
    camera: String(sensors?.camera?.status ?? value?.camera?.status ?? "").toLowerCase(),
    raw: String(sensors?.raw_frame?.status ?? value?.raw_frame?.status ?? "").toLowerCase(),
  };
  const missingRequired = (["battery", "odometry", "raw"] as const)
    .filter((key) => !statusAvailable(parts[key]));
  const missingOptional = (["imu", "lidar", "camera"] as const)
    .filter((key) => parts[key] && !statusAvailable(parts[key]));
  const detail = Object.entries(parts)
    .map(([key, status]) => `${key}:${status || "missing"}`)
    .join(" ");
  if (missingRequired.length) return { status: "fail", detail };
  if (missingOptional.length) return { status: "warn", detail };
  return { status: "pass", detail };
}

function statusAvailable(status: string): boolean {
  return Boolean(status) && !/(missing|unavailable|error|busy|denied|absent|stale)/.test(status);
}

function serialStatus(value: any): { status: PreflightStatus; detail: string } {
  const raw = String(value?.serial?.status ?? value?.sensors?.raw_frame?.status ?? value?.raw_frame?.status ?? "").toLowerCase();
  if (!raw) return { status: "warn", detail: "serial/raw-frame status not reported" };
  if (/(busy|permission|denied|locked)/.test(raw)) return { status: "fail", detail: `serial ${raw}` };
  if (/(missing|absent|unavailable|error)/.test(raw)) return { status: "fail", detail: `serial ${raw}` };
  return { status: "pass", detail: `serial ${raw}` };
}

function motorStatus(bridge: any, telemetry: any): { status: PreflightStatus; detail: string } {
  const left = finiteAny(telemetry?.left_cmd) ?? finiteAny(bridge?.lastCommand?.left) ?? 0;
  const right = finiteAny(telemetry?.right_cmd) ?? finiteAny(bridge?.lastCommand?.right) ?? 0;
  const estop = telemetry?.estop === true;
  const stoppedByDeadman = telemetry?.stopped_by_deadman === true;
  const speedMode = String(telemetry?.speed_mode ?? bridge?.lastCommand?.speed_mode ?? "unknown");

  if (estop) {
    return { status: "warn", detail: `estop active; L ${left.toFixed(2)} R ${right.toFixed(2)} ${speedMode}` };
  }
  if (Math.abs(left) > 0 || Math.abs(right) > 0) {
    return { status: "warn", detail: `nonzero command L ${left.toFixed(2)} R ${right.toFixed(2)} ${speedMode}` };
  }
  return {
    status: "pass",
    detail: stoppedByDeadman
      ? `stopped after deadman; L ${left.toFixed(2)} R ${right.toFixed(2)} ${speedMode}`
      : `stopped; L ${left.toFixed(2)} R ${right.toFixed(2)} ${speedMode}`,
  };
}

function addRoundChecks(
  add: (category: string, name: string, status: PreflightStatus, detail: string, remediation: string) => void,
  recentRounds: rounds.Round[],
) {
  const active = recentRounds.find((round) => !["settled", "canceled"].includes(round.status));
  if (!active) {
    add("race", "active race", "warn", "no active round", "Create a round and run No-Phone Prep or phone joins before drivers arrive.");
    return;
  }
  const missing = (["challenger", "opponent"] as const).filter((slot) => {
    const driver = active.drivers[slot];
    return !driver?.feePaid || !driver.stakeAuthorized;
  });
  add("race", "active race", missing.length ? "warn" : "pass",
    missing.length
      ? `${active.id} ${active.status}; missing ${missing.join(", ")} readiness`
      : `${active.id} ${active.status}/${active.chainStatus ?? "not-opened"} ready`,
    "Use round.html to fund, join, lock escrow, and authorize robots before start.");
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteAny(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
