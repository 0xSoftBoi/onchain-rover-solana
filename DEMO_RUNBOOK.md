# The Onchain Rover — 3-Minute Demo Runbook

**Hard stop: 3:00.** Rehearse to **2:40** (live robots always cost ~20s). Two
people: **Narrator** (talks, never touches a keyboard) + **Driver** (all clicks,
watches the timer, calls cuts at 1:30 and 2:30).

> Thesis line (memorize): *"Every agent at this hackathon is trapped behind a
> screen. We gave them a body — robots you hire over HTTP, that earn an on-chain
> reputation, and whose treasury only a human can unlock."*

---

## Screens (open as browser tabs before judges arrive — sidecar on :4021)
| Tab | URL | Used in beat |
|---|---|---|
| **Mission Control** | `http://<laptop>:4021/` | 0:00 open, 0:40 settle |
| **Rover GP (race+bet)** | `http://<laptop>:4021/race.html` | 1:00 race |
| **Pilot** (judge's phone) | `http://<laptop>:4021/pilot.html?robot=courier` | 1:00 drive |
| **Treasury / Ledger** | `http://<laptop>:4021/ledger.html` | 2:10 climax |

Live camera feeds are embedded in Mission Control and Rover GP (robot `/stream`).

---

## PRE-FLIGHT (before judges arrive — 15 min, do in order)
1. **Robots on** + on venue WiFi. Confirm IPs (drift on DHCP):
   `curl -s http://172.16.1.29:8000/health` (guard) and `172.16.0.105` (courier).
   If an IP changed, update `.env` `GUARD_URL`/`COURIER_URL` + `PEER_ROBOT_URL`.
2. **Kill the camera thief** on guard (it respawns): `ssh jetson@<guard> 'pgrep -f "[c]apture_images" && sudo pkill -9 -f "[c]apture_images"'`.
3. **Speaker volume** maxed; do one voice test: `curl -X POST http://<guard>:8000/say -d '{"text":"check"}' -H 'Content-Type: application/json'`.
4. **Funds** (done earlier in the day via Circle booth): guard + courier + treasury
   have Arc USDC. Verify on Mission Control balances row (not $0).
5. **Deploy contracts** (once, if not already): `cd sidecar && npx tsx src/go-live.ts`
   — deploys EventPass + ReputationRegistry + Treasury, runs one auction, prints
   addresses. Paste `EVENTPASS_ADDRESS` / `REPUTATION_ADDRESS` / `TREASURY_CONTRACT`
   into `.env`, restart sidecar. Fund the Treasury contract with a few USDC so the
   withdrawal beat has a balance.
6. **Ledger**: plug in, unlock, open the **Ethereum app**, in Chrome hit
   `/ledger.html` → **Connect** once to pre-authorize WebHID. Set `.env`
   `LEDGER_ADDRESS` = the device address and `TREASURY_CONTRACT` owner to it
   (so only the device can withdraw). Grab `LEDGER_ORIGIN_TOKEN` from the Ledger
   booth for full clear-signing.
7. **Arena**: tape a ~1.5m drag strip; fruit obstacles (apple/orange) past the
   midpoint; AprilTag (36h11) on each rover nose; finish-line camera (laptop
   webcam or guard) aimed across the line.
8. **Shill bet** placed on Rover GP so odds aren't empty: tap one bet chip.
9. **Backup video** of the full run open in a tab. **Travel router** so robots +
   laptop are LAN-local; only chain RPC leaves the LAN.

---

## THE 3:00 SCRIPT (talk *over* the action — never wait in silence)

### 0:00–0:20 · Thesis + the fleet is alive  → **Mission Control**
- **Driver:** already on Mission Control. Point at the two live feeds, ENS names
  (`guard.rover.eth` / `courier.rover.eth`), battery, and the **ERC-8004
  reputation** panel.
- **Narrator:** the thesis line. *"These two are real on-chain agents — ENS
  identity, a reputation score, a USDC balance, and a human who stands behind
  them."*

### 0:20–1:00 · The Texas auction (the memorable beat)  → robots' speakers
- **Driver:** click **▶ Run live auction + settle on-chain**.
- The **guard drawls** *"Awright folks, step right up… do I hear two dollars…
  one seventy-five… one fifty…"*; the **courier** cuts in *"Deal, one twenty-five."*
  **Let the room hear it — pause your narration during the haggle.**
- **Narrator (as it settles):** *"That price was negotiated live between two
  robots over sound. Now it settles for real."* The dashboard shows the **payment
  tx** and the **EventPass mint** on Arc (arcscan links), and the **reputation
  score ticks up** — the flywheel: job → proof → reputation → rank.

### 1:00–1:40 · Rover GP — the crowd drives  → **Pilot** (judge's phone) + **Rover GP** tab
- **Driver:** hand the judge a phone already on `/pilot.html` (pre-authorized).
  Switch the laptop to the **Rover GP** tab (dual feeds + live odds).
- **Judge drives the courier** ~15s around an obstacle.
- **Narrator:** *"$1 over x402 buys a 120-second pilot session — 250ms video, and
  a deadman that stops the robot the instant the money or the connection stops.
  Spectators bet USDC on the race; one bet per human, enforced by World ID."*

### 1:40–2:10 · The drag race + on-chain settle  → **Rover GP**
- **Driver:** click **③ 3·2·1·GO**. Both rovers sprint the strip (Narrator + Driver
  pilot, or two judges). First AprilTag across the line → **guard judges the
  winner**; click the winner button.
- **Narrator:** *"The guard robot is the race oracle — its camera calls the
  finish, and that result settles the parimutuel pool on Arc. A robot settling
  bets on a robot race."*

### 2:10–2:50 · Governance climax — the Ledger  → **Treasury / Ledger**
- **Driver:** switch to `/ledger.html`. Treasury shows the fleet's accumulated
  USDC. Try to withdraw → enter recipient + amount → **Withdraw**.
- The **Ledger lights up**; the device screen shows the **clear-signed intent**
  (ERC-7730): *"Withdraw N USDC → recipient."*
- **Narrator:** *"The robots earn autonomously — but they can't touch their own
  treasury. Moving the money takes a human, physically, on hardware."*
- **Judge/teammate presses confirm on the device** → tx broadcasts → arcscan link.

### 2:50–3:00 · Close
- **Narrator:** *"Identity, payments, reputation, a labor market, and human
  governance — every sponsor doing real work, and a robot on the table the whole
  time. That's the agent economy with a body."*

---

## FALLBACKS (decide before, narrate as if intended — never debug live)
- **Robot IP drifted / API down:** `ssh jetson@<ip> 'sudo fuser -k 8000/tcp; cd ~/ugv_jetson && setsid nohup env ROBOT_ROLE=<role> PEER_ROBOT_URL=http://<peer>:8000 ./ugv-env/bin/python -m uvicorn api:app --host 0.0.0.0 --port 8000 >/tmp/api.log 2>&1 </dev/null &'`.
- **GibberLink garbled by room noise:** it auto-mirrors over the network — say
  *"too loud in here, they fell back to the network — same signed handshake."*
- **Courier stalls mid-race:** guard is the hot spare; run the auction beat
  stationary. The auction + Ledger beats need no driving.
- **Chain RPC hiccup / tx slow:** *"Arc settles in ~2s, here's the confirmation"*
  — if it lags past 5s, move on; the tx link appears on the dashboard when it lands.
- **Ledger won't connect (WebHID):** must be Chrome/Edge, device unlocked,
  Ethereum app open, page over localhost/HTTPS. If it fails, show the **backup
  video** of the signing — do NOT fumble the device live.
- **Total chain failure:** the whole story is in the **backup video**; pivot to it
  and keep narrating. The live robots + auction audio still carry the room.

## Cut order if running long (drop from the bottom)
Ledger climax stays (it's the closer) → drop the *live* drag race, keep the judge
*driving* → drop the pilot hand-off, keep auction + settle + reputation + Ledger.
**Never cut:** the Texas auction (audible, reliable) and the Ledger climax.
