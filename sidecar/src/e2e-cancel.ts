import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

type DriverSlot = "challenger" | "opponent";
type PreparedStake = {
  permission: Record<string, string>;
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  };
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

async function main() {
  const abandoned = await postJson("/race/round/challenge", {
    wallet: accounts.challenger.address,
    displayName: "challenger",
    stakeUsdc: "1.00",
    feeUsdc: "0.25",
  });
  const abandonedCanceled = await postJson(`/race/round/${abandoned.id}/cancel`, {
    code: "missing_second_driver",
    reason: "opponent never joined",
  });
  assert(abandonedCanceled.status === "canceled", "abandoned round did not cancel");
  assert(abandonedCanceled.cancellation.code === "missing_second_driver", "wrong abandoned cancel code");
  assert(abandonedCanceled.cancellation.drivers.challenger.feeStatus === "unpaid", "abandoned fee should be unpaid");

  let round = await postJson("/race/round/challenge", {
    wallet: accounts.challenger.address,
    displayName: "challenger",
    stakeUsdc: "1.00",
    feeUsdc: "0.25",
  });
  round = await postJson(`/race/round/${round.id}/accept`, {
    wallet: accounts.opponent.address,
    displayName: "opponent",
  });
  await postJson(`/race/round/${round.id}/fee-paid`, {
    slot: "challenger",
    payment: { source: "manual", amountUsdc: "0.25" },
  });
  await postJson(`/race/round/${round.id}/fee-paid`, {
    slot: "opponent",
    payment: { source: "manual", amountUsdc: "0.25" },
  });
  round = await verifyStake(round.id, "challenger", accounts.challenger);
  round = await verifyStake(round.id, "opponent", accounts.opponent);
  assert(round.status === "ready", `expected ready before cancel, got ${round.status}`);

  const canceled = await postJson(`/race/round/${round.id}/cancel`, {
    code: "operator_cancel",
    reason: "operator canceled before countdown",
  });
  assert(canceled.status === "canceled", "ready round did not cancel");
  assert(canceled.cancellation.code === "operator_cancel", "wrong ready cancel code");
  assert(canceled.cancellation.drivers.challenger.feeStatus === "paid", "paid fee not visible");
  assert(canceled.cancellation.drivers.opponent.stakeStatus === "active", "stake status should stay active");
  assert(String(canceled.cancellation.stakePolicy).includes("do not settle"), "stake policy missing");

  await assertRejected(`/race/round/${round.id}/stake/settlement-plan`, "canceled rounds cannot settle stake");

  console.log("Cancel semantics e2e passed");
  console.log(`  abandoned: ${abandonedCanceled.id} ${abandonedCanceled.cancellation.code}`);
  console.log(`  canceled:  ${canceled.id} ${canceled.cancellation.code}`);
}

async function verifyStake(roundId: string, slot: DriverSlot, account: PrivateKeyAccount) {
  const prepared = await postJson(`/race/round/${roundId}/stake/prepare`, {
    slot,
    wallet: account.address,
  }) as PreparedStake;
  const signature = await account.signTypedData({
    domain: prepared.typedData.domain,
    types: prepared.typedData.types,
    primaryType: prepared.typedData.primaryType,
    message: prepared.typedData.message,
  } as any);
  return postJson(`/race/round/${roundId}/stake/verify`, {
    slot,
    wallet: account.address,
    permission: prepared.permission,
    signature,
  });
}

async function assertRejected(path: string, expected: string) {
  const res = await fetch(`${sidecarHttp}${path}`);
  const json = await res.json().catch(() => ({}));
  if (res.ok || !String(json.error ?? "").includes(expected)) {
    throw new Error(`${path} should reject with ${expected}; got ${res.status} ${JSON.stringify(json)}`);
  }
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

function normalizeHttpUrl(value: string) {
  if (value.startsWith("ws://")) return value.replace(/^ws:/, "http:");
  if (value.startsWith("wss://")) return value.replace(/^wss:/, "https:");
  return value.replace(/\/$/, "");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
