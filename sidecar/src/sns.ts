/**
 * Live SNS (.sol) resolution — the Solana-native counterpart of ens.ts.
 *
 * The fleet's names are SNS domains/subdomains (e.g. guard.roverfleet.sol,
 * courier.roverfleet.sol). We resolve the owner live via Bonfida's
 * @bonfida/spl-name-service against a Solana RPC, plus a TXT record carrying
 * the agent context (the SNS analog of the ENSIP-25 "agent-context" text
 * record). No hardcoded values.
 *
 * SNS lives on mainnet-beta; set SNS_RPC_URL to a mainnet RPC. See
 * docs/SOLANA_PORT.md for the registration step (still planned).
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { resolve as resolveOwner, getRecordV2, Record } from "@bonfida/spl-name-service";

const RPC = process.env.SNS_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const PARENT_LABEL = process.env.SNS_PARENT_LABEL ?? "roverfleet";
const PARENT = `${PARENT_LABEL}.sol`;

function connection(): Connection {
  return new Connection(RPC, "confirmed");
}

/** Resolve a fleet (sub)domain live: owner + agent-context TXT record. */
export async function resolve(domain: string) {
  const conn = connection();
  // Bonfida resolves "<name>" -> "<name>.sol"; strip a trailing .sol if present.
  const name = domain.replace(/\.sol$/, "");
  let owner: PublicKey | null = null;
  try {
    owner = await resolveOwner(conn, name);
  } catch {
    owner = null;
  }
  let agentContext: string | null = null;
  try {
    const rec = await getRecordV2(conn, name, Record.TXT);
    agentContext = rec?.retrievedRecord?.getContent?.()?.toString() ?? null;
  } catch {
    agentContext = null;
  }
  return {
    name: `${name}.sol`,
    cluster: "mainnet-beta",
    address: owner ? owner.toBase58() : null,
    agentContext,
    resolved: Boolean(owner),
  };
}

export async function fleet() {
  const [guard, courier] = await Promise.all([
    resolve(`guard.${PARENT_LABEL}`),
    resolve(`courier.${PARENT_LABEL}`),
  ]);
  return { parent: PARENT, cluster: "mainnet-beta", guard, courier };
}
