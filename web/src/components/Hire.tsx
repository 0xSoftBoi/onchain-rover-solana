import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { x402Fetch } from "../lib/x402";
import { SIDECAR_URL, EXPLORER } from "../config";

/** Hire a rover for a task — pays the x402 fee in SPL-USDC, then runs the job. */
export default function Hire() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [robot, setRobot] = useState("guard");
  const [instruction, setInstruction] = useState("patrol the checkpoint");
  const [status, setStatus] = useState("");
  const [sig, setSig] = useState("");
  const [result, setResult] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function hire() {
    if (!publicKey) {
      setStatus("connect a wallet first");
      return;
    }
    setBusy(true);
    setStatus("requesting…");
    setResult(null);
    setSig("");
    try {
      const res = await x402Fetch(
        `${SIDECAR_URL}/task/${robot}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ instruction }),
        },
        connection,
        { publicKey, sendTransaction },
        (p) => {
          if (p.signature) {
            setSig(p.signature);
            setStatus(`paid ${p.amountUsdc} USDC ✓`);
          } else {
            setStatus(`paying ${p.amountUsdc} USDC…`);
          }
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as any)?.error ?? `HTTP ${res.status}`);
      setResult(body);
      setStatus("task accepted ✓");
    } catch (e) {
      setStatus(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Hire a rover</h2>
      <p className="muted">
        Pay over HTTP. The x402 gate quotes a price; your wallet sends SPL-USDC to
        the fleet treasury and the rover takes the job.
      </p>
      <label>
        Rover
        <select value={robot} onChange={(e) => setRobot(e.target.value)}>
          <option value="guard">guard</option>
          <option value="courier">courier</option>
        </select>
      </label>
      <label>
        Instruction
        <input value={instruction} onChange={(e) => setInstruction(e.target.value)} />
      </label>
      <button className="primary" disabled={busy || !publicKey} onClick={hire}>
        {busy ? "Working…" : "Hire (pay USDC)"}
      </button>
      {status && <p className="status">{status}</p>}
      {sig && (
        <p className="muted">
          payment: <a href={EXPLORER(sig)} target="_blank" rel="noreferrer">{sig.slice(0, 16)}…</a>
        </p>
      )}
      {result != null && <pre className="result">{JSON.stringify(result, null, 2)}</pre>}
    </section>
  );
}
