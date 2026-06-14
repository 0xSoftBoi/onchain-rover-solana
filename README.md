# Clanker500 — ETHGlobal NYC 2026

### Give your AI agent a body.

Every agent at this hackathon is trapped behind a screen. We gave two of them
bodies: a fleet of **Waveshare UGV rovers (Jetson Orin NX)** that you **hire over
HTTP**, that earn an **on-chain reputation**, and whose **treasury only a human
can unlock with a Ledger**. Identity, payments, reputation, a labor market, and
human governance — every sponsor doing real work, with a robot on the table the
whole time.

```
   hire (x402/Arc) → robot acts → Gemini verifies → proof on Walrus
         ▲                                                │
    BigQuery rank ◄── ERC-8004 reputation ◄── requester rates the job
```

## The two acts
- **Act 1 — The Checkpoint:** a courier robot is hired, drives to the guard
  robot, they greet in speech then **switch to GibberLink** (data-over-sound);
  the guard verifies it **on-chain** (signed challenge + AgentBook human-backing +
  ERC-8004 + EventPass) → rejects it → the robots run a **Texas-auctioneer Dutch
  auction** to negotiate the pass price → pay + mint on Arc → admitted → proof to
  Walrus → reputation ticks up.
- **Act 2 — Clanker500 GP:** spectators **pay to pilot** the rovers ($1 x402 sessions,
  WebSocket joystick + deadman) and **bet USDC** on a fruit-obstacle drag race
  (parimutuel, **one bet per human via real World ID**), settled on-chain by the
  guard robot's Walrus-anchored finish photo.
- **Climax:** withdrawing the fleet's earnings **blocks** until a human
  clear-signs on a **Ledger** (ERC-7730: "Withdraw N USDC → recipient").

## Autonomy stack

Act 1 isn't a scripted handshake — it runs a state-of-the-art embodied-AI pipeline:
a **navigation foundation model** (NoMaD/ViNT) for control, an **embodied-reasoning
VLM** (RoboBrain 2.0) for semantic goals, and a **hierarchical multi-agent OS**
(RoboOS) for Guard⇄Courier coordination. Heavy models run off-board on a laptop GPU
(LeRobot async pattern); the Jetson runs only the real-time loop. Full write-up in
**[ROBOTICS.md](ROBOTICS.md)**.

```mermaid
flowchart TB
    task(["🗣️ Natural-language task"]) --> Brain
    subgraph CLOUD["☁️ Off-board · laptop GPU"]
      direction TB
      Brain["<b>RoboOS Master · Brain</b><br/>MLLM · task decomposition + routing"]
      RB["<b>brain_service.py</b><br/>RoboBrain 2.0 VLM<br/><i>where is the target?</i>"]
      NM["<b>nav_policy_server.py</b><br/>NoMaD / ViNT foundation model<br/><i>how do I steer?</i>"]
    end
    subgraph EDGE["🤖 On Jetson Orin NX"]
      direction TB
      AG["<b>agent.py · NomadNavigator</b><br/>Act 1 goal executor"]
      BR["<b>ros2_bridge.py</b><br/>/cmd_vel ⇄ /odom + TF"]
      RV["<b>rover.py</b><br/>ESP32 serial · drive · turn · bump"]
      MEM[("<b>roboos_memory.py</b><br/>Real-Time Shared Memory")]
    end
    Brain -->|subtasks| AG
    AG -->|"/think {img, goal}"| RB
    RB -->|"bearing + arrived"| AG
    AG -->|"/infer {img}"| NM
    NM -->|"steer (v, w)"| AG
    AG --> BR --> RV
    MEM <-->|"pose / state"| AG
    classDef cloud fill:#1e293b,stroke:#38bdf8,color:#e2e8f0;
    classDef edge fill:#14532d,stroke:#4ade80,color:#dcfce7;
    class Brain,RB,NM cloud;
    class AG,BR,RV,MEM edge;
```

### Act 1 — "The Checkpoint" end-to-end

```mermaid
sequenceDiagram
    autonumber
    participant B as 🧠 Brain (RoboOS)
    participant C as 🚚 Courier
    participant G as 🛡️ Guard
    participant M as 🗂️ Shared Memory
    participant X as ⛓️ x402 / Arc
    B->>C: navigate_to_target("checkpoint")
    activate C
    C->>C: NoMaD steer + RoboBrain bearing
    C->>M: update(action=at_checkpoint, pose)
    C->>G: announce_identity (signed challenge)
    deactivate C
    activate G
    G->>X: verify_agent (ERC-8004 + pass NFT)
    alt courier not verified
        G-->>C: deny + negotiate_price (Dutch auction)
        C->>X: pay_for_passage(agreed price)
    end
    G->>M: update(action=admitted)
    G->>G: admit (open checkpoint)
    deactivate G
    M-->>C: wait_for(guard, admitted) ✓
    C->>X: capture + Walrus proof + ERC-8004 feedback
```

## What's real (not mocked)
Every integration is real code — on-chain reads/writes or real signatures, no
fake data (`grep` the repo: no `Math.random` nullifiers, no stubs):
- **Identity** — robots sign challenges with their own EOA keys (verified by
  recovery); **live AgentBook reads** on World Chain for human-backing.
- **World ID** — real IDKit proof → World cloud verifier → real nullifier; every
  bet requires it (no proof = no bet).
- **ENS** — real on-chain registration on Sepolia (`roverfleet.eth` + guard/
  courier subnames + ENSIP-25 `agent-registration` records), resolved live via viem.
- **Payments / settlement** — real USDC transfers, EventPass mint, RaceMarket
  bets + settle on **Arc** (USDC-as-gas), via viem.
- **Reputation** — ERC-8004-compatible `ReputationRegistry` on Arc, requester
  rates the agent, feeds the leaderboard.
- **Proof** — finish/job photos stored on **Walrus** (real blobId, read-back
  verified), hash anchored on-chain.
- **Governance** — `Treasury` withdrawable only by the Ledger-held owner,
  clear-signed via an ERC-7730 descriptor. (Owner transferred to a real Ledger
  device; gas-funded so the device-signed withdrawal broadcasts.)
- **Decentralized verification (Chainlink CRE)** — a DON independently calls the
  robot's `GET /attest`, reaches **median consensus** on the verification score,
  and `writeReport`s the verdict to `AttestationConsumer` on Sepolia. The robot's
  self-claim never settles — `isVerified(job)` gates the mint/payment/reputation.
- **Custody (Privy)** — robot signing keys live in Privy's TEE, not on the host;
  `settle.pay()` signs through the enclave (`CUSTODY=privy`). **LIVE**: real Arc
  tx signed in the TEE (`0x6a9b8fdd…`).
- **Network reputation (BigQuery)** — ranks every on-chain agent by ERC-8004
  `NewFeedback` volume on the canonical mainnet registry (partition-pruned,
  dry-run guarded); the rover's local Arc reputation shown alongside.

## Deployed & live (verified on-chain)
| Thing | Address / id | Chain |
|---|---|---|
| EventPass | `0xb4fd7be40fb501433f403f8ecf46084075af4d77` | Arc 5042002 |
| ReputationRegistry | `0x876bdebd935696982a906ea51609b518d6902b68` | Arc |
| Treasury (Ledger-owned) | `0xfd15f8ffc6d82df92b77ded9a2b3535e23a86f43` | Arc |
| AttestationConsumer (CRE) | `0x0fdb04628c8821d2cd7ebd5cc2d23e1a46a077e3` | Sepolia |
| World ID app / RP | `app_2c9c29e4…` / `rp_8fe1202b…` (action `rover-gp-bet`) | World 4.0 (on-chain) |
| Privy wallets (TEE) | guard `0x4C726E70…` · courier `0x76f7c993…` | Arc |

Verified live: real USDC settlements on Arc (incl. **TEE-signed via Privy**),
EventPass minted, ERC-8004 feedback, a Treasury withdrawal gated by a **physical
Ledger** (owner transferred to the device + gas-funded), Walrus proofs read back
& hash-matched, and `GET /attest` serving a verified score for the CRE DON.

Things that still need a credential/login to *execute* (no mock fallback):
**`cre login`** + `simulate --broadcast` (writes the DON verdict — consumer is
already deployed and `/attest` serves 85/100), and **GCP creds** for the BigQuery
leaderboard. Everything else above is live.

## Layout
- `robot/` — Python on each Jetson. `api.py` (FastAPI :8000 + MJPEG `/stream` +
  pilot WS + heartbeat), `rover.py` (serial bridge), `agent.py` (LLM task loop),
  `camera.py` (shared capture), `perception.py` (Gemini seek + AprilTag),
  `negotiate.py` (Dutch auction), `finish_line.py` (race judge), `gibber.py`
  (GibberLink), `voice.py` (espeak), `proof.py` (Walrus), `checkpoint.py` (Act 1).
  `GET /attest` = the verifiable work score the Chainlink DON consumes.
- `sidecar/` — Node 22 + TS (:4021). x402 Gateway paid surface, `identity.ts`
  (signed challenge + AgentBook), `worldid.ts` (real verify, World ID 4.0 RP),
  `settle.ts` (Arc pay/mint/reputation/race/treasury, custody router), `privy.ts`
  (TEE-signed accounts), `cre.ts` (reads the DON verdict), `bigquery.ts` (network
  reputation), `ens.ts`. Scripts: `deploy-{eventpass,reputation,treasury,consumer}.ts`,
  `ledger-handover.ts`, `privy-provision.ts`, `register-ens.ts`, `go-live.ts`.
- `sidecar/public/` — **`wall.html`** the FLEET COMMAND master wall (cinematic
  big-screen view: cognition stream, on-chain ledger, holo dials, Walrus proof,
  CRE oracle), `index.html` mission control, `broadcast.html`, `race.html`
  (betting), `pilot.html` (joystick), `ledger.html` (clear-sign treasury).
- `contracts/` — `EventPass.sol`, `ReputationRegistry.sol`, `RaceMarket.sol`,
  `Treasury.sol`, `AttestationConsumer.sol`, `erc7730/treasury.json`.
- `cre-workflow/` — Chainlink CRE workflow (`main.ts` + `config.json` + `SETUP.md`).
- `DEMO_RUNBOOK.md` — the timed 3-minute script.
  `docs/HARDWARE_BRINGUP.md` — cold-boot rover readiness runbook.
  `docs/JETSON_BRIDGE.md` — bridge spec.
- `ROBOTICS.md` — autonomy stack (NoMaD nav foundation model, RoboBrain brain, RoboOS multi-agent).

## Run
```bash
# each Jetson (stop the stock app first):
pgrep -f '[a]pp.py' | xargs -r kill
ROBOT_ROLE=guard SIDECAR_URL=http://<laptop-ip>:4021 \
  ~/ugv_jetson/ugv-env/bin/python -m uvicorn api:app --host 0.0.0.0 --port 8000

# laptop:
cd sidecar && npm i && npm run build:ledger
node --import tsx src/preflight.ts      # readiness board
node --import tsx src/index.ts          # sidecar + dashboards on :4021

# once funded (Circle booth / faucets):
npx tsx src/register-ens.ts             # real ENS on Sepolia
npx tsx src/go-live.ts                  # deploy contracts + run the full on-chain loop
```

```bash
# deep integrations (once their creds/funds are in .env):
npx tsx src/deploy-consumer.ts          # AttestationConsumer → Sepolia (CRE)
npx tsx src/privy-provision.ts          # Privy TEE wallets; set CUSTODY=privy
npx tsx src/ledger-handover.ts 0x<dev>  # treasury owner → your Ledger + gas
# CRE: see cre-workflow/SETUP.md (cre login + simulate --broadcast)
```

Demo at `http://<laptop>:4021/wall.html` (the big-screen FLEET COMMAND wall) ·
`/` (mission control) · `/race.html` · `/pilot.html` · `/ledger.html`.
