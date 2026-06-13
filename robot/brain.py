"""
Negotiation reasoning — the robots actually THINK, via the onboard LLM (Ollama,
already running on the Jetson). Not a while-loop: each side reasons about price,
budget, demand, and the observed price trajectory, and explains its move.

Returns a structured decision + a one-line rationale (spoken/logged for the
demo). Deterministic fallback if Ollama is slow/unavailable so the demo never
stalls — but the default path is real local inference.
"""
import json
import os

import requests

OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434/api/generate")
MODEL = os.environ.get("NEGOTIATE_MODEL", "gemma3:1b")


def _ask(prompt, timeout=12):
    r = requests.post(OLLAMA, json={
        "model": MODEL, "prompt": prompt, "stream": False,
        "format": "json", "options": {"temperature": 0.4, "num_predict": 120},
    }, timeout=timeout)
    return json.loads(r.json()["response"])


def buyer_decision(price, budget, history, secs_left):
    """Buyer reasons: ACCEPT now or WAIT for a lower price? history = prices seen
    so far (descending). Real trade-off: waiting may get a better price, but the
    item could be taken or the auction could end. Returns {action, reason}."""
    if price > budget:
        return {"action": "wait", "reason": f"{price:.2f} is over my {budget:.2f} budget"}
    drop = (history[-2] - history[-1]) if len(history) >= 2 else 0.0
    prompt = (
        f"You are a buyer agent in a Dutch auction (price falls each round). "
        f"Current price ${price:.2f}. Your max budget ${budget:.2f}. "
        f"Price history (high->low): {history}. Last drop ${drop:.2f}/round. "
        f"~{secs_left:.0f}s left. If you WAIT you might pay less, but a rival "
        f"buyer could take it or the auction could close at the floor. "
        f'Decide. Respond JSON: {{"action":"accept"|"wait","reason":"<8 words>"}}.')
    try:
        d = _ask(prompt)
        action = "accept" if str(d.get("action", "")).lower().startswith("a") else "wait"
        return {"action": action, "reason": str(d.get("reason", ""))[:60]}
    except Exception:
        # fallback: accept once we're within ~one decrement of budget or low on time
        margin = budget - price
        if margin <= drop or secs_left < 8:
            return {"action": "accept", "reason": "good price, low risk of waiting"}
        return {"action": "wait", "reason": "price still falling, hold"}


def seller_reserve(start, floor, demand):
    """Seller reasons about a reserve price given demand (0..1). High demand =>
    hold value (higher reserve, slower drops); low demand => move it. Returns
    {reserve, step, reason}."""
    prompt = (
        f"You are a seller agent running a Dutch auction for an event pass. "
        f"Start price ${start:.2f}, hard floor ${floor:.2f}. Demand signal "
        f"{demand:.2f} (0=nobody waiting, 1=crowd). Pick a reserve price (won't "
        f"sell below) and a per-round price step. High demand: hold value, small "
        f'steps. Low demand: move it. JSON: {{"reserve":<num>,"step":<num>,"reason":"<8 words>"}}.')
    try:
        d = _ask(prompt)
        reserve = max(floor, min(start, float(d.get("reserve", floor))))
        step = max(0.05, min(start - floor or 0.25, float(d.get("step", 0.25))))
        return {"reserve": round(reserve, 2), "step": round(step, 2),
                "reason": str(d.get("reason", ""))[:60]}
    except Exception:
        reserve = floor + (start - floor) * demand * 0.5
        return {"reserve": round(reserve, 2), "step": 0.25,
                "reason": "demand-scaled reserve"}
