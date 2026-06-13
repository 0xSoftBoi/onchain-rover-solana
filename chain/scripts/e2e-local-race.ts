import fs from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  keccak256,
  parseSignature,
  parseUnits,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { LOCAL_ACCOUNTS } from "./accounts.js";
import { deploymentPath, readArtifact } from "./artifacts.js";

const deployment = JSON.parse(fs.readFileSync(deploymentPath(), "utf8"));
const chain = defineChain({
  id: deployment.chainId,
  name: "Rover Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [deployment.rpcUrl] } },
});

const publicClient = createPublicClient({ chain, transport: http(deployment.rpcUrl) });
const facilitatorWallet = createWalletClient({
  account: LOCAL_ACCOUNTS.facilitator,
  chain,
  transport: http(deployment.rpcUrl),
});

const token = readArtifact("MockRaceToken");
const escrow = readArtifact("RaceEscrow");
const tokenAddress = deployment.contracts.RaceToken as Address;
const escrowAddress = deployment.contracts.RaceEscrow as Address;
const stakeAmount = BigInt(deployment.defaults.stakeUnits);
const feeAmount = BigInt(deployment.defaults.feeUnits);

async function main() {
  const raceId = await publicClient.readContract({
    address: escrowAddress,
    abi: escrow.abi,
    functionName: "nextRaceId",
  }) as bigint;

  const openHash = await facilitatorWallet.writeContract({
    address: escrowAddress,
    abi: escrow.abi,
    functionName: "openRace",
    args: [keccak256(toBytes("e2e-local-round")), stakeAmount, feeAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: openHash });

  await joinDriver(raceId, 0, LOCAL_ACCOUNTS.challenger);
  await joinDriver(raceId, 1, LOCAL_ACCOUNTS.opponent);

  const lockHash = await facilitatorWallet.writeContract({
    address: escrowAddress,
    abi: escrow.abi,
    functionName: "lockRace",
    args: [raceId],
  });
  await publicClient.waitForTransactionReceipt({ hash: lockHash });

  const startHash = await facilitatorWallet.writeContract({
    address: escrowAddress,
    abi: escrow.abi,
    functionName: "startRace",
    args: [raceId],
  });
  await publicClient.waitForTransactionReceipt({ hash: startHash });

  const finishHash = await facilitatorWallet.writeContract({
    address: escrowAddress,
    abi: escrow.abi,
    functionName: "finishRace",
    args: [raceId, 0, keccak256(toBytes("finish-photo-proof"))],
  });
  await publicClient.waitForTransactionReceipt({ hash: finishHash });

  const settleHash = await facilitatorWallet.writeContract({
    address: escrowAddress,
    abi: escrow.abi,
    functionName: "settleRace",
    args: [raceId],
  });
  await publicClient.waitForTransactionReceipt({ hash: settleHash });

  const [challenger, opponent, treasury, escrowBalance] = await Promise.all([
    balance(LOCAL_ACCOUNTS.challenger.address),
    balance(LOCAL_ACCOUNTS.opponent.address),
    balance(LOCAL_ACCOUNTS.treasury.address),
    balance(escrowAddress),
  ]);

  const expectedWinner = parseUnits("1000", 6) + stakeAmount - feeAmount;
  const expectedLoser = parseUnits("1000", 6) - stakeAmount - feeAmount;
  const expectedTreasury = feeAmount * 2n;
  if (challenger !== expectedWinner) throw new Error(`bad winner balance ${challenger}`);
  if (opponent !== expectedLoser) throw new Error(`bad loser balance ${opponent}`);
  if (treasury !== expectedTreasury) throw new Error(`bad treasury balance ${treasury}`);
  if (escrowBalance !== 0n) throw new Error(`escrow should be empty, got ${escrowBalance}`);

  console.log("Local race e2e passed");
  console.log(`  raceId: ${raceId}`);
  console.log(`  open:   ${openHash}`);
  console.log(`  lock:   ${lockHash}`);
  console.log(`  start:  ${startHash}`);
  console.log(`  settle: ${settleHash}`);
  console.log(`  winner balance:   ${formatUnits(challenger, 6)}`);
  console.log(`  loser balance:    ${formatUnits(opponent, 6)}`);
  console.log(`  treasury balance: ${formatUnits(treasury, 6)}`);
}

async function joinDriver(
  raceId: bigint,
  slot: 0 | 1,
  account: typeof LOCAL_ACCOUNTS.challenger | typeof LOCAL_ACCOUNTS.opponent
) {
  const wallet = createWalletClient({ account, chain, transport: http(deployment.rpcUrl) });
  const latestBlock = await publicClient.getBlock({ blockTag: "latest" });
  const deadline = latestBlock.timestamp + 3600n;
  const amount = stakeAmount + feeAmount;

  const tokenNonce = await publicClient.readContract({
    address: tokenAddress,
    abi: token.abi,
    functionName: "nonces",
    args: [account.address],
  }) as bigint;
  const permitSignature = await wallet.signTypedData({
    account,
    domain: {
      name: "Rover Race Dollar",
      version: "1",
      chainId: deployment.chainId,
      verifyingContract: tokenAddress,
    },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: {
      owner: account.address,
      spender: escrowAddress,
      value: amount,
      nonce: tokenNonce,
      deadline,
    },
  });

  const raceNonce = await publicClient.readContract({
    address: escrowAddress,
    abi: escrow.abi,
    functionName: "nonces",
    args: [account.address],
  }) as bigint;
  const entrySignature = await wallet.signTypedData({
    account,
    domain: {
      name: "RoverRace",
      version: "1",
      chainId: deployment.chainId,
      verifyingContract: escrowAddress,
    },
    types: {
      RaceEntry: [
        { name: "raceId", type: "uint256" },
        { name: "driver", type: "address" },
        { name: "slot", type: "uint8" },
        { name: "stakeAmount", type: "uint256" },
        { name: "feeAmount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "RaceEntry",
    message: {
      raceId,
      driver: account.address,
      slot,
      stakeAmount,
      feeAmount,
      nonce: raceNonce,
      deadline,
    },
  });

  const entry = parseSignature(entrySignature as Hex);
  const permit = parseSignature(permitSignature as Hex);
  const hash = await facilitatorWallet.writeContract({
    address: escrowAddress,
    abi: escrow.abi,
    functionName: "joinWithAuthorizationAndPermit",
    args: [
      raceId,
      account.address,
      slot,
      stakeAmount,
      feeAmount,
      deadline,
      Number(entry.v),
      entry.r,
      entry.s,
      deadline,
      Number(permit.v),
      permit.r,
      permit.s,
    ],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  joined slot ${slot}: ${hash}`);
}

function balance(address: Address) {
  return publicClient.readContract({
    address: tokenAddress,
    abi: token.abi,
    functionName: "balanceOf",
    args: [address],
  }) as Promise<bigint>;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
