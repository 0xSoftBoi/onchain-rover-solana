/**
 * Live SNS (.sol) resolution — the Solana-native counterpart of ens.ts.
 *
 * The fleet's names are SNS domains/subdomains (e.g. guard.roverfleet.sol,
 * courier.roverfleet.sol). We resolve the owner live via Bonfida's
 * @bonfida/spl-name-service against a Solana RPC, plus a TXT record carrying
 * the agent context (the SNS analog of the ENSIP-25 "agent-context" text
 * record). No hardcoded values.
 *
 * SNS lives on mainnet-beta; set SNS_RPC_URL to a mainnet RPC. Registration
 * (subdomain + agent-context record) is below — see docs/SOLANA_NATIVE_MIGRATION.md §3.
 */
import { Connection, PublicKey } from "@solana/web3.js";

/**
 * Lazy, cached loader for @bonfida/spl-name-service.
 *
 * Importing this package eagerly crashes the sidecar boot under the `tsx`
 * dev/start runner: tsx's esbuild loader mishandles bonfida's bundled-borsh
 * minified nested re-export (`export { i as serialize }`), throwing
 * "does not provide an export named 'serialize'". Plain `node` imports the
 * package fine, so the only problem is touching it at module-load time under
 * tsx. Deferring the import to first use keeps the server boot off the bonfida
 * code path entirely — the server always boots, SNS works fully on the native
 * runtime, and a load failure under the broken dev loader degrades to
 * "unresolved" (caught below) instead of taking down the whole process.
 */
let _bonfida: Promise<typeof import("@bonfida/spl-name-service")> | null = null;
const bonfida = () => (_bonfida ??= import("@bonfida/spl-name-service"));

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
    const { resolve: resolveOwner } = await bonfida();
    owner = await resolveOwner(conn, name);
  } catch {
    owner = null;
  }
  let agentContext: string | null = null;
  try {
    const { getRecordV2, Record } = await bonfida();
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

/**
 * Register a fleet subdomain `<label>.<PARENT>.sol` and (optionally) write its
 * agent-context TXT record — the SNS analog of ENS subname + ENSIP-25 text
 * record (the replacement for register-ens.ts). The PARENT `.sol` domain owner
 * must sign + fund the create; this returns the serialized instructions for that
 * owner (or a Squads/Ledger signer) to sign — the sidecar never holds the key,
 * mirroring buildTreasuryWithdraw. Confirm the @bonfida/spl-name-service
 * createSubdomain / createRecordV2Instruction signatures against the installed
 * version before going live.
 */
export async function registerSubdomain(
  label: string,
  ownerBase58: string,
  agentContext?: string
) {
  const conn = connection();
  const { createSubdomain, createRecordV2Instruction, Record } = await bonfida();
  const owner = new PublicKey(ownerBase58);
  const sub = `${label}.${PARENT_LABEL}`; // e.g. "guard.roverfleet"
  // createSubdomain creates `<sub>.sol` under the parent (owner = subdomain owner).
  const created: any = await createSubdomain(conn, sub, owner);
  const ixs: any[] = Array.isArray(created) ? created.flat() : created?.ixs ?? [created];
  if (agentContext) {
    ixs.push(
      createRecordV2Instruction(sub, Record.TXT, agentContext, owner, owner)
    );
  }
  return {
    subdomain: `${sub}.sol`,
    owner: owner.toBase58(),
    instructions: ixs.filter(Boolean).map((ix: any) => ({
      programId: ix.programId.toBase58(),
      keys: ix.keys.map((k: any) => ({
        pubkey: k.pubkey.toBase58(),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(ix.data).toString("base64"),
    })),
  };
}
