export type StageLaneName = "left" | "right";
export type StageDriverSlot = "challenger" | "opponent";

export type StageCalibrationLike = {
  laneLengthFt: number;
  laneWidthFt: number;
  startLineFt: number;
  finishLineFt: number;
  robotAssignments: Record<StageDriverSlot, { robot: string; lane: StageLaneName }>;
  sensorOffsets?: Record<string, {
    cameraForwardFt?: number;
    cameraRightFt?: number;
    lidarForwardFt?: number;
    lidarRightFt?: number;
  }>;
};

export type StageTelemetryFrameLike = {
  ts_ms?: number;
  robot?: string;
  left_cmd?: number;
  right_cmd?: number;
  odometry_left?: number;
  odometry_right?: number;
  yaw?: number;
  camera?: {
    status?: string;
    health?: string;
    last_frame_age_ms?: number;
  };
  lidar?: {
    status?: string;
    front_m?: number;
    min_m?: number;
    blocked?: boolean;
  };
  sensors?: {
    camera?: {
      status?: string;
      health?: string;
      last_frame_age_ms?: number;
    };
    lidar?: {
      status?: string;
      front_m?: number;
      min_m?: number;
      blocked?: boolean;
    };
    raw_frame?: { age_ms?: number };
  };
};

export type StageEstimateState = "ok" | "degraded" | "missing";

export type StageEstimate = {
  state: StageEstimateState;
  confidence: number;
  lane: StageLaneName | null;
  robot: string | null;
  progress: number | null;
  progressFt: number | null;
  lateralFt: number | null;
  lanePositionPct: number | null;
  headingDeg: number | null;
  runFt: number;
  laneWidthFt: number;
  sources: string[];
  reasons: string[];
};

const METERS_TO_FEET = 3.28084;

export function estimateStagePosition(opts: {
  calibration: StageCalibrationLike;
  slot: StageDriverSlot;
  robot?: string | null;
  frame?: StageTelemetryFrameLike;
}): StageEstimate {
  const { calibration, slot, frame } = opts;
  const assignment = calibration.robotAssignments[slot];
  const robot = opts.robot ?? frame?.robot ?? assignment?.robot ?? null;
  const lane = assignment?.lane ?? null;
  const runFt = Math.max(1, calibration.finishLineFt - calibration.startLineFt);
  const reasons: string[] = [];
  const sources: string[] = [];
  let confidence = 0;

  const odometry = odometryMeters(frame);
  const odometryFt = odometry === null ? null : odometry * METERS_TO_FEET;
  const progressFt = odometryFt === null
    ? null
    : clamp(odometryFt - calibration.startLineFt, 0, runFt);
  const progress = progressFt === null ? null : progressFt / runFt;

  if (progress !== null) {
    confidence += 0.42;
    sources.push("odometry");
  } else {
    reasons.push("odometry missing");
  }

  const laneIndex = lane === "left" ? 0 : lane === "right" ? 1 : null;
  if (laneIndex !== null) {
    confidence += 0.22;
    sources.push("stage-calibration");
  } else {
    reasons.push("lane assignment missing");
  }

  const offsets = robot ? calibration.sensorOffsets?.[robot] : undefined;
  const lateralFt = laneIndex === null
    ? null
    : (laneIndex === 0 ? -0.5 : 0.5) * calibration.laneWidthFt;
  const lanePositionPct = laneIndex === null ? null : laneIndex === 0 ? 25 : 75;

  const headingDeg = headingFromFrame(frame);
  if (headingDeg !== null) {
    confidence += 0.16;
    sources.push("imu-yaw");
  } else if (frame?.left_cmd !== undefined || frame?.right_cmd !== undefined) {
    confidence += 0.05;
    sources.push("wheel-command");
    reasons.push("yaw missing");
  } else {
    reasons.push("heading missing");
  }

  const camera = frame?.camera ?? frame?.sensors?.camera;
  const cameraHealth = deriveCameraHealth(camera, frame?.sensors?.raw_frame?.age_ms);
  if (cameraHealth === "healthy") {
    confidence += 0.1;
    sources.push(offsets ? "camera-offset" : "camera");
  } else if (cameraHealth === "stale") {
    confidence += 0.03;
    sources.push("camera-stale");
    reasons.push("camera stale");
  } else if (cameraHealth === "degraded") {
    confidence += 0.05;
    sources.push("camera-degraded");
    reasons.push("camera degraded");
  } else {
    reasons.push("camera missing");
  }

  const lidar = frame?.lidar ?? frame?.sensors?.lidar;
  const lidarStatus = deriveLidarStatus(lidar);
  if (lidarStatus === "available") {
    confidence += 0.1;
    sources.push(offsets ? "lidar-offset" : "lidar");
  } else if (lidarStatus === "blocked") {
    confidence += 0.06;
    sources.push("lidar-blocked");
  } else if (lidarStatus === "stale") {
    confidence += 0.03;
    sources.push("lidar-stale");
    reasons.push("lidar stale");
  } else {
    reasons.push("lidar missing");
  }

  confidence = Number(clamp(confidence, 0, 1).toFixed(2));
  const hasPosition = progress !== null && laneIndex !== null;
  const state: StageEstimateState = hasPosition
    ? confidence >= 0.72 ? "ok" : "degraded"
    : "missing";

  return {
    state,
    confidence,
    lane,
    robot,
    progress: progress === null ? null : Number(progress.toFixed(4)),
    progressFt: progressFt === null ? null : Number(progressFt.toFixed(2)),
    lateralFt: lateralFt === null ? null : Number(lateralFt.toFixed(2)),
    lanePositionPct,
    headingDeg,
    runFt,
    laneWidthFt: calibration.laneWidthFt,
    sources: [...new Set(sources)],
    reasons: [...new Set(reasons)].slice(0, 5),
  };
}

function odometryMeters(frame: StageTelemetryFrameLike | undefined): number | null {
  if (!frame) return null;
  const left = numberField(frame.odometry_left);
  const right = numberField(frame.odometry_right);
  if (left === null && right === null) return null;
  if (left === null) return right;
  if (right === null) return left;
  return (left + right) / 2;
}

function headingFromFrame(frame: StageTelemetryFrameLike | undefined): number | null {
  const yaw = numberField(frame?.yaw);
  if (yaw === null) return null;
  return Number(normalizeDegrees(yaw).toFixed(1));
}

function deriveCameraHealth(
  camera: StageTelemetryFrameLike["camera"] | undefined,
  rawFrameAgeMs?: number,
): "healthy" | "stale" | "degraded" | "missing" | "" {
  const health = camera?.health;
  if (health === "healthy" || health === "stale" || health === "degraded" || health === "missing") return health;
  const age = numberField(camera?.last_frame_age_ms ?? rawFrameAgeMs);
  if (age !== null && age > 1500) return "stale";
  const status = camera?.status;
  if (status === "simulated" || status === "proxy" || status === "e2e" || status === "harness") return "healthy";
  if (status === "configured") return "degraded";
  if (status === "unavailable" || status === "missing" || status === "error") return "missing";
  return "";
}

function deriveLidarStatus(
  lidar: StageTelemetryFrameLike["lidar"] | undefined,
): "available" | "blocked" | "stale" | "missing" | "" {
  if (!lidar) return "";
  if (lidar.blocked) return "blocked";
  const status = lidar.status;
  if (status === "stale") return "stale";
  if (status === "unavailable" || status === "missing" || status === "error") return "missing";
  if (numberField(lidar.front_m) !== null || numberField(lidar.min_m) !== null || status === "available") return "available";
  return "";
}

function numberField(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeDegrees(value: number): number {
  let degrees = value % 360;
  if (degrees > 180) degrees -= 360;
  if (degrees < -180) degrees += 360;
  return degrees;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
