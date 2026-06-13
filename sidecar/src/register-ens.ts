/**
 * REAL ENS registration + fleet subnames + ENSIP-25 records.
 * Fully on-chain (no offchain gateway): register the parent, create guard/courier
 * subnames, set addr + ENSIP-25 agent-registration text records, set reverse.
 *
 *   ENS_CHAIN=mainnet|sepolia ENS_PARENT_LABEL=roverfleet \
 *   ENS_OWNER_KEY=0x... npx tsx src/register-ens.ts
 *
 * Owner wallet needs ETH on the chosen chain (registration fee + gas). Run once;
 * prints the resolved records to prove it's live.
 */
import "./env.js";
import {
  createPublicClient, createWalletClient, http, namehash, labelhash,
  encodeFunctionData, parseAbi, getAddress, stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, sepolia } from "viem/chains";
import { ROBOTS, ERC8004, ensip25Key } from "./config.js";

const CHAIN = (process.env.ENS_CHAIN ?? "sepolia") === "mainnet" ? mainnet : sepolia;
const LABEL = process.env.ENS_PARENT_LABEL ?? "roverfleet";
const PARENT = `${LABEL}.eth`;
const account = privateKeyToAccount(process.env.ENS_OWNER_KEY as `0x${string}`);

// ENS deployments (same addresses mainnet + sepolia for these core contracts)
const CONTROLLER = CHAIN.id === 1
  ? "0x59E16fcCd424Cc24e280Be16E11Bcd56fb0CE547"   // mainnet ETHRegistrarController
  : "0xfb3cE5D01e0f33f41DbB39035dB9745962F1f968";  // sepolia
const PUBLIC_RESOLVER = CHAIN.id === 1
  ? "0xF29100983E058B709F3D539b0c765937B804AC15"
  : "0x8FADE66B79cC9f707aB26799354482EB93a5B7dD";
const REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e"; // ENS registry (both)

const pub = createPublicClient({ chain: CHAIN, transport: http() });
const wallet = createWalletClient({ account, chain: CHAIN, transport: http() });

// ENSv2 controller: register/makeCommitment take a Registration struct.
const controllerAbi = parseAbi([
  "struct Registration { string label; address owner; uint256 duration; bytes32 secret; address resolver; bytes[] data; uint8 reverseRecord; bytes32 referrer; }",
  "function rentPrice(string label, uint256 duration) view returns ((uint256 base, uint256 premium))",
  "function available(string label) view returns (bool)",
  "function makeCommitment(Registration registration) pure returns (bytes32)",
  "function commit(bytes32 commitment)",
  "function register(Registration registration) payable",
]);
const registryAbi = parseAbi([
  "function setSubnodeOwner(bytes32 node, bytes32 label, address owner) returns (bytes32)",
  "function owner(bytes32 node) view returns (address)",
]);
const resolverAbi = parseAbi([
  "function setAddr(bytes32 node, address a)",
  "function setText(bytes32 node, string key, string value)",
]);

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

async function registerParent() {
  const avail = await pub.readContract({ address: CONTROLLER as `0x${string}`, abi: controllerAbi, functionName: "available", args: [LABEL] });
  if (!avail) { console.log(`${PARENT} not available (already owned?) — skipping register`); return; }
  const duration = 31536000n; // 1 year
  const secret = ("0x" + "11".repeat(32)) as `0x${string}`;
  const price = await pub.readContract({ address: CONTROLLER as `0x${string}`, abi: controllerAbi, functionName: "rentPrice", args: [LABEL, duration] });
  const value = (price.base + price.premium) * 11n / 10n; // +10% buffer for price drift
  const reg = {
    label: LABEL, owner: account.address, duration, secret,
    resolver: PUBLIC_RESOLVER as `0x${string}`, data: [] as `0x${string}`[],
    reverseRecord: 0, referrer: ("0x" + "00".repeat(32)) as `0x${string}`,
  };
  const commitment = await pub.readContract({ address: CONTROLLER as `0x${string}`, abi: controllerAbi, functionName: "makeCommitment", args: [reg] });
  console.log("commit…");
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: CONTROLLER as `0x${string}`, abi: controllerAbi, functionName: "commit", args: [commitment] }) });
  console.log("waiting 70s for the commitment window…"); await sleep(70);
  console.log(`register ${PARENT} for ~${value} wei…`);
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: CONTROLLER as `0x${string}`, abi: controllerAbi, functionName: "register", args: [reg], value }) });
  console.log(`✅ ${PARENT} registered`);
}

async function makeSubname(label: "guard" | "courier", robot: { wallet: string; agentId?: string }) {
  const parentNode = namehash(PARENT);
  const node = namehash(`${label}.${PARENT}`);
  console.log(`subnode ${label}.${PARENT}…`);
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({
    address: REGISTRY as `0x${string}`, abi: registryAbi, functionName: "setSubnodeOwner",
    args: [parentNode, labelhash(label), account.address] }) });
  // resolver + addr + ENSIP-25 record (links the name to its ERC-8004 agentId)
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({
    address: PUBLIC_RESOLVER as `0x${string}`, abi: resolverAbi, functionName: "setAddr",
    args: [node, getAddress(robot.wallet)] }) });
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({
    address: PUBLIC_RESOLVER as `0x${string}`, abi: resolverAbi, functionName: "setText",
    args: [node, ensip25Key(robot.agentId ?? 0), "1"] }) });
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({
    address: PUBLIC_RESOLVER as `0x${string}`, abi: resolverAbi, functionName: "setText",
    args: [node, "agent-context", `physical rover agent ${label}; skills: guard,deliver,race; pays x402 USDC on eip155:5042002`] }) });
  console.log(`✅ ${label}.${PARENT} -> ${robot.wallet} (+ ENSIP-25 agent #${robot.agentId})`);
}

console.log(`Registering on ${CHAIN.name} as ${account.address}`);
await registerParent();
await makeSubname("guard", ROBOTS.guard);
await makeSubname("courier", ROBOTS.courier);

// prove it's live
const guardAddr = await pub.getEnsAddress({ name: `guard.${PARENT}` });
const guardRec = await pub.getEnsText({ name: `guard.${PARENT}`, key: "agent-context" });
console.log(`\nLIVE RESOLUTION (${CHAIN.name}):`);
console.log(`  guard.${PARENT} -> ${guardAddr}`);
console.log(`  agent-context  -> ${guardRec}`);
