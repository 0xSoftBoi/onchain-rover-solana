import * as chain from "./chain.js";
import * as rounds from "./rounds.js";

type FeeLedgerStatus = "paid" | "pending" | "failed";
type ReconciliationStatus = "pending" | "reconciled" | "needs-proof" | "failed";
type PaymentProof = {
  kind: "transaction" | "payment-id";
  value: string;
};
type TreasuryAddresses = {
  local?: string;
  x402?: string;
  primary?: string;
};

export type TreasuryFeeLedgerEntry = {
  roundId: string;
  roundStatus: rounds.RoundStatus;
  chainRaceId?: string;
  chainStatus?: rounds.ChainRoundStatus;
  slot: rounds.DriverSlot;
  driverAddress: string;
  displayName?: string;
  recipientTreasury?: string;
  source: rounds.FeePayment["source"];
  status: FeeLedgerStatus;
  reconciliationStatus: ReconciliationStatus;
  amountUsdc: string;
  amountUnits: string;
  stakeUsdc: string;
  paymentProof?: PaymentProof;
  paidAt?: number;
  createdAt: number;
  settledAt?: number;
};

export type TreasuryFeeLedgerRound = {
  roundId: string;
  status: rounds.RoundStatus;
  chainRaceId?: string;
  chainStatus?: rounds.ChainRoundStatus;
  stakeUsdc: string;
  feeUsdc: string;
  recipientTreasury?: string;
  createdAt: number;
  settledAt?: number;
  expectedFees: string;
  expectedFeesUnits: string;
  paidFees: string;
  paidFeesUnits: string;
  pendingFees: string;
  pendingFeesUnits: string;
  entries: TreasuryFeeLedgerEntry[];
};

export type TreasuryFeeLedger = {
  generatedAt: number;
  currency: "USDC";
  recipientTreasury?: string;
  recipientTreasuries: string[];
  totals: {
    roundCount: number;
    entryCount: number;
    paidCount: number;
    pendingCount: number;
    failedCount: number;
    expectedFees: string;
    expectedFeesUnits: string;
    paidFees: string;
    paidFeesUnits: string;
    pendingFees: string;
    pendingFeesUnits: string;
  };
  entries: TreasuryFeeLedgerEntry[];
  rounds: TreasuryFeeLedgerRound[];
};

const USDC_SCALE = 1_000_000n;

export function buildTreasuryFeeLedger(): TreasuryFeeLedger {
  const treasuries = treasuryAddresses();
  const entries = rounds.listRounds()
    .flatMap((round) => buildRoundEntries(round, treasuries))
    .sort((a, b) => b.createdAt - a.createdAt || a.slot.localeCompare(b.slot));
  const recipientTreasuries = uniqueStrings(entries
    .map((entry) => entry.recipientTreasury)
    .filter((value): value is string => Boolean(value)));
  const recipientTreasury = recipientTreasuries[0] ?? treasuries.primary;

  const roundsById = new Map<string, TreasuryFeeLedgerRound>();
  for (const entry of entries) {
    const round = roundsById.get(entry.roundId) ?? createRoundSummary(entry);
    round.entries.push(entry);
    roundsById.set(entry.roundId, round);
  }

  for (const round of roundsById.values()) {
    const expectedUnits = sumUnits(round.entries.map((entry) => BigInt(entry.amountUnits)));
    const paidUnits = sumUnits(round.entries
      .filter((entry) => entry.status === "paid")
      .map((entry) => BigInt(entry.amountUnits)));
    const pendingUnits = expectedUnits - paidUnits;
    round.expectedFeesUnits = expectedUnits.toString();
    round.expectedFees = formatUsdcUnits(expectedUnits);
    round.paidFeesUnits = paidUnits.toString();
    round.paidFees = formatUsdcUnits(paidUnits);
    round.pendingFeesUnits = pendingUnits.toString();
    round.pendingFees = formatUsdcUnits(pendingUnits);
  }

  const expectedUnits = sumUnits(entries.map((entry) => BigInt(entry.amountUnits)));
  const paidUnits = sumUnits(entries
    .filter((entry) => entry.status === "paid")
    .map((entry) => BigInt(entry.amountUnits)));
  const pendingUnits = expectedUnits - paidUnits;

  return {
    generatedAt: Date.now(),
    currency: "USDC",
    recipientTreasury,
    recipientTreasuries,
    totals: {
      roundCount: roundsById.size,
      entryCount: entries.length,
      paidCount: entries.filter((entry) => entry.status === "paid").length,
      pendingCount: entries.filter((entry) => entry.status === "pending").length,
      failedCount: entries.filter((entry) => entry.status === "failed").length,
      expectedFees: formatUsdcUnits(expectedUnits),
      expectedFeesUnits: expectedUnits.toString(),
      paidFees: formatUsdcUnits(paidUnits),
      paidFeesUnits: paidUnits.toString(),
      pendingFees: formatUsdcUnits(pendingUnits),
      pendingFeesUnits: pendingUnits.toString(),
    },
    entries,
    rounds: [...roundsById.values()].sort((a, b) => b.createdAt - a.createdAt),
  };
}

function buildRoundEntries(
  round: rounds.Round,
  treasuries: TreasuryAddresses,
): TreasuryFeeLedgerEntry[] {
  const entries: TreasuryFeeLedgerEntry[] = [];
  for (const slot of ["challenger", "opponent"] as const) {
    const driver = round.drivers[slot];
    if (!driver) continue;
    const feePayment = driver.feePayment;
    const status = feeStatus(driver);
    const amountUsdc = feePayment?.amountUsdc ?? round.feeUsdc;
    const txHash = feePayment?.txHash ?? driver.joinedTx;
    const paymentId = feePayment?.paymentId;
    const source = feePayment?.source ?? (driver.chainJoined ? "local-chain" : "manual");
    entries.push({
      roundId: round.id,
      roundStatus: round.status,
      chainRaceId: round.chainRaceId,
      chainStatus: round.chainStatus,
      slot,
      driverAddress: driver.wallet,
      displayName: driver.displayName,
      recipientTreasury: feePayment?.recipientTreasury ?? treasuryForSource(source, treasuries),
      source,
      status,
      reconciliationStatus: reconciliationStatus(status, txHash, paymentId, feePayment),
      amountUsdc,
      amountUnits: feePayment?.amountUnits ?? parseUsdcUnits(amountUsdc).toString(),
      stakeUsdc: round.stakeUsdc,
      paymentProof: paymentProof(txHash, paymentId),
      paidAt: feePayment?.paidAt,
      createdAt: round.createdAt,
      settledAt: round.settledAt,
    });
  }
  return entries;
}

function createRoundSummary(entry: TreasuryFeeLedgerEntry): TreasuryFeeLedgerRound {
  return {
    roundId: entry.roundId,
    status: entry.roundStatus,
    chainRaceId: entry.chainRaceId,
    chainStatus: entry.chainStatus,
    stakeUsdc: entry.stakeUsdc,
    feeUsdc: entry.amountUsdc,
    recipientTreasury: entry.recipientTreasury,
    createdAt: entry.createdAt,
    settledAt: entry.settledAt,
    expectedFees: "0",
    expectedFeesUnits: "0",
    paidFees: "0",
    paidFeesUnits: "0",
    pendingFees: "0",
    pendingFeesUnits: "0",
    entries: [],
  };
}

function feeStatus(driver: rounds.Driver): FeeLedgerStatus {
  if (driver.feePayment?.status) return driver.feePayment.status;
  if (driver.feePaid || driver.chainJoined) return "paid";
  return "pending";
}

function reconciliationStatus(
  status: FeeLedgerStatus,
  txHash?: string,
  paymentId?: string,
  feePayment?: rounds.FeePayment,
): ReconciliationStatus {
  if (feePayment?.reconciliationStatus) return feePayment.reconciliationStatus;
  if (status === "failed") return "failed";
  if (status === "pending") return "pending";
  return txHash || paymentId ? "reconciled" : "needs-proof";
}

function paymentProof(txHash?: string, paymentId?: string): PaymentProof | undefined {
  if (txHash) return { kind: "transaction", value: txHash };
  if (paymentId) return { kind: "payment-id", value: paymentId };
  return undefined;
}

function treasuryAddresses(): TreasuryAddresses {
  const x402 = process.env.TREASURY_ADDRESS || undefined;
  let local = process.env.LOCAL_TREASURY_ADDRESS || undefined;
  try {
    local = chain.publicLocalChainConfig().treasury;
  } catch {
    // Keep the env fallback above when local deployment metadata is absent.
  }
  return { local, x402, primary: x402 ?? local };
}

function treasuryForSource(
  source: rounds.FeePayment["source"],
  treasuries: TreasuryAddresses,
): string | undefined {
  if (source === "local-chain") return treasuries.local ?? treasuries.primary;
  if (source === "x402") return treasuries.x402 ?? treasuries.primary;
  return treasuries.primary;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function sumUnits(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function parseUsdcUnits(value: string): bigint {
  const input = String(value ?? "0").trim();
  if (!/^\d+(\.\d{1,6})?$/.test(input)) return 0n;
  const [whole, fraction = ""] = input.split(".");
  return BigInt(whole) * USDC_SCALE + BigInt(fraction.padEnd(6, "0"));
}

function formatUsdcUnits(units: bigint): string {
  const sign = units < 0n ? "-" : "";
  const abs = units < 0n ? -units : units;
  const whole = abs / USDC_SCALE;
  const fraction = (abs % USDC_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}
