/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLUSTER?: "devnet" | "mainnet-beta";
  readonly VITE_SOLANA_RPC?: string;
  readonly VITE_SIDECAR_URL?: string;
  readonly VITE_PROGRAM_ID?: string;
  readonly VITE_USDC_MINT?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
