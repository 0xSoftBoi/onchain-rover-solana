"""Real on-device gemma3 negotiation driver — runs both roles' actual LLM
decisions on one robot (for a single-robot test). Prints the genuine reasoning
+ inference latency, and emits to the dashboard via reason.emit if SIDECAR_URL set.
"""
import time

import brain
import reason

print("=== REAL gemma3 negotiation (Orin Nano 4GB, on-device) ===\n")
t0 = time.time()
plan = brain.seller_reserve(2.00, 0.50, 0.6)
dt = time.time() - t0
print(f"[SELLER gemma3 {dt:.1f}s] reserve=${plan['reserve']} step=${plan['step']} [via {plan.get('via','?')}]")
print(f"           rationale: {plan['reason']}\n")
reason.ROLE = "guard"
reason.emit("reserve", f"reserve ${plan['reserve']}, step ${plan['step']} — {plan['reason']}", "plan")

budget = 1.25
hist = []
price = 2.00
step = plan["step"] or 0.25
reason.ROLE = "courier"
while price >= (plan["reserve"] - 1e-9):
    hist.append(round(price, 2))
    reason.ROLE = "guard"
    reason.emit("offer", f"${price:.2f} — going once. reserve ${plan['reserve']}.", "offer")
    t1 = time.time()
    reason.ROLE = "courier"
    d = brain.buyer_decision(price, budget, hist, 30)
    dt = time.time() - t1
    print(f"[BUYER gemma3 {dt:.1f}s] @${price:.2f} (budget ${budget}) -> {d['action'].upper()} [via {d.get('via','?')}]")
    print(f"          rationale: {d['reason']}")
    reason.emit("decide", f"${price:.2f} @ budget ${budget}: {d['action'].upper()} — {d['reason']}",
                "decision" if d["action"] == "accept" else "thought")
    if d["action"] == "accept":
        print(f"\n>>> DEAL: gemma3 buyer accepted at ${price:.2f}")
        reason.ROLE = "guard"
        reason.emit("settle", f"SOLD for ${price:.2f}. above reserve ✓", "decision")
        break
    price -= step

print(f"\ntotal wall time: {time.time() - t0:.1f}s")
