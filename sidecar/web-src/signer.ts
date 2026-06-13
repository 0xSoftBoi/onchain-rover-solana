import { getAddress } from "viem";

export type EthereumProvider = {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  isBaseAccount?: boolean;
  isCoinbaseWallet?: boolean;
  selectedAddress?: string;
  providers?: EthereumProvider[];
  providerInfo?: {
    name?: string;
    rdns?: string;
    icon?: string;
  };
};

export type DriverSlot = "challenger" | "opponent";

export type WalletKind = "base-account" | "injected-eip1193";

export type WalletChain = {
  chainIdHex: string;
  rpcUrl: string;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
};

export type TypedDataEnvelope = {
  domain?: Record<string, unknown>;
  types?: Record<string, Array<{ name: string; type: string }>>;
  primaryType?: string;
  message?: Record<string, unknown>;
};

export type WalletSession = {
  address: string;
  chainId?: number;
  walletKind: WalletKind;
  walletLabel: string;
  displayName?: string;
};

export type RaceAuthorizationRequest = {
  chain: WalletChain;
  entry: TypedDataEnvelope & { message?: { deadline?: string } };
  permit: TypedDataEnvelope & { message?: { deadline?: string } };
};

export type SignedRaceAuthorization = {
  entrySignature: string;
  permitSignature: string;
  entryDeadline?: string;
  permitDeadline?: string;
};

export type StakeAuthorizationInput = {
  roundId: string;
  slot: DriverSlot;
  adapter?: "base-spend-permission";
};

export type RaceFeeInput = {
  roundId: string;
  slot: DriverSlot;
  displayName?: string;
};

export type WalletSigner = {
  readonly id: string;
  readonly label: string;
  readonly kind: WalletKind;
  connect(): Promise<WalletSession>;
  ensureChain(chain: WalletChain): Promise<void>;
  signTypedData(session: WalletSession, data: TypedDataEnvelope): Promise<string>;
  signRaceIntent(session: WalletSession, request: RaceAuthorizationRequest): Promise<SignedRaceAuthorization>;
  authorizeStake(session: WalletSession, input: StakeAuthorizationInput): Promise<unknown>;
  payRaceFee(session: WalletSession, input: RaceFeeInput): Promise<unknown>;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export type WalletSignerOptions = {
  preferredKind?: WalletKind;
  provider?: EthereumProvider;
};

export function createWalletSigner(options: WalletSignerOptions = {}): WalletSigner {
  const provider = options.provider ?? selectEthereumProvider(options.preferredKind);
  if (!provider) throw new Error("EVM wallet required");

  const kind = detectWalletKind(provider, options.preferredKind);
  const label = walletLabel(provider, kind);
  const signTypedData = async (session: WalletSession, data: TypedDataEnvelope) => {
    return provider.request({
      method: "eth_signTypedData_v4",
      params: [session.address, JSON.stringify(data)],
    }) as Promise<string>;
  };
  const ensureChain = async (chain: WalletChain) => {
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chain.chainIdHex }],
      });
    } catch (err) {
      const code = typeof err === "object" && err && "code" in err
        ? Number((err as { code: unknown }).code)
        : 0;
      if (code !== 4902) throw err;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: chain.chainIdHex,
          chainName: chain.name,
          rpcUrls: [chain.rpcUrl],
          nativeCurrency: chain.nativeCurrency,
        }],
      });
    }
  };

  return {
    id: kind,
    label,
    kind,

    async connect() {
      const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
      const address = accounts[0] ?? provider.selectedAddress;
      if (!address) throw new Error("wallet account unavailable");
      return {
        address: getAddress(address),
        chainId: await currentChainId(provider),
        walletKind: kind,
        walletLabel: label,
      };
    },

    ensureChain,

    signTypedData,

    async signRaceIntent(session, request) {
      await ensureChain(request.chain);
      const entrySignature = await signTypedData(session, request.entry);
      const permitSignature = await signTypedData(session, request.permit);
      return {
        entrySignature,
        permitSignature,
        entryDeadline: stringValue(request.entry.message?.deadline),
        permitDeadline: stringValue(request.permit.message?.deadline),
      };
    },

    async authorizeStake(session, input) {
      const adapter = input.adapter ?? "base-spend-permission";
      const prepared = await postJson(`/race/round/${encodeURIComponent(input.roundId)}/stake/prepare`, {
        adapter,
        slot: input.slot,
        wallet: session.address,
      }) as {
        typedData: TypedDataEnvelope;
        permission?: Record<string, unknown>;
      };
      const signature = await signTypedData(session, prepared.typedData);
      return postJson(`/race/round/${encodeURIComponent(input.roundId)}/stake/verify`, {
        adapter,
        slot: input.slot,
        wallet: session.address,
        typedData: prepared.typedData,
        permission: prepared.permission,
        signature,
      });
    },

    async payRaceFee(_session, _input) {
      throw new Error(`${label} x402 fee payment requires a browser-safe payment adapter`);
    },
  };
}

export function injectedWalletSigner(provider?: EthereumProvider): WalletSigner {
  return createWalletSigner({ provider, preferredKind: "injected-eip1193" });
}

export function walletDisplayName(session: WalletSession): string {
  return session.displayName ?? shortenAddress(session.address);
}

function selectEthereumProvider(preferredKind?: WalletKind): EthereumProvider | undefined {
  const injected = typeof window === "undefined" ? undefined : window.ethereum;
  if (!injected) return undefined;
  const providers = injected.providers?.length ? injected.providers : [injected];
  if (preferredKind === "base-account") return providers.find(isBaseAccountProvider) ?? injected;
  if (preferredKind === "injected-eip1193") return providers.find((provider) => !isBaseAccountProvider(provider)) ?? injected;
  return providers.find(isBaseAccountProvider) ?? injected;
}

function detectWalletKind(provider: EthereumProvider, preferredKind?: WalletKind): WalletKind {
  if (preferredKind === "base-account") return "base-account";
  if (isBaseAccountProvider(provider)) return "base-account";
  return "injected-eip1193";
}

function isBaseAccountProvider(provider: EthereumProvider): boolean {
  const name = provider.providerInfo?.name?.toLowerCase() ?? "";
  const rdns = provider.providerInfo?.rdns?.toLowerCase() ?? "";
  return Boolean(provider.isBaseAccount || name.includes("base") || rdns.includes("base"));
}

function walletLabel(provider: EthereumProvider, kind: WalletKind): string {
  if (kind === "base-account") return "Base Account";
  return provider.providerInfo?.name || (provider.isCoinbaseWallet ? "Coinbase Wallet" : "Browser Wallet");
}

async function currentChainId(provider: EthereumProvider): Promise<number | undefined> {
  try {
    const chainId = await provider.request({ method: "eth_chainId" });
    if (typeof chainId !== "string") return undefined;
    return Number.parseInt(chainId, 16);
  } catch {
    return undefined;
  }
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json as { error?: string }).error) {
    throw new Error((json as { error?: string }).error || `request failed ${res.status}`);
  }
  return json;
}

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
