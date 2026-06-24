import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { agentRanking, type AgentRank } from "../lib/program";
import { EXPLORER } from "../config";

/** Fleet reputation, read straight from the clanker5000 reputation accounts. */
export default function Leaderboard() {
  const { connection } = useConnection();
  const [rows, setRows] = useState<AgentRank[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    agentRanking(connection)
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setErr((e as Error).message));
    return () => {
      alive = false;
    };
  }, [connection]);

  return (
    <section className="card">
      <h2>World Standings · ERC-8004</h2>
      <p className="muted">
        Ranked on-chain from the program's ERC-8004-style reputation accounts
        (jobs completed, then average score) · No indexer — read directly via getProgramAccounts.
      </p>
      {err && <p className="status status-err">⚠ read failed: {err} (is the program deployed on this cluster?)</p>}
      {!rows && !err && <p className="muted" style={{ marginTop: 14 }}>Querying the grid…</p>}
      {rows && rows.length === 0 && <p className="muted" style={{ marginTop: 14 }}>No drivers registered yet. Green flag pending.</p>}
      {rows && rows.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Driver</th>
              <th>Owner</th>
              <th>Jobs</th>
              <th>Avg Score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.agentId}>
                <td>{i + 1}</td>
                <td>{r.agentId}</td>
                <td>
                  <a href={EXPLORER(r.owner, "address")} target="_blank" rel="noreferrer">
                    {r.owner.slice(0, 8)}…
                  </a>
                </td>
                <td>{r.jobs}</td>
                <td>{r.avgScore == null ? "—" : r.avgScore.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
