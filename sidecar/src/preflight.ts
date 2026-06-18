/**
 * Demo doctor — native Solana. One command that checks every dependency and
 * prints a green/red readiness board before judging.  npx tsx src/preflight.ts
 *
 * Probes the Solana program/cluster (localChainHealth), SNS resolution (sns.ts),
 * robot health, USDC balances, treasury, World ID config, and Walrus — replacing
 * the EVM Arc/Sepolia/World-Chain/ENS probes.
 */
import "./env.js";
import { ROBOTS } from "./config.js";
import { localChainHealth, localTreasuryInfo, usdcBalanceOf } from "./solana-chain.js";
import { fleet as snsFleet } from "./sns.js";
import { buildFieldPreflight } from "./field-preflight.js";

const ok = (b: boolean) => (b ? "✅" : "❌");
const rows: { ok: boolean; label: string; detail: string }[] = [];
const check = (label: string, pass: boolean, detail = "") => rows.push({ ok: pass, label, detail });

const usdc = async (a: string): Promise<bigint> => {
  try {
    if (!a) return -1n;
    return await usdcBalanceOf(a);
  } catch {
    return -1n;
  }
};

async function main() {
  // Solana program / cluster health
  let health: any = null;
  try {
    health = await localChainHealth();
    check("Solana program reachable", !!health?.ok, health?.programId ? `program ${health.programId}` : JSON.stringify(health ?? {}).slice(0, 48));
  } catch (e: any) {
    check("Solana program reachable", false, e.message?.slice(0, 48) ?? "unreachable");
  }

  // Robots
  for (const [n, r] of Object.entries(ROBOTS)) {
    try {
      const h = await (await fetch(`${r.url}/health`, { signal: AbortSignal.timeout(3000) })).json();
      check(`Robot ${n}`, !!h.ok, `${r.url} · ${h.battery_v ?? "?"}V`);
    } catch { check(`Robot ${n}`, false, `${r.url} unreachable`); }
  }

  // Wallet USDC balances (need stake + fee)
  for (const [n, r] of Object.entries(ROBOTS)) {
    const b = await usdc(r.wallet);
    check(`${n} USDC funded`, b > 0n, b < 0n ? "read failed / wallet unset" : `${Number(b) / 1e6} USDC`);
  }

  // Treasury PDA vault
  try {
    const t = await localTreasuryInfo();
    const bal = Number((t as any)?.balanceUsdc ?? (t as any)?.balance ?? 0);
    check("treasury vault", true, `${bal} USDC${(t as any)?.owner ? ` · owner ${(t as any).owner}` : ""}`);
  } catch (e: any) {
    check("treasury vault", false, e.message?.slice(0, 48) ?? "read failed");
  }

  // SNS (.sol) live resolution
  try {
    const f = await snsFleet();
    check("SNS resolves", f.guard.resolved || f.courier.resolved,
      `guard ${f.guard.address ?? "unresolved"} · courier ${f.courier.address ?? "unresolved"}`);
  } catch (e: any) { check("SNS resolves", false, e.message?.slice(0, 40) ?? "resolution failed"); }

  // World ID configured (off-chain verifier)
  check("World ID configured", !!process.env.WORLD_APP_ID, process.env.WORLD_APP_ID ?? "WORLD_APP_ID unset");

  // Walrus reachable
  try {
    const w = await fetch("https://publisher.walrus-testnet.walrus.space/v1/api", { signal: AbortSignal.timeout(5000) });
    check("Walrus reachable", w.status < 500, `HTTP ${w.status}`);
  } catch { check("Walrus reachable", false, "unreachable"); }

  // Treasury owner (Ledger Solana / Squads v4) config
  check("Treasury owner set", !!process.env.TREASURY_OWNER_PUBKEY,
    process.env.TREASURY_OWNER_PUBKEY ?? "TREASURY_OWNER_PUBKEY unset (facilitator fallback)");

  // print board
  console.log("\n  CLANKER500 — PRE-FLIGHT (Solana)\n  " + "─".repeat(46));
  for (const r of rows) console.log(`  ${ok(r.ok)} ${r.label.padEnd(26)} ${r.detail}`);
  const blockers = rows.filter((r) => !r.ok).length;
  console.log("  " + "─".repeat(46));
  console.log(blockers === 0 ? "  🟢 ALL SYSTEMS GO" : `  🟡 ${blockers} blocker(s) — see ❌ above\n`);

  const field = await buildFieldPreflight({
    publicBaseUrl: process.env.PUBLIC_SIDECAR_URL ?? "http://127.0.0.1:4021",
    allowFreePilot: process.env.ALLOW_FREE_PILOT === "1",
    allowLocalDevWallets: process.env.ALLOW_LOCAL_DEV_WALLETS === "1" || process.env.ALLOW_FREE_PILOT === "1",
  });
  console.log("\n  FIELD READINESS\n  " + "─".repeat(46));
  for (const fieldCheck of field.checks) {
    const icon = fieldCheck.status === "pass" ? "✅" : fieldCheck.status === "warn" ? "⚠️ " : "❌";
    console.log(`  ${icon} ${fieldCheck.name.padEnd(26)} ${fieldCheck.detail}`);
    if (fieldCheck.status !== "pass") console.log(`     fix: ${fieldCheck.remediation}`);
  }
  console.log("  " + "─".repeat(46));
  console.log(field.ok ? "  🟢 FIELD READY" : `  🟡 ${field.summary.fail} fail / ${field.summary.warn} warn\n`);
}
main();
