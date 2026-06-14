import { WebSocket } from "ws";

type RobotName = "guard" | "courier";
type SpeedMode = "low" | "medium" | "high";
type DriveTarget = {
  token: string;
  left: number;
  right: number;
  speedMode: SpeedMode;
  updatedAt: number;
};
type CameraTarget = {
  token: string;
  pan: number;
  tilt: number;
  speedMode: SpeedMode;
  updatedAt: number;
};

const robot = robotName(process.env.ROBOT ?? "guard");
const sidecarHttp = normalizeHttpUrl(process.env.SIDECAR_URL ?? "http://127.0.0.1:4021");
const sidecarWs = wsFromHttp(sidecarHttp);
const robotHttp = normalizeHttpUrl(process.env.ROBOT_URL ?? "http://127.0.0.1:8000");
const robotWs = wsFromHttp(robotHttp);
const driveMode = process.env.ROBOT_DRIVE_MODE === "rest" ? "rest" : "ws";
const wsFlushMs = positiveNumber(process.env.ROBOT_WS_FLUSH_MS, 25);
const wsTargetStaleMs = positiveNumber(process.env.ROBOT_WS_TARGET_STALE_MS, 900);
const telemetryMode = process.env.ROBOT_TELEMETRY_MODE === "off"
  ? "off"
  : process.env.ROBOT_TELEMETRY_MODE === "poll" ? "poll" : "ws";

let sidecarSocket: WebSocket | null = null;
let robotDrive: WebSocket | null = null;
let robotDriveConnecting: Promise<void> | null = null;
let robotCamera: WebSocket | null = null;
let robotCameraConnecting: Promise<void> | null = null;
let robotTelemetry: WebSocket | null = null;
const authorizedTokens = new Map<string, SpeedMode>();
let restDriveInFlight = false;
let latestRestDrive: { token: string; left: number; right: number } | null = null;
let latestWsDrive: DriveTarget | null = null;
let latestCamera: CameraTarget | null = null;

connectSidecar();
if (driveMode === "ws") startRobotDriveLoop();
startRobotCameraLoop();
if (telemetryMode !== "off") connectRobotTelemetry();

function connectSidecar() {
  const url = new URL("/ws/robot", sidecarWs);
  url.searchParams.set("robot", robot);
  sidecarSocket = new WebSocket(url);
  sidecarSocket.on("open", () => console.log(`harness bridge attached ${robot} -> ${sidecarHttp}`));
  sidecarSocket.on("message", (raw) => handleSidecarMessage(raw.toString()).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
  }));
  sidecarSocket.on("close", () => {
    holdZeroTarget();
    holdZeroCameraTarget();
    setTimeout(connectSidecar, 1000);
  });
  sidecarSocket.on("error", (err) => console.error(`sidecar robot socket: ${err.message}`));
}

function connectRobotTelemetry() {
  if (telemetryMode === "poll") {
    pollRobotTelemetry().catch((err) => {
      console.error(`harness telemetry poll: ${err instanceof Error ? err.message : err}`);
      setTimeout(connectRobotTelemetry, 1000);
    });
    return;
  }
  robotTelemetry = new WebSocket(`${robotWs}/ws/telemetry`);
  robotTelemetry.on("open", () => console.log(`harness telemetry connected ${robotHttp}`));
  robotTelemetry.on("message", (raw) => {
    if (!sidecarSocket || sidecarSocket.readyState !== WebSocket.OPEN) return;
    try {
      const frame = JSON.parse(raw.toString());
      sidecarSocket.send(JSON.stringify({
        ...frame,
        robot,
        camera: frame.camera ?? { status: "harness" },
        lidar: frame.lidar ?? frame.sensors?.lidar ?? { status: "unavailable" },
      }));
    } catch {
      // Drop malformed harness telemetry.
    }
  });
  robotTelemetry.on("close", () => setTimeout(connectRobotTelemetry, 1000));
  robotTelemetry.on("error", (err) => console.error(`harness telemetry: ${err.message}`));
}

async function pollRobotTelemetry() {
  console.log(`harness telemetry polling ${robotHttp}/telemetry`);
  while (true) {
    await sleep(Number(process.env.ROBOT_TELEMETRY_POLL_MS ?? 100));
    if (!sidecarSocket || sidecarSocket.readyState !== WebSocket.OPEN) continue;
    const res = await fetch(`${robotHttp}/telemetry`, {
      signal: AbortSignal.timeout(Number(process.env.ROBOT_TELEMETRY_TIMEOUT_MS ?? 5000)),
    });
    const frame = await res.json();
    if (!res.ok || frame.error) throw new Error(frame.error || `robot telemetry failed ${res.status}`);
    sidecarSocket.send(JSON.stringify(toSidecarTelemetry(frame)));
  }
}

async function handleSidecarMessage(raw: string) {
  const frame = JSON.parse(raw);
  if (frame.type === "camera-control") {
    await handleSidecarCamera(frame);
    return;
  }
  if (frame.type && frame.type !== "control") return;
  await handleSidecarControl(frame);
}

async function handleSidecarControl(frame: Record<string, unknown>) {
  const token = String(frame.token ?? "");
  if (!token) return;
  const speedMode = parseSpeedMode(frame.speed_mode);
  await ensureHarnessToken(token, speedMode);
  if (driveMode === "rest") {
    queueRestDrive(token, finite(frame.left), finite(frame.right));
    return;
  }
  latestWsDrive = {
    token,
    left: finite(frame.left),
    right: finite(frame.right),
    speedMode,
    updatedAt: Date.now(),
  };
}

async function handleSidecarCamera(frame: Record<string, unknown>) {
  const token = String(frame.token ?? "");
  if (!token) return;
  const speedMode = parseSpeedMode(frame.speed_mode);
  await ensureHarnessToken(token, speedMode);
  latestCamera = {
    token,
    pan: finite(frame.pan),
    tilt: finite(frame.tilt),
    speedMode,
    updatedAt: Date.now(),
  };
}

function queueRestDrive(token: string, left: number, right: number) {
  latestRestDrive = { token, left, right };
  void flushRestDrive();
}

async function flushRestDrive() {
  if (restDriveInFlight) return;
  while (latestRestDrive) {
    const command = latestRestDrive;
    latestRestDrive = null;
    restDriveInFlight = true;
    try {
      const res = await fetch(`${robotHttp}/drive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(Number(process.env.ROBOT_DRIVE_TIMEOUT_MS ?? 8000)),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) throw new Error(json.error || `robot drive failed ${res.status}`);
    } catch (err) {
      console.error(`rest drive: ${err instanceof Error ? err.message : err}`);
    } finally {
      restDriveInFlight = false;
    }
  }
}

async function ensureHarnessToken(token: string, speedMode: SpeedMode) {
  const currentMode = authorizedTokens.get(token);
  if (currentMode === speedMode) return;
  if (currentMode) {
    const res = await fetch(`${robotHttp}/pilot/speed-mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, speed_mode: speedMode }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(json.error || `harness speed-mode failed ${res.status}`);
    authorizedTokens.set(token, speedMode);
    return;
  }
  const res = await fetch(`${robotHttp}/pilot/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      ttl_secs: Number(process.env.HARNESS_TOKEN_TTL_SECS ?? 300),
      speed_mode: speedMode,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `harness authorize failed ${res.status}`);
  authorizedTokens.set(token, speedMode);
}

async function ensureRobotDrive() {
  if (robotDrive?.readyState === WebSocket.OPEN) return;
  if (robotDriveConnecting) return robotDriveConnecting;
  const socket = new WebSocket(`${robotWs}/ws/drive`);
  robotDrive = socket;
  robotDriveConnecting = new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", (err) => {
      if (robotDrive === socket) robotDrive = null;
      reject(err);
    });
  });
  try {
    await robotDriveConnecting;
  } finally {
    robotDriveConnecting = null;
  }
  socket.on("close", () => {
    if (robotDrive === socket) robotDrive = null;
  });
}

async function ensureRobotCamera() {
  if (robotCamera?.readyState === WebSocket.OPEN) return;
  if (robotCameraConnecting) return robotCameraConnecting;
  const socket = new WebSocket(`${robotWs}/ws/camera`);
  robotCamera = socket;
  robotCameraConnecting = new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", (err) => {
      if (robotCamera === socket) robotCamera = null;
      reject(err);
    });
  });
  try {
    await robotCameraConnecting;
  } finally {
    robotCameraConnecting = null;
  }
  socket.on("close", () => {
    if (robotCamera === socket) robotCamera = null;
  });
}

function startRobotDriveLoop() {
  setInterval(() => {
    void flushRobotDriveSocket();
  }, wsFlushMs);
}

function startRobotCameraLoop() {
  setInterval(() => {
    void flushRobotCameraSocket();
  }, wsFlushMs);
}

async function flushRobotDriveSocket() {
  const target = latestWsDrive;
  if (!target) return;
  const stale = Date.now() - target.updatedAt > wsTargetStaleMs;
  try {
    await ensureRobotDrive();
    if (!robotDrive || robotDrive.readyState !== WebSocket.OPEN) return;
    robotDrive.send(JSON.stringify({
      token: target.token,
      left: stale ? 0 : target.left,
      right: stale ? 0 : target.right,
      speed_mode: target.speedMode,
      t: Date.now(),
    }));
    if (stale && latestWsDrive === target) latestWsDrive = null;
  } catch (err) {
    console.error(`ws drive: ${err instanceof Error ? err.message : err}`);
  }
}

async function flushRobotCameraSocket() {
  const target = latestCamera;
  if (!target) return;
  const stale = Date.now() - target.updatedAt > wsTargetStaleMs;
  try {
    await ensureRobotCamera();
    if (!robotCamera || robotCamera.readyState !== WebSocket.OPEN) return;
    robotCamera.send(JSON.stringify({
      token: target.token,
      pan: stale ? 0 : target.pan,
      tilt: stale ? 0 : target.tilt,
      speed_mode: target.speedMode,
    }));
    if (stale && latestCamera === target) latestCamera = null;
  } catch (err) {
    console.error(`ws camera: ${err instanceof Error ? err.message : err}`);
  }
}

function holdZeroTarget() {
  if (!latestWsDrive) return;
  latestWsDrive = {
    ...latestWsDrive,
    left: 0,
    right: 0,
    updatedAt: Date.now(),
  };
}

function holdZeroCameraTarget() {
  if (!latestCamera) return;
  latestCamera = {
    ...latestCamera,
    pan: 0,
    tilt: 0,
    updatedAt: Date.now(),
  };
}

function normalizeHttpUrl(value: string) {
  return value.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/$/, "");
}

function wsFromHttp(value: string) {
  return value.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

function robotName(value: string): RobotName {
  if (value === "guard" || value === "courier") return value;
  throw new Error("ROBOT must be guard or courier");
}

function parseSpeedMode(value: unknown): SpeedMode {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

function toSidecarTelemetry(frame: Record<string, any>) {
  const odom = Array.isArray(frame.odom) ? frame.odom : [];
  const sensors = typeof frame.sensors === "object" && frame.sensors ? frame.sensors : undefined;
  const sensorOdometry = typeof sensors?.odometry === "object" ? sensors.odometry : undefined;
  const sensorBattery = typeof sensors?.battery === "object" ? sensors.battery : undefined;
  return {
    ...frame,
    type: "telemetry",
    source: frame.source === "sim" ? "sim" : "robot",
    ts_ms: finiteOr(frame.ts_ms, Date.now()),
    robot,
    battery_v: finiteOptional(frame.battery_v) ?? finiteOptional(sensorBattery?.voltage_v),
    left_cmd: finiteOr(frame.left_cmd, 0),
    right_cmd: finiteOr(frame.right_cmd, 0),
    odometry_left: finiteOptional(frame.odometry_left) ?? finiteOptional(sensorOdometry?.left) ?? finiteOptional(odom[0]),
    odometry_right: finiteOptional(frame.odometry_right) ?? finiteOptional(sensorOdometry?.right) ?? finiteOptional(odom[1]),
    deadman_ok: Boolean(frame.deadman_ok ?? true),
    stopped_by_deadman: Boolean(frame.stopped_by_deadman ?? false),
    estop: Boolean(frame.estop ?? false),
    speed_mode: frame.speed_mode === "low" || frame.speed_mode === "medium" || frame.speed_mode === "high"
      ? frame.speed_mode
      : "medium",
    max_speed: finiteOr(frame.max_speed, 0.35),
    raw_frame_age_ms: finiteOptional(frame.raw_frame_age_ms),
    camera: frame.camera ?? sensors?.camera ?? { status: "unavailable" },
    lidar: frame.lidar ?? sensors?.lidar ?? { status: "unavailable" },
    imu: frame.imu ?? {
      accel: Array.isArray(frame.accel) ? frame.accel : undefined,
      gyro: Array.isArray(frame.gyro) ? frame.gyro : undefined,
    },
    sensors,
    action: frame.action,
  };
}

function finite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function finiteOptional(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function finiteOr(value: unknown, fallback: number) {
  return finiteOptional(value) ?? fallback;
}

function positiveNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
