# agent-client — the software agent that hires the physical rover

`rover_hirer.py` is a Fetch.ai uAgent (ASI). Another agent (or a chat message)
sends it a `HireRequest{task}`; it hires the rover over **x402 on Arc** via the
sidecar's paid `/task/:rover` endpoint and replies with the **proof-of-action**
(Walrus blobId + sha256). Agent-to-agent commerce with a real machine.

```bash
pip install -r requirements.txt
SIDECAR_URL=http://<laptop>:4021 ROVER=courier python rover_hirer.py
# set AGENTVERSE_KEY to publish it on Agentverse (discoverable by other agents)
```

Hiring spends real testnet USDC once the sidecar payer wallet is funded; until
then `/task` returns 402 and the agent reports "needs Arc USDC to hire" (no mock).
