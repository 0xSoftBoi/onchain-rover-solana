import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  keccak256,
  parseSignature,
  parseUnits,
  toBytes,
  type Hex,
} from "viem";

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();

describe("RaceEscrow", async () => {
  async function deployFixture() {
    const [deployer, challenger, opponent, facilitator, treasury] =
      await viem.getWalletClients();

    const token = await viem.deployContract(
      "MockRaceToken",
      [deployer.account.address],
      { client: { wallet: deployer } }
    );

    const escrow = await viem.deployContract(
      "RaceEscrow",
      [
        token.address,
        treasury.account.address,
        deployer.account.address,
        facilitator.account.address,
      ],
      { client: { wallet: deployer } }
    );

    await publicClient.waitForTransactionReceipt({
      hash: await token.write.mint([challenger.account.address, parseUnits("1000", 6)]),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await token.write.mint([opponent.account.address, parseUnits("1000", 6)]),
    });

    const escrowAsFacilitator = await viem.getContractAt("RaceEscrow", escrow.address, {
      client: { wallet: facilitator },
    });

    return { token, escrow, escrowAsFacilitator, deployer, challenger, opponent, facilitator, treasury };
  }

  it("settles a two-driver race and accounts for treasury fees", async () => {
    const { token, escrowAsFacilitator, challenger, opponent, treasury } = await deployFixture();
    const raceId = await escrowAsFacilitator.read.nextRaceId();
    const stakeAmount = parseUnits("1", 6);
    const feeAmount = parseUnits("0.25", 6);

    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.openRace([
        keccak256(toBytes("round-a")),
        stakeAmount,
        feeAmount,
      ]),
    });

    const challengerAuth = await signEntryAndPermit({
      token,
      escrow: escrowAsFacilitator,
      raceId,
      driver: challenger,
      slot: 0,
      stakeAmount,
      feeAmount,
    });
    await joinWithPermit(escrowAsFacilitator, raceId, challenger.account.address, 0, stakeAmount, feeAmount, challengerAuth);

    const opponentAuth = await signEntryAndPermit({
      token,
      escrow: escrowAsFacilitator,
      raceId,
      driver: opponent,
      slot: 1,
      stakeAmount,
      feeAmount,
    });
    await joinWithPermit(escrowAsFacilitator, raceId, opponent.account.address, 1, stakeAmount, feeAmount, opponentAuth);

    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.lockRace([raceId]),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.startRace([raceId]),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.finishRace([raceId, 0, keccak256(toBytes("finish"))]),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.settleRace([raceId]),
    });

    assert.equal(await token.read.balanceOf([challenger.account.address]), parseUnits("1000.75", 6));
    assert.equal(await token.read.balanceOf([opponent.account.address]), parseUnits("998.75", 6));
    assert.equal(await token.read.balanceOf([treasury.account.address]), parseUnits("0.5", 6));
    assert.equal(await token.read.balanceOf([escrowAsFacilitator.address]), 0n);
  });

  it("rejects replayed race entry authorizations", async () => {
    const { token, escrowAsFacilitator, challenger } = await deployFixture();
    const raceId = await escrowAsFacilitator.read.nextRaceId();
    const stakeAmount = parseUnits("1", 6);
    const feeAmount = parseUnits("0.25", 6);

    await publicClient.waitForTransactionReceipt({
      hash: await escrowAsFacilitator.write.openRace([
        keccak256(toBytes("round-b")),
        stakeAmount,
        feeAmount,
      ]),
    });

    const auth = await signEntryAndPermit({
      token,
      escrow: escrowAsFacilitator,
      raceId,
      driver: challenger,
      slot: 0,
      stakeAmount,
      feeAmount,
    });
    await joinWithPermit(escrowAsFacilitator, raceId, challenger.account.address, 0, stakeAmount, feeAmount, auth);

    await assert.rejects(() =>
      joinWithPermit(escrowAsFacilitator, raceId, challenger.account.address, 1, stakeAmount, feeAmount, auth)
    );
  });
});

async function signEntryAndPermit(opts: {
  token: any;
  escrow: any;
  raceId: bigint;
  driver: any;
  slot: 0 | 1;
  stakeAmount: bigint;
  feeAmount: bigint;
}) {
  const latestBlock = await publicClient.getBlock({ blockTag: "latest" });
  const deadline = latestBlock.timestamp + 3600n;
  const totalAmount = opts.stakeAmount + opts.feeAmount;
  const tokenNonce = await opts.token.read.nonces([opts.driver.account.address]);
  const raceNonce = await opts.escrow.read.nonces([opts.driver.account.address]);
  const tokenName = await opts.token.read.name();
  const chainId = await publicClient.getChainId();

  const permitSignature = await opts.driver.signTypedData({
    account: opts.driver.account,
    domain: {
      name: tokenName,
      version: "1",
      chainId,
      verifyingContract: opts.token.address,
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
      owner: opts.driver.account.address,
      spender: opts.escrow.address,
      value: totalAmount,
      nonce: tokenNonce,
      deadline,
    },
  });

  const entrySignature = await opts.driver.signTypedData({
    account: opts.driver.account,
    domain: {
      name: "RoverRace",
      version: "1",
      chainId,
      verifyingContract: opts.escrow.address,
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
      raceId: opts.raceId,
      driver: opts.driver.account.address,
      slot: opts.slot,
      stakeAmount: opts.stakeAmount,
      feeAmount: opts.feeAmount,
      nonce: raceNonce,
      deadline,
    },
  });

  return {
    deadline,
    entry: parseSignature(entrySignature as Hex),
    permit: parseSignature(permitSignature as Hex),
  };
}

async function joinWithPermit(
  escrow: any,
  raceId: bigint,
  driver: Hex,
  slot: 0 | 1,
  stakeAmount: bigint,
  feeAmount: bigint,
  auth: Awaited<ReturnType<typeof signEntryAndPermit>>
) {
  const hash = await escrow.write.joinWithAuthorizationAndPermit([
    raceId,
    driver,
    slot,
    stakeAmount,
    feeAmount,
    auth.deadline,
    Number(auth.entry.v),
    auth.entry.r,
    auth.entry.s,
    auth.deadline,
    Number(auth.permit.v),
    auth.permit.r,
    auth.permit.s,
  ]);
  await publicClient.waitForTransactionReceipt({ hash });
}
