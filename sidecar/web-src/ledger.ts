/**
 * Ledger clear-sign treasury withdrawal — the governance climax.
 * Bundled to public/ledger.bundle.js by `npm run build:ledger` (esbuild).
 *
 * Flow: WebHID connect -> open Ethereum app -> sign the withdraw tx. With an
 * originToken + our ERC-7730 descriptor the device shows "Withdraw X USDC to Y";
 * without it, blind-sign fallback. Either way the funds move ONLY on a physical
 * button press — that's the demo's point.
 *
 * WebHID: Chromium-only, secure context, must be triggered by a user gesture.
 */
import { DeviceManagementKitBuilder, ConsoleLogger } from "@ledgerhq/device-management-kit";
import { webHidTransportFactory } from "@ledgerhq/device-transport-kit-web-hid";
import { SignerEthBuilder } from "@ledgerhq/device-signer-kit-ethereum";
import { firstValueFrom, filter } from "rxjs";

const DERIVATION = "44'/60'/0'/0/0";
const ORIGIN_TOKEN = (window as any).LEDGER_ORIGIN_TOKEN || "origin-token"; // from Ledger booth

let dmk: any, sessionId: string, signerEth: any, deviceAddress: string;

function log(m: string) {
  const el = document.getElementById("status");
  if (el) el.textContent = m;
  console.log("[ledger]", m);
}

export async function connect() {
  if (!("hid" in navigator)) throw new Error("WebHID unavailable — use Chrome/Edge over HTTPS or localhost");
  dmk = new DeviceManagementKitBuilder().addLogger(new ConsoleLogger())
    .addTransport(webHidTransportFactory).build();
  log("select your Ledger in the browser prompt…");
  const device = await firstValueFrom(dmk.startDiscovering({}));
  sessionId = await dmk.connect({ device });
  log("connected — open the Ethereum app on the device");
  signerEth = new SignerEthBuilder({ dmk, sessionId, originToken: ORIGIN_TOKEN }).build();
  deviceAddress = await getAddress();
  log("ready · device address " + deviceAddress.slice(0, 10) + "…");
  return deviceAddress;
}

async function getAddress(): Promise<string> {
  const { observable } = signerEth.getAddress(DERIVATION, { checkOnDevice: false });
  const final = await firstValueFrom(
    observable.pipe(filter((s: any) => s.status === "completed" || s.status === "error")));
  if (final.status === "error") throw final.error;
  return final.output.address as string;
}

/** Sign a serialized unsigned EIP-1559 tx (hex) on the device. Returns {r,s,v}. */
export async function signTx(unsignedSerializedHex: string) {
  if (!signerEth) throw new Error("connect the Ledger first");
  log("review and APPROVE on your Ledger…");
  const bytes = hexToBytes(unsignedSerializedHex);
  const { observable } = signerEth.signTransaction(DERIVATION, bytes, {});
  const final = await firstValueFrom(
    observable.pipe(filter((s: any) => s.status === "completed" || s.status === "error")));
  if (final.status === "error") throw final.error;
  log("signed on device ✓");
  return final.output as { r: string; s: string; v: number | bigint };
}

/** Full climax: fetch unsigned withdraw tx -> Ledger sign -> broadcast on Arc. */
export async function withdraw(to: string, amountUsdc: string) {
  if (!deviceAddress) throw new Error("connect the Ledger first");
  const built = await (await fetch(
    `/treasury/withdraw-tx?from=${deviceAddress}&to=${to}&amount=${amountUsdc}`)).json();
  if (built.error) throw new Error(built.error);
  const sig = await signTx(built.unsignedSerialized);
  log("broadcasting on Arc…");
  const res = await (await fetch("/treasury/broadcast", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tx: built.tx, signature: sig }),
  })).json();
  if (res.error) throw new Error(res.error);
  log("✓ withdrawn — tx " + res.tx);
  return res;
}

function hexToBytes(hex: string) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

(window as any).roverLedger = { connect, withdraw, signTx };
