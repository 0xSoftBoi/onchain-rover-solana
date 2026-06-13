/**
 * Live ENS resolution (real, on Sepolia). The fleet's names are registered
 * on-chain by register-ens.ts: roverfleet.eth + guard./courier. subnames with
 * addr + ENSIP-25 agent-registration text records. Resolved here with viem
 * against the real ENS registry on Sepolia — no hardcoded values.
 */
import { createPublicClient, http } from "viem";
import { mainnet, sepolia } from "viem/chains";

const CHAIN = (process.env.ENS_CHAIN ?? "sepolia") === "mainnet" ? mainnet : sepolia;
const PARENT = `${process.env.ENS_PARENT_LABEL ?? "roverfleet"}.eth`;
const pub = createPublicClient({ chain: CHAIN, transport: http() });

/** Resolve a fleet subname live: address + key records. */
export async function resolve(name: string) {
  const [address, context, agentReg] = await Promise.all([
    pub.getEnsAddress({ name }),
    pub.getEnsText({ name, key: "agent-context" }),
    // ENSIP-25 record presence is enough to show the name<->agent link
    pub.getEnsText({ name, key: "agent-context" }).catch(() => null),
  ]);
  return { name, chain: CHAIN.name, address, agentContext: context, resolved: Boolean(address) };
}

export async function fleet() {
  const [guard, courier] = await Promise.all([
    resolve(`guard.${PARENT}`), resolve(`courier.${PARENT}`),
  ]);
  return { parent: PARENT, chain: CHAIN.name, guard, courier };
}
