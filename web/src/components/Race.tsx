import { useEffect, useState } from "react";
import { SIDECAR_URL } from "../config";

/** Live race view — polls the sidecar race state + parimutuel odds. */
export default function Race() {
  const [state, setState] = useState<any>(null);
  const [odds, setOdds] = useState<any>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [s, o] = await Promise.all([
          fetch(`${SIDECAR_URL}/race/state`).then((r) => r.json()),
          fetch(`${SIDECAR_URL}/race/odds`).then((r) => r.json()).catch(() => null),
        ]);
        if (alive) {
          setState(s);
          setOdds(o);
          setErr("");
        }
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <section className="card">
      <h2>Race</h2>
      <p className="muted">
        Live state from the sidecar. Settlement (open → join → start → finish →
        settle) runs through the clanker5000 program; parimutuel bets are
        one-human-one-bet via a World ID nullifier.
      </p>
      {err && <p className="status">sidecar offline: {err}</p>}
      <div className="grid2">
        <div>
          <h3>State</h3>
          <pre className="result">{state ? JSON.stringify(state, null, 2) : "…"}</pre>
        </div>
        <div>
          <h3>Odds</h3>
          <pre className="result">{odds ? JSON.stringify(odds, null, 2) : "—"}</pre>
        </div>
      </div>
    </section>
  );
}
