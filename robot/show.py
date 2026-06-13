"""
The full show — hands-free, timed run of Act 1 + Act 2 + climax for rehearsal
and the backup video. Narrates each beat to the console (screen-record this
alongside the robots), never crashes (reuses checkpoint's resilient helpers),
and degrades gracefully when funds/keys aren't in yet.

    SIDECAR_URL=http://localhost:4021 python show.py
    PACE=0.5 python show.py          # faster for quick rehearsals
"""
import os
import time

import checkpoint as cp   # resilient call/beat/say/discover + Act 1 run()

PACE = float(os.environ.get("PACE", "1.0"))   # narration pacing multiplier


def narrate(line, hold=2.0):
    print(f"\n🎬 {line}")
    time.sleep(hold * PACE)


def act2():
    """Rover GP: open betting -> bets -> 3-2-1-GO -> race -> finish + settle."""
    S, G, C = cp.SIDECAR, cp.GUARD, cp.COURIER
    narrate("ACT 2 — ROVER GP. The crowd takes over.", 2.5)

    cp.beat("open race + betting", "POST", f"{S}/race/open")
    cp.say(G, "Place your bets! Two rovers, one drag race.", voice="texas")
    narrate("Spectators scan the QR, verify with World ID, bet USDC. "
            "(bets require a real World ID proof — no proof, no bet.)", 3)

    cp.beat("lock bets", "POST", f"{S}/race/arm")
    narrate("Bets locked. On your marks…", 1.5)
    for n in ("3", "2", "1", "GO!"):
        print(f"   {n}")
        cp.say(G if n == "GO!" else C, n)
        time.sleep(0.7 * PACE)
    cp.beat("start race", "POST", f"{S}/race/start")
    narrate("They're off — pilots drive, fruit obstacles on the strip!", 3)

    # the guard's finish camera calls the winner; settle anchors the proof
    cp.beat("guard judges finish + settle on Arc", "POST", f"{S}/race/finish",
            json_body={"winner": "courier"})
    cp.say(G, "Courier takes it!", voice="texas")
    narrate("The GUARD robot is the race oracle — its finish photo goes to "
            "Walrus and settles the parimutuel pool on-chain.", 3)
    cp.beat("final odds / pool", "GET", f"{S}/race/odds")


def climax():
    narrate("CLIMAX — the robots earned this money autonomously. "
            "Moving it takes a HUMAN.", 3)
    ok, info = cp.call("GET", f"{cp.SIDECAR}/treasury/info", timeout=8)
    print(f"   treasury: {info}")
    narrate("Operator hits Withdraw → it BLOCKS → a Ledger lights up showing the "
            "clear-signed intent: 'Withdraw N USDC → recipient'. "
            "Human presses confirm. (runs in /ledger.html)", 3)
    cp.say(cp.GUARD, "Autonomous robots. Human-held keys.")


def main():
    print("=" * 52)
    print("  THE ONCHAIN ROVER — FULL SHOW (hands-free)")
    print("=" * 52)
    cp.discover()                 # gate: aborts cleanly if a participant is down
    narrate("ACT 1 — THE CHECKPOINT. A software agent hires the courier.", 2.5)
    cp.run()                      # Act 1 (its own beat summary)
    act2()
    climax()
    print("\n" + "=" * 52)
    cp.summary()
    print("  🎬 SHOW COMPLETE")


if __name__ == "__main__":
    main()
