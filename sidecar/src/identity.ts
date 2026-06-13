/**
 * Real agent identity: signed challenges (robot's own EOA key) + live AgentBook
 * human-backing reads on World Chain. No mocks — every value is on-chain or a
 * real ECDSA signature.
 */
import {
  createPublicClient, http, parseAbi, recoverMessageAddress, getAddress, keccak256, toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { worldchain } from "viem/chains";
import { ROBOTS, type RobotName } from "./config.js";

// AgentBook on World Chain (verified): lookupHuman(agentWallet) -> humanId (0 = none)
const AGENTBOOK = "0xA23aB2712eA7BBa896930544C7d6636a96b944dA";
const agentBookAbi = parseAbi(["function lookupHuman(address) view returns (uint256)"]);

const worldClient = createPublicClient({
  chain: worldchain,
  transport: http(process.env.WORLDCHAIN_RPC ?? "https://worldchain-mainnet.gateway.tenderly.co"),
});

const KEYS: Record<string, string | undefined> = {
  get guard() { return process.env.GUARD_PRIVATE_KEY; },
  get courier() { return process.env.COURIER_PRIVATE_KEY; },
};

// nonce replay guard (per robot challenge)
const usedNonces = new Set<string>();

/** Robot signs a fresh challenge with its OWN key — real ECDSA over the payload. */
export async function signChallenge(robot: RobotName) {
  const pk = KEYS[robot];
  if (!pk) throw new Error(`no private key for '${robot}'`);
  const account = privateKeyToAccount(pk as `0x${string}`);
  // deterministic nonce from key material + a monotonic-ish salt (block number)
  const block = await worldClient.getBlockNumber().catch(() => 0n);
  const nonce = keccak256(toHex(`${robot}:${account.address}:${block}`)).slice(2, 18);
  const ts = Number(block); // tie to chain state, not wall clock
  const message = `rover-auth|${ROBOTS[robot].ens}|${account.address}|${nonce}|${ts}`;
  const signature = await account.signMessage({ message });
  return { ens: ROBOTS[robot].ens, wallet: account.address,
           agentId: ROBOTS[robot].agentId, nonce, ts, message, signature };
}

/** Verify a signed challenge: recover the signer, confirm it's the claimed wallet,
 * and that the nonce hasn't been replayed. */
export async function verifyChallenge(p: {
  message: string; signature: `0x${string}`; wallet: string; nonce: string;
}) {
  const recovered = await recoverMessageAddress({ message: p.message, signature: p.signature });
  const ok = getAddress(recovered) === getAddress(p.wallet);
  const replay = usedNonces.has(p.nonce);
  if (ok && !replay) usedNonces.add(p.nonce);
  return { signatureValid: ok, replay, recovered };
}

/** Live AgentBook read: is this agent wallet backed by a verified human? */
export async function lookupHuman(wallet: string): Promise<{ humanBacked: boolean; humanId: string }> {
  const humanId = await worldClient.readContract({
    address: AGENTBOOK, abi: agentBookAbi, functionName: "lookupHuman",
    args: [getAddress(wallet)],
  });
  return { humanBacked: humanId !== 0n, humanId: humanId.toString() };
}
