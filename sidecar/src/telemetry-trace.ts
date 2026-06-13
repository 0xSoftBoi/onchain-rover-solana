import type { RobotName } from "./config.js";
import type { DriverSlot, Round } from "./rounds.js";
import * as raceStore from "./race-store.js";
import { estimateStagePosition } from "./stage-estimator.js";

type TraceFrame = raceStore.TelemetryTraceEvent & { type: "frame"; frame: Record<string, unknown> };
type TraceEventDetail = Record<string, unknown>;

export function traceIdForRound(round: Pick<Round, "id" | "telemetryTraceId">): string {
  return round.telemetryTraceId ?? `trace-${round.id}`;
}

export function appendRoundTraceEvent(
  round: Round,
  event: string,
  detail: TraceEventDetail = {},
  opts: { atMs?: number } = {},
) {
  for (const slot of ["challenger", "opponent"] as const) {
    appendDriverTraceEvent(round, slot, event, detail, opts);
  }
}

export function appendDriverTraceEvent(
  round: Round,
  slot: DriverSlot,
  event: string,
  detail: TraceEventDetail = {},
  opts: { atMs?: number } = {},
) {
  const robot = round.drivers[slot]?.robot;
  if (!robot) return;
  raceStore.appendTelemetryTrace({
    schema: "onchain-rover.telemetry-trace-event.v1",
    traceId: traceIdForRound(round),
    roundId: round.id,
    atMs: opts.atMs ?? Date.now(),
    type: "event",
    slot,
    robot: robot as RobotName,
    event,
    detail,
  });
}

export function buildTelemetryTraceSummary(round: Round, includeFrames = false) {
  const events = raceStore.loadTelemetryTrace(round.id);
  const frames = events.filter(isFrame);
  const notableEvents = buildNotableEvents(round, events, frames);
  const drivers = Object.fromEntries((["challenger", "opponent"] as const).map((slot) => {
    const robot = round.drivers[slot]?.robot ?? null;
    const driverFrames = robot
      ? frames.filter((event) => event.slot === slot && event.robot === robot)
      : [];
    return [slot, summarizeDriverFrames(slot, robot, driverFrames, round)];
  }));

  return {
    schema: "onchain-rover.telemetry-trace-summary.v1",
    roundId: round.id,
    traceId: traceIdForRound(round),
    frameCount: frames.length,
    eventCount: events.length - frames.length,
    startedAt: round.startedAt ?? null,
    finishedAt: round.finishedAt ?? null,
    drivers,
    notableEvents,
    eventSequence: notableEvents,
    frames: includeFrames ? frames.map(compactTraceFrame) : undefined,
  };
}

function summarizeDriverFrames(
  slot: DriverSlot,
  robot: string | null,
  frames: TraceFrame[],
  round: Round,
) {
  const first = frames.at(0);
  const last = frames.at(-1);
  const startWindow = framesInWindow(frames, round.startedAt, 3000, 3000);
  const finishWindow = framesInWindow(frames, round.finishedAt, 5000, 2000);
  return {
    slot,
    robot,
    frameCount: frames.length,
    firstAt: first?.atMs ?? null,
    lastAt: last?.atMs ?? null,
    speedModes: [...new Set(frames.map((event) => String(event.frame.speed_mode ?? "")).filter(Boolean))],
    battery: numberRange(frames, "battery_v"),
    camera: cameraSummary(frames),
    stage: stageSummary(slot, robot, frames, round),
    wheelCommand: {
      lastLeft: numberField(last?.frame.left_cmd),
      lastRight: numberField(last?.frame.right_cmd),
    },
    odometry: {
      first: averageOdom(first?.frame),
      last: averageOdom(last?.frame),
      startWindow: windowSummary(startWindow),
      finishWindow: windowSummary(finishWindow),
    },
    safety: {
      deadmanDropCount: frames.filter((event) => event.frame.deadman_ok === false).length,
      stoppedByDeadmanCount: frames.filter((event) => event.frame.stopped_by_deadman === true).length,
      estopCount: frames.filter((event) => event.frame.estop === true).length,
    },
  };
}

function stageSummary(slot: DriverSlot, robot: string | null, frames: TraceFrame[], round: Round) {
  const estimates = frames.map((event) => estimateStagePosition({
    calibration: round.stageCalibration,
    slot,
    robot,
    frame: event.frame,
  }));
  const last = estimates.at(-1);
  return {
    lane: last?.lane ?? round.stageCalibration.robotAssignments[slot]?.lane ?? null,
    state: last?.state ?? "missing",
    confidence: last?.confidence ?? 0,
    progress: last?.progress ?? null,
    progressFt: last?.progressFt ?? null,
    lateralFt: last?.lateralFt ?? null,
    headingDeg: last?.headingDeg ?? null,
    sources: last?.sources ?? [],
    reasons: last?.reasons ?? ["telemetry missing"],
    configured: {
      laneLengthFt: round.stageCalibration.laneLengthFt,
      laneWidthFt: round.stageCalibration.laneWidthFt,
      startLineFt: round.stageCalibration.startLineFt,
      finishLineFt: round.stageCalibration.finishLineFt,
    },
    okCount: estimates.filter((estimate) => estimate.state === "ok").length,
    degradedCount: estimates.filter((estimate) => estimate.state === "degraded").length,
    missingCount: estimates.filter((estimate) => estimate.state === "missing").length,
  };
}

function cameraSummary(frames: TraceFrame[]) {
  const cameraFrames = frames
    .map((event) => event.frame.camera)
    .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"));
  const last = cameraFrames.at(-1);
  return {
    status: stringField(last?.status) ?? null,
    health: stringField(last?.health) ?? null,
    fps: numberField(last?.fps),
    lastFrameAgeMs: numberField(last?.last_frame_age_ms),
    resolution: stringField(last?.resolution) ?? null,
    brightness: numberField(last?.brightness),
    reconnectState: stringField(last?.reconnect_state) ?? null,
    healthyCount: cameraFrames.filter((camera) => cameraHealth(camera) === "healthy").length,
    staleCount: cameraFrames.filter((camera) => cameraHealth(camera) === "stale").length,
    missingCount: cameraFrames.filter((camera) => cameraHealth(camera) === "missing").length,
    degradedCount: cameraFrames.filter((camera) => cameraHealth(camera) === "degraded").length,
  };
}

function cameraHealth(camera: Record<string, unknown>) {
  const health = stringField(camera.health);
  if (health) return health;
  const status = stringField(camera.status);
  const age = numberField(camera.last_frame_age_ms);
  if (age !== null && age > 1500) return "stale";
  if (status === "simulated" || status === "proxy") return "healthy";
  if (status === "configured") return "degraded";
  if (status === "unavailable" || status === "missing" || status === "error") return "missing";
  return "";
}

function buildNotableEvents(
  round: Round,
  events: raceStore.TelemetryTraceEvent[],
  frames: TraceFrame[],
) {
  const notable: Array<Record<string, unknown>> = [];
  const persistedEventTypes = new Set(
    events
      .filter((event) => event.type === "event")
      .map((event) => event.event)
      .filter(Boolean),
  );
  if (round.countdownStartedAt && !persistedEventTypes.has("countdown-start")) {
    notable.push({
      type: "countdown-start",
      atMs: round.countdownStartedAt,
      detail: { countdownSecs: round.countdownSecs, roundStartsAt: round.roundStartsAt ?? null },
    });
  }
  if (round.startedAt) notable.push({ type: "round-start", atMs: round.startedAt });
  if (round.startedAt && !persistedEventTypes.has("go")) notable.push({ type: "go", atMs: round.startedAt });
  if (round.finishedAt) notable.push({ type: "round-finish", atMs: round.finishedAt, winner: round.winner });
  if (round.finishedAt && !persistedEventTypes.has("race-finish")) {
    notable.push({ type: "race-finish", atMs: round.finishedAt, winner: round.winner });
  }
  for (const event of events) {
    if (event.type === "event") {
      notable.push({
        type: event.event,
        atMs: event.atMs,
        slot: event.slot,
        robot: event.robot,
        detail: event.detail,
      });
    }
  }
  for (const event of frames) {
    if (!persistedEventTypes.has("emergency-stop") && event.frame.estop === true) {
      notable.push(safetyEvent("emergency-stop", event));
    }
    if (!persistedEventTypes.has("deadman-stop") && event.frame.stopped_by_deadman === true) {
      notable.push(safetyEvent("deadman-stop", event));
    }
    if (event.frame.deadman_ok === false) notable.push(safetyEvent("deadman-open", event));
  }
  return notable
    .sort((a, b) => Number(a.atMs ?? 0) - Number(b.atMs ?? 0))
    .slice(0, 200);
}

function safetyEvent(type: string, event: TraceFrame) {
  return {
    type,
    atMs: event.atMs,
    slot: event.slot,
    robot: event.robot,
    speedMode: event.frame.speed_mode,
    left: event.frame.left_cmd,
    right: event.frame.right_cmd,
  };
}

function framesInWindow(frames: TraceFrame[], center: number | undefined, beforeMs: number, afterMs: number) {
  if (!center) return [];
  return frames.filter((event) => event.atMs >= center - beforeMs && event.atMs <= center + afterMs);
}

function windowSummary(frames: TraceFrame[]) {
  return {
    frameCount: frames.length,
    firstAt: frames.at(0)?.atMs ?? null,
    lastAt: frames.at(-1)?.atMs ?? null,
    firstOdom: averageOdom(frames.at(0)?.frame),
    lastOdom: averageOdom(frames.at(-1)?.frame),
  };
}

function numberRange(frames: TraceFrame[], field: string) {
  const values = frames
    .map((event) => numberField(event.frame[field]))
    .filter((value): value is number => value !== null);
  return {
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    last: values.at(-1) ?? null,
  };
}

function averageOdom(frame: Record<string, unknown> | undefined) {
  if (!frame) return null;
  const left = numberField(frame.odometry_left);
  const right = numberField(frame.odometry_right);
  if (left === null && right === null) return null;
  if (left === null) return right;
  if (right === null) return left;
  return Number(((left + right) / 2).toFixed(4));
}

function numberField(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function compactTraceFrame(event: TraceFrame) {
  return {
    atMs: event.atMs,
    slot: event.slot,
    robot: event.robot,
    frame: event.frame,
  };
}

function isFrame(event: raceStore.TelemetryTraceEvent): event is TraceFrame {
  return event.type === "frame" && Boolean(event.frame);
}
