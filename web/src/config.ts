// Client config — all public/keyless. NEVER put a Helius API key here; the
// browser uses a keyless public RPC (the keyed Helius URL is server-only).
import { clusterApiUrl, PublicKey } from "@solana/web3.js";

const env = import.meta.env;

export const CLUSTER = (env.VITE_CLUSTER ?? "devnet") as
  | "devnet"
  | "mainnet-beta";

/** Keyless public RPC for the browser. Override with VITE_SOLANA_RPC. */
export const RPC_URL: string =
  env.VITE_SOLANA_RPC ?? clusterApiUrl(CLUSTER);

/** Sidecar API base (rounds, x402-gated routes, telemetry). */
export const SIDECAR_URL: string = env.VITE_SIDECAR_URL ?? "http://127.0.0.1:4021";

/** Deployed clanker5000 program id. */
export const PROGRAM_ID = new PublicKey(
  env.VITE_PROGRAM_ID ?? "4FLTsBUD6iCQo5VBzdCSv8imoCnhttnQ1GQFEHL5iEDD",
);

/** SPL-USDC mint (devnet test mint or mainnet USDC). */
export const USDC_MINT = new PublicKey(
  env.VITE_USDC_MINT ?? "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr",
);

export const EXPLORER = (sig: string, kind: "tx" | "address" = "tx") =>
  `https://explorer.solana.com/${kind}/${sig}?cluster=${CLUSTER}`;
