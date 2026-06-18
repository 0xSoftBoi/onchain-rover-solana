/**
 * Shared chain-agnostic types. Extracted from the (now-removed) EVM chain.ts so
 * callers can import the envelope shape without pulling in any settlement client.
 */

/**
 * EIP-712-style typed-data envelope. Retained as a transport shape for the
 * local-dev wallet helpers; on Solana the equivalent payload is a serialized
 * transaction signed by the user's wallet.
 */
export type TypedDataEnvelope = {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};
