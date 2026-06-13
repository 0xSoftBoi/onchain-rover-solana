import { WebSocket } from "ws";

type RobotName = "guard" | "courier";
type SpeedMode = "low" | "medium" | "high";

type ControlFrame = {
  type?: string;
  left?: number;
  right?: number;
  speed_mode?: SpeedMode;
  max_speed?: number;
  token?: string;
};

const robot = parseRobotName(process.argv[2] ?? process.env.ROBOT_NAME ?? "courier");
const sidecarUrl = normalizeWsUrl(process.env.SIDECAR_URL ?? "ws://127.0.0.1:4021");

let ws: WebSocket | undefined;
let telemetryTimer: NodeJS.Timeout | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let left = 0;
let right = 0;
let speedMode: SpeedMode = "medium";
let maxSpeed = 0.35;
let battery = robot === "guard" ? 12.42 : 12.31;
let odometryLeft = 0;
let odometryRight = 0;
let yaw = 0;
let sessionId = "";
let lastCommandAt = 0;
let startedAt = Date.now();

connect();

process.on("SIGINT", () => {
  clearInterval(telemetryTimer);
  clearTimeout(reconnectTimer);
  ws?.close();
  process.exit(0);
});

function connect() {
  const url = new URL("/ws/robot", sidecarUrl);
  url.searchParams.set("robot", robot);
  ws = new WebSocket(url);

  ws.on("open", () => {
    console.log(`[sim-robot] ${robot} connected to ${url.toString()}`);
    startedAt = Date.now();
    telemetryTimer = setInterval(sendTelemetry, 100);
  });

  ws.on("message", (raw) => {
    try {
      const frame = JSON.parse(raw.toString()) as ControlFrame;
      if (frame.type && frame.type !== "control") return;
      left = clamp(Number(frame.left ?? left), -1, 1);
      right = clamp(Number(frame.right ?? right), -1, 1);
      speedMode = frame.speed_mode ?? speedMode;
      maxSpeed = Number.isFinite(Number(frame.max_speed)) ? Number(frame.max_speed) : maxSpeed;
      sessionId = frame.token ?? sessionId;
      lastCommandAt = Date.now();
    } catch {
      // Ignore malformed control frames in the simulator.
    }
  });

  ws.on("close", () => {
    console.log(`[sim-robot] ${robot} disconnected; retrying`);
    clearInterval(telemetryTimer);
    telemetryTimer = undefined;
    left = 0;
    right = 0;
    reconnectTimer = setTimeout(connect, 1000);
  });

  ws.on("error", (err) => {
    console.error(`[sim-robot] ${robot} websocket error: ${err.message}`);
  });
}

function sendTelemetry() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  const dt = 0.1;
  const staleMs = lastCommandAt ? now - lastCommandAt : Number.POSITIVE_INFINITY;
  const deadmanOk = staleMs < 700;
  const effectiveLeft = deadmanOk ? left : 0;
  const effectiveRight = deadmanOk ? right : 0;
  odometryLeft += effectiveLeft * dt * 24;
  odometryRight += effectiveRight * dt * 24;
  yaw += (effectiveRight - effectiveLeft) * dt * 32;
  battery = Math.max(10.8, battery - (Math.abs(effectiveLeft) + Math.abs(effectiveRight)) * 0.00035);

  const elapsed = (now - startedAt) / 1000;
  const front = Math.max(0.22, 1.4 + Math.sin(elapsed / 2.8) * 1.05);
  const min = Math.max(0.18, front - 0.11);

  ws.send(JSON.stringify({
    type: "telemetry",
    source: "sim",
    ts_ms: now,
    robot,
    battery_v: battery,
    left_cmd: effectiveLeft,
    right_cmd: effectiveRight,
    odometry_left: odometryLeft,
    odometry_right: odometryRight,
    yaw,
    session_id: sessionId,
    deadman_ok: deadmanOk,
    stopped_by_deadman: !deadmanOk && (Math.abs(left) > 0.001 || Math.abs(right) > 0.001),
    estop: false,
    speed_mode: speedMode,
    max_speed: maxSpeed,
    camera: { status: "simulated" },
    lidar: {
      front_m: front,
      min_m: min,
      blocked: min < 0.32,
    },
  }));
}

function parseRobotName(value: string): RobotName {
  if (value === "guard" || value === "courier") return value;
  throw new Error("robot must be guard or courier");
}

function normalizeWsUrl(value: string) {
  return value.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "");
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(min, Math.min(max, value));
}
