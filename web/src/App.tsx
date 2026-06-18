import { useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { CLUSTER, PROGRAM_ID, SIDECAR_URL } from "./config";
import Hire from "./components/Hire";
import Race from "./components/Race";
import Leaderboard from "./components/Leaderboard";

const TABS = ["Hire", "Race", "Leaderboard"] as const;
type Tab = (typeof TABS)[number];

export default function App() {
  const [tab, setTab] = useState<Tab>("Hire");
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          🏁 Clanker&nbsp;5000 <span className="net">{CLUSTER}</span>
        </div>
        <WalletMultiButton />
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? "tab active" : "tab"} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>

      <main className="panel">
        {tab === "Hire" && <Hire />}
        {tab === "Race" && <Race />}
        {tab === "Leaderboard" && <Leaderboard />}
      </main>

      <footer className="foot">
        <span>program <code>{PROGRAM_ID.toBase58().slice(0, 8)}…</code></span>
        <span>sidecar <code>{SIDECAR_URL}</code></span>
        <span>settled natively on Solana</span>
      </footer>
    </div>
  );
}
