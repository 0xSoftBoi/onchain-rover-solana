/**
 * Solana Actions / Blinks API for CLANKER 500.
 *
 * Turns a tip (and, for verified hand-offs, a bet) into a shareable link that a
 * Blink client (Phantom/Backpack/Solflare, dial.to, an X unfurl) renders as a
 * wallet-sign flow — no dApp, no wallet-connect. The client GETs the metadata,
 * POSTs {account}, and we return a base64 *unsigned* transaction it signs.
 *
 * Honest scope: the Tip Action is account-only and works as a wallet-native Blink.
 * The Bet Action needs a World-ID nullifier (place_bet mints a one-human-one-bet
 * nullifier PDA). A wallet Blink can't run the IDKit widget, so the bet endpoint
 * REQUIRES a verified `nullifier` param and is meant for verified hand-offs; the
 * on-site World-ID bet flow remains the primary path.
 *
 * Spec: https://solana.com/docs/advanced/actions
 */
import type { Express, Request, Response } from "express";
import {
  buildActionTipTx,
  buildActionBetTx,
  treasuryVaultAddress,
} from "./solana-chain.js";
import { solanaChainConfig } from "./solana-config.js";

// genesis hashes used by the Actions `X-Blockchain-Ids` (CAIP-2) header
const CHAIN_IDS: Record<string, string> = {
  "mainnet-beta": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpzw8MUSwAjm",
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1Ota8wVUNN3",
  testnet: "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
};

function actionHeaders(res: Response) {
  const cluster = solanaChainConfig().cluster;
  res.set("X-Action-Version", "2.4");
  res.set("X-Blockchain-Ids", CHAIN_IDS[cluster] ?? CHAIN_IDS["mainnet-beta"]);
  res.set("Content-Type", "application/json");
}

function selfBase(req: Request): string {
  if (process.env.PUBLIC_ACTIONS_BASE) return process.env.PUBLIC_ACTIONS_BASE.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
  return `${proto}://${req.get("host")}`;
}

export function installActions(app: Express) {
  // actions.json — maps friendly paths to the action API (for Blink unfurlers)
  app.get("/actions.json", (req, res) => {
    actionHeaders(res);
    res.json({
      rules: [
        { pathPattern: "/tip", apiPath: "/api/actions/tip" },
        { pathPattern: "/bet", apiPath: "/api/actions/bet" },
        { pathPattern: "/api/actions/**", apiPath: "/api/actions/**" },
      ],
    });
  });

  const ICON = (req: Request) => `${selfBase(req)}/api/actions/icon.svg`;

  // a small self-contained icon so the Blink always renders (no external asset)
  app.get("/api/actions/icon.svg", (_req, res) => {
    res.set("Content-Type", "image/svg+xml");
    res.send(
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#0a0a0c"/>` +
        `<text x="200" y="180" font-family="Impact,Arial" font-size="120" font-style="italic" fill="#ffd400" text-anchor="middle">500</text>` +
        `<text x="200" y="250" font-family="monospace" font-size="34" fill="#14f195" text-anchor="middle">CLANKER</text>` +
        `<rect y="330" width="400" height="40" fill="url(#c)"/>` +
        `<defs><pattern id="c" width="40" height="40" patternUnits="userSpaceOnUse"><rect width="20" height="20" fill="#f6f4ee"/><rect x="20" y="20" width="20" height="20" fill="#f6f4ee"/></pattern></defs></svg>`,
    );
  });

  // ── TIP ────────────────────────────────────────────────────────────────────
  app.get("/api/actions/tip", (req, res) => {
    actionHeaders(res);
    const b = selfBase(req);
    res.json({
      type: "action",
      icon: ICON(req),
      title: "Tip the CLANKER 500 fleet",
      description: "Send USDC to the fleet treasury — a Solana Blink. No app, no wallet-connect.",
      label: "Tip",
      links: {
        actions: [
          { type: "transaction", label: "Tip 1 USDC", href: `${b}/api/actions/tip?amount=1` },
          { type: "transaction", label: "Tip 5 USDC", href: `${b}/api/actions/tip?amount=5` },
          { type: "transaction", label: "Tip 25 USDC", href: `${b}/api/actions/tip?amount=25` },
          {
            type: "transaction",
            label: "Tip",
            href: `${b}/api/actions/tip?amount={amount}`,
            parameters: [{ name: "amount", label: "USDC amount", type: "number" }],
          },
        ],
      },
    });
  });

  app.post("/api/actions/tip", async (req, res) => {
    actionHeaders(res);
    try {
      const account = req.body?.account;
      const amount = String(req.query.amount ?? "1");
      if (!account) return res.status(400).json({ message: "missing 'account' in body" });
      if (!(Number(amount) > 0)) return res.status(400).json({ message: "amount must be > 0" });
      const transaction = await buildActionTipTx(account, amount);
      res.json({ type: "transaction", transaction, message: `Tip ${amount} USDC to the CLANKER 500 fleet 🏁` });
    } catch (e: any) {
      res.status(400).json({ message: e?.message ?? "failed to build tip transaction" });
    }
  });

  // ── BET (requires a World-ID-verified nullifier; see header note) ────────────
  app.get("/api/actions/bet", (req, res) => {
    actionHeaders(res);
    const b = selfBase(req);
    const side = String(req.query.side ?? "courier");
    res.json({
      type: "action",
      icon: ICON(req),
      title: `Back ${side.toUpperCase()} · CLANKER 500`,
      description:
        "Parimutuel bet on the rover race. Requires a World-ID-verified nullifier " +
        "(one human, one bet) — wallet Blinks can't run the World ID widget, so this " +
        "endpoint is for verified hand-offs; the on-site flow is the primary bet path.",
      label: `Back ${side}`,
      disabled: true,
      links: {
        actions: [
          {
            type: "transaction",
            label: `Back ${side} (1 USDC)`,
            href: `${b}/api/actions/bet?side=${side}&amount=1&market={market}&nullifier={nullifier}`,
            parameters: [
              { name: "market", label: "on-chain market id", type: "number" },
              { name: "nullifier", label: "World ID nullifier (verified)", type: "text" },
            ],
          },
        ],
      },
    });
  });

  app.post("/api/actions/bet", async (req, res) => {
    actionHeaders(res);
    try {
      const account = req.body?.account;
      const side = String(req.query.side ?? "courier").toLowerCase();
      const amount = String(req.query.amount ?? "1");
      const market = Number(req.query.market ?? 0);
      const nullifier = req.query.nullifier ? String(req.query.nullifier) : "";
      if (!account) return res.status(400).json({ message: "missing 'account' in body" });
      if (!nullifier)
        return res.status(400).json({
          message:
            "World ID nullifier required — place_bet is one-human-one-bet. Wallet Blinks can't run " +
            "the World ID widget; use the on-site bet flow, or pass a verified nullifier.",
        });
      const racerIdx = side === "guard" ? 0 : 1;
      const transaction = await buildActionBetTx(account, market, racerIdx, amount, nullifier);
      res.json({ type: "transaction", transaction, message: `Place ${amount} USDC on ${side} 🏁` });
    } catch (e: any) {
      res.status(400).json({ message: e?.message ?? "failed to build bet transaction" });
    }
  });

  let treasury = "?";
  try { treasury = treasuryVaultAddress(); } catch { /* config not loaded yet */ }
  console.log("[actions] Solana Actions/Blinks API mounted · treasury", treasury);
}
