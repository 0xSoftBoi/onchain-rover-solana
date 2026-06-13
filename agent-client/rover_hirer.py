"""
The money shot: a SOFTWARE agent that hires the PHYSICAL rover over HTTP.

A Fetch.ai uAgent (ASI) that, on a chat request like "get eyes on booth 12",
discovers the rover fleet, hires a rover by paying over x402 on Arc (via the
sidecar's paid /task endpoint), and returns the cryptographic proof-of-action
(Walrus blobId + sha256). This is agent-to-agent commerce with a real machine on
the other end.

Run:
    pip install uagents requests
    SIDECAR_URL=http://<laptop>:4021 ROVER=courier python rover_hirer.py
Publishes to Agentverse when AGENTVERSE_KEY is set (so other agents can find it);
otherwise runs locally. Hiring uses the REAL x402-gated /task endpoint — it
spends real testnet USDC once the sidecar's payer wallet is funded.
"""
from __future__ import annotations

import os

import requests
from uagents import Agent, Context, Model
from uagents.setup import fund_agent_if_low

SIDECAR = os.environ.get("SIDECAR_URL", "http://127.0.0.1:4021")
ROVER = os.environ.get("ROVER", "courier")
AGENTVERSE_KEY = os.environ.get("AGENTVERSE_KEY")

agent = Agent(
    name="rover-hirer",
    seed=os.environ.get("AGENT_SEED", "onchain-rover-hirer-seed-v1"),
    port=8100,
    endpoint=["http://127.0.0.1:8100/submit"],
    mailbox=AGENTVERSE_KEY,  # None -> local only; set -> discoverable on Agentverse
)


class HireRequest(Model):
    task: str            # natural-language job, e.g. "get eyes on booth 12"
    rover: str = ROVER


class HireResult(Model):
    ok: bool
    rover: str
    payment_tx: str | None = None
    proof_blob: str | None = None
    proof_sha256: str | None = None
    detail: str = ""


def hire_rover(task: str, rover: str) -> HireResult:
    """Hire the physical rover over x402. The sidecar's /task/:rover is
    payment-gated; on success it runs the rover and returns the proof."""
    try:
        r = requests.post(f"{SIDECAR}/task/{rover}",
                          json={"task": task}, timeout=120)
        if r.status_code == 402:
            return HireResult(ok=False, rover=rover,
                              detail="402 — payer wallet needs Arc USDC to hire")
        r.raise_for_status()
        body = r.json()
        proof = (body.get("result") or {}).get("proof", {})
        return HireResult(
            ok=True, rover=rover,
            payment_tx=(body.get("payment") or {}).get("transaction"),
            proof_blob=proof.get("blobId"), proof_sha256=proof.get("photo_sha256"),
            detail="hired; proof anchored on Walrus")
    except Exception as e:
        return HireResult(ok=False, rover=rover, detail=str(e)[:120])


@agent.on_message(model=HireRequest, replies=HireResult)
async def on_hire(ctx: Context, sender: str, msg: HireRequest):
    ctx.logger.info(f"{sender} wants to hire {msg.rover}: {msg.task}")
    result = hire_rover(msg.task, msg.rover)
    ctx.logger.info(f"result: {result.detail}")
    await ctx.send(sender, result)


@agent.on_event("startup")
async def startup(ctx: Context):
    ctx.logger.info(f"rover-hirer up · address {agent.address}")
    ctx.logger.info(f"hiring '{ROVER}' via {SIDECAR}/task/{ROVER} (x402 on Arc)")
    if AGENTVERSE_KEY:
        ctx.logger.info("published to Agentverse — discoverable by other agents")


if __name__ == "__main__":
    try:
        fund_agent_if_low(agent.wallet.address())
    except Exception:
        pass
    agent.run()
