import { createHash } from "node:crypto";

import type { RobotName } from "./config.js";
import * as robotLink from "./robot-link.js";
import type { DriverSlot, Round } from "./rounds.js";

type Hex32 = `0x${string}`;
type EvidenceEventName = "locked" | "started" | "finished" | "settled";

type EvidenceEvent = {
  event: EvidenceEventName;
  atMs: number;
  round: ReturnType<typeof sanitizeRound>;
};

type EvidenceRecord = {
  roundId: string;
  createdAtMs: number;
  updatedAtMs: number;
  events: EvidenceEvent[];
  operatorProof?: Record<string, unknown>;
  resultProof?: Record<string, unknown>;
  resultProofCanonical?: string;
  proofHash?: Hex32;
  packetHash?: Hex32;
};

const records = new Map<string, EvidenceRecord>();

export function recordRoundSnapshot(round: Round, event: EvidenceEventName): EvidenceRecord {
  const record = ensureRecord(round.id);
  record.updatedAtMs = Date.now();
  record.events.push({
    event,
    atMs: eventTime(round, event) ?? record.updatedAtMs,
    round: sanitizeRound(round),
  });
  record.packetHash = hashEvidencePacket(record);
  return structuredClone(record);
}

export function finalizeResultProof(round: Round, operatorProof?: Record<string, unknown>) {
  const record = ensureRecord(round.id);
  if (operatorProof) record.operatorProof = sortedClone(operatorProof) as Record<string, unknown>;
  if (!record.events.some((event) => event.event === "finished")) {
    recordRoundSnapshot(round, "finished");
  }
  if (!record.resultProof || !record.proofHash) {
    record.updatedAtMs = Date.now();
    record.resultProof = buildResultProof(record, round);
    record.resultProofCanonical = canonicalJson(record.resultProof);
    record.proofHash = sha256Hex(record.resultProofCanonical);
  }
  record.packetHash = hashEvidencePacket(record);
  return {
    proofHash: record.proofHash,
    evidenceHash: record.packetHash,
    evidence: evidenceResponse(record),
  };
}

export function getEvidence(round: Round) {
  const record = ensureRecord(round.id);
  if (!record.packetHash) record.packetHash = hashEvidencePacket(record);
  return evidenceResponse(record);
}

export function getEvidenceHash(round: Round) {
  const record = ensureRecord(round.id);
  if (!record.packetHash) record.packetHash = hashEvidencePacket(record);
  return {
    roundId: round.id,
    proofHash: record.proofHash ?? round.proofHash ?? null,
    evidenceHash: record.packetHash ?? round.evidenceHash ?? null,
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedClone(value));
}

function ensureRecord(roundId: string): EvidenceRecord {
  let record = records.get(roundId);
  if (!record) {
    const now = Date.now();
    record = {
      roundId,
      createdAtMs: now,
      updatedAtMs: now,
      events: [],
    };
    records.set(roundId, record);
  }
  return record;
}

function buildResultProof(record: EvidenceRecord, round: Round) {
  const slots: DriverSlot[] = ["challenger", "opponent"];
  const telemetry = Object.fromEntries(slots.map((slot) => {
    const driver = round.drivers[slot];
    const robot = driver?.robot;
    return [slot, robot ? telemetryForRobot(robot, round) : { robot: null, start: [], finish: [], latest: null }];
  }));

  return {
    schema: "onchain-rover.race-result-proof.v1",
    roundId: round.id,
    createdAtMs: record.updatedAtMs,
    chainRaceId: round.chainRaceId ?? null,
    result: {
      winner: round.winner ?? null,
      finishMs: round.finishMs ?? null,
      startedAt: round.startedAt ?? null,
      finishedAt: round.finishedAt ?? null,
    },
    lifecycle: record.events
      .filter((event) => event.event !== "settled")
      .map((event) => sortedClone(event)),
    telemetry,
    operatorProof: record.operatorProof ?? null,
  };
}

function telemetryForRobot(robot: RobotName, round: Round) {
  const startAt = round.startedAt ?? round.roundStartsAt ?? Date.now();
  const finishAt = round.finishedAt ?? Date.now();
  return {
    robot,
    start: robotLink.telemetryWindow(robot, startAt - 3000, startAt + 3000),
    finish: robotLink.telemetryWindow(robot, finishAt - 5000, finishAt + 2000),
    latest: robotLink.latestTelemetry(robot),
  };
}

function evidenceResponse(record: EvidenceRecord) {
  const evidence = {
    schema: "onchain-rover.race-evidence-packet.v1",
    roundId: record.roundId,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    proofHash: record.proofHash ?? null,
    evidenceHash: record.packetHash ?? null,
    resultProof: record.resultProof ?? null,
    lifecycle: record.events,
  };
  return {
    proofHash: record.proofHash ?? null,
    evidenceHash: record.packetHash ?? null,
    canonical: canonicalJson(packetForHash(record)),
    evidence,
  };
}

function hashEvidencePacket(record: EvidenceRecord): Hex32 {
  return sha256Hex(canonicalJson(packetForHash(record)));
}

function packetForHash(record: EvidenceRecord) {
  return {
    schema: "onchain-rover.race-evidence-packet.v1",
    roundId: record.roundId,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    proofHash: record.proofHash ?? null,
    resultProof: record.resultProof ?? null,
    lifecycle: record.events,
  };
}

function sha256Hex(value: string): Hex32 {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function sanitizeRound(round: Round) {
  return {
    id: round.id,
    status: round.status,
    chainStatus: round.chainStatus ?? null,
    chainRaceId: round.chainRaceId ?? null,
    stakeUsdc: round.stakeUsdc,
    feeUsdc: round.feeUsdc,
    durationSecs: round.durationSecs,
    countdownSecs: round.countdownSecs,
    createdAt: round.createdAt,
    lockedAt: round.lockedAt ?? null,
    roundStartsAt: round.roundStartsAt ?? null,
    startedAt: round.startedAt ?? null,
    finishedAt: round.finishedAt ?? null,
    finishMs: round.finishMs ?? null,
    winner: round.winner ?? null,
    proofHash: round.proofHash ?? null,
    evidenceHash: round.evidenceHash ?? null,
    txHashes: round.txHashes ?? {},
    drivers: {
      challenger: sanitizeDriver(round, "challenger"),
      opponent: sanitizeDriver(round, "opponent"),
    },
  };
}

function sanitizeDriver(round: Round, slot: DriverSlot) {
  const driver = round.drivers[slot];
  if (!driver) return null;
  return {
    slot,
    wallet: driver.wallet,
    displayName: driver.displayName ?? null,
    robot: driver.robot ?? null,
    lane: driver.lane ?? null,
    feePaid: driver.feePaid,
    stakeAuthorized: driver.stakeAuthorized,
    chainJoined: Boolean(driver.chainJoined),
    joinedTx: driver.joinedTx ?? null,
  };
}

function eventTime(round: Round, event: EvidenceEventName): number | undefined {
  if (event === "locked") return round.lockedAt;
  if (event === "started") return round.startedAt;
  if (event === "finished") return round.finishedAt;
  if (event === "settled") return Date.now();
  return undefined;
}

function sortedClone(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortedClone);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) out[key] = sortedClone(item);
  }
  return out;
}
