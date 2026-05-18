import { useCallback, useEffect, useRef, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  connectPhantom,
  createContest,
  getDevJudge,
  getProgram,
  isAlreadyProcessed as isAlreadyProcessedShared,
  joinContest,
  settleWithDevJudge,
  type PhantomWallet,
} from "../../lib/contest";

const STATUS_LABELS = ["Open", "Active", "Settled", "Refunding"];

type ContestData = {
  creator: PublicKey;
  judge: PublicKey;
  wager: BN;
  maxPlayers: number;
  duration: number;
  startTime: BN;
  deadline: BN;
  status: number;
  winner: PublicKey;
  players: PublicKey[];
  finalScores: number[];
};

export default function SolanaTest() {
  const [wallet, setWallet] = useState<PhantomWallet | null>(null);
  const [contestAddr, setContestAddr] = useState("");
  const [contestData, setContestData] = useState<ContestData | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  const append = useCallback((msg: string) => {
    setLog((prev) => [...prev.slice(-30), `${new Date().toLocaleTimeString()}  ${msg}`]);
  }, []);

  const program = wallet ? getProgram(wallet) : null;

  const isAlreadyProcessed = isAlreadyProcessedShared;

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const refresh = useCallback(
    async (addr?: string) => {
      if (!program) return;
      const target = addr ?? contestAddr;
      if (!target) return;
      try {
        const pk = new PublicKey(target);
        // @ts-expect-error — anchor's account access is dynamic
        const data = (await program.account.contest.fetch(pk)) as ContestData;
        setContestData(data);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg.includes("Account does not exist")) {
          // PDA was closed (claim succeeded, or refunded) — stop polling quietly.
          setContestData(null);
          stopPolling();
        } else {
          append(`fetch failed: ${msg}`);
        }
      }
    },
    [program, contestAddr, append, stopPolling],
  );

  useEffect(() => {
    if (!contestAddr || !program) return;
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => refresh(), 2000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [contestAddr, program, refresh]);

  async function handleConnect() {
    try {
      const w = await connectPhantom();
      setWallet(w);
      append(`connected ${w.publicKey.toBase58()}`);
    } catch (e: any) {
      append(`connect failed: ${e.message ?? e}`);
    }
  }

  async function handleCreate() {
    if (!program || !wallet || busy) return;
    const durationSecs = Number(prompt("Duration (seconds)?", "30") ?? "30");
    const maxPlayers = Number(prompt("Max players (2-8)?", "2") ?? "2");
    const wagerSol = Number(prompt("Wager (SOL)?", "0.01") ?? "0.01");
    setBusy(true);
    try {
      const judgePk = getDevJudge().publicKey;
      // 8 random bytes → unique contest_id, avoids ms-level collisions if you double-click.
      const idBytes = new Uint8Array(8);
      crypto.getRandomValues(idBytes);
      const contestId = new BN(idBytes);
      append(`creating contest (duration=${durationSecs}s, max=${maxPlayers}, wager=${wagerSol} SOL)...`);
      const { signature, contestPda } = await createContest(program, {
        contestId,
        wagerLamports: new BN(Math.round(wagerSol * LAMPORTS_PER_SOL)),
        maxPlayers,
        durationSecs,
        judge: judgePk,
      });
      append(`created @ ${contestPda.toBase58()}  sig=${signature.slice(0, 12)}…`);
      setContestAddr(contestPda.toBase58());
      await refresh(contestPda.toBase58());
    } catch (e: any) {
      if (isAlreadyProcessed(e)) {
        append(`created (tx retried; first send landed) — check explorer for PDA`);
      } else {
        append(`create failed: ${e.message ?? e}`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleJoin() {
    if (!program || !contestAddr || busy) return;
    setBusy(true);
    try {
      const sig = await joinContest(program, new PublicKey(contestAddr));
      append(`joined  sig=${sig.slice(0, 12)}…`);
      await refresh();
    } catch (e: any) {
      if (isAlreadyProcessed(e)) {
        append(`joined (tx retried; first send landed)`);
        await refresh();
      } else {
        append(`join failed: ${e.message ?? e}`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSettle() {
    if (!program || !contestData || !contestAddr || busy) return;
    const defaultScores = contestData.players.map(() => 0).join(",");
    const raw = prompt(
      `Scores (comma-separated, ${contestData.players.length} values)?`,
      defaultScores,
    );
    if (!raw) return;
    const scores = raw.split(",").map((s) => Number(s.trim()));
    if (scores.length !== contestData.players.length || scores.some(isNaN)) {
      append(`bad scores input: ${raw}`);
      return;
    }
    // Compute winner from scores locally (matches program's argmax + lowest-index tiebreak).
    let winnerIdx = 0;
    for (let i = 1; i < scores.length; i++) {
      if (scores[i] > scores[winnerIdx]) winnerIdx = i;
    }
    const winnerPk = contestData.players[winnerIdx];

    setBusy(true);
    try {
      const sig = await settleWithDevJudge(
        program,
        new PublicKey(contestAddr),
        scores,
        winnerPk,
      );
      append(`settled — paid to ${winnerPk.toBase58().slice(0, 12)}…  sig=${sig.slice(0, 12)}…`);
      // settle also closes the PDA; polling will see "Account does not exist" and clear.
      await refresh();
    } catch (e: any) {
      if (isAlreadyProcessed(e)) {
        append(`settled (tx retried; first send landed)`);
        await refresh();
      } else {
        append(`settle failed: ${e.message ?? e}`);
      }
    } finally {
      setBusy(false);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const deadline = contestData?.deadline.toNumber() ?? 0;
  const secsLeft = Math.max(0, deadline - now);
  const me = wallet?.publicKey.toBase58();
  const canStart = !!program;
  const statusLabel = contestData ? STATUS_LABELS[contestData.status] : "—";

  return (
    <div
      style={{
        fontFamily: "ui-monospace, monospace",
        padding: 24,
        maxWidth: 720,
        margin: "0 auto",
        color: "#ddd",
        background: "#111",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>solfit contest — dev harness</h1>
      <p style={{ fontSize: 12, color: "#888", marginBottom: 16 }}>
        End-to-end test of the on-chain flow against devnet. Dev judge key is
        stored in localStorage — clear it to rotate.
      </p>

      <section style={section}>
        <div>Wallet: <code>{me ?? "not connected"}</code></div>
        {!wallet && <button onClick={handleConnect} style={btn}>Connect Phantom</button>}
      </section>

      <section style={section}>
        <button onClick={handleCreate} disabled={!canStart || busy} style={btn}>
          {busy ? "…" : "Create contest"}
        </button>
        <input
          type="text"
          placeholder="contest PDA"
          value={contestAddr}
          onChange={(e) => setContestAddr(e.target.value)}
          style={input}
        />
        <button onClick={() => refresh()} disabled={!canStart} style={btn}>Load</button>
        <button
          onClick={handleJoin}
          disabled={!canStart || !contestData || contestData.status !== 0 || busy}
          style={btn}
        >
          {busy ? "…" : "Join"}
        </button>
      </section>

      {contestData && (
        <section style={section}>
          <div>Status: <strong>{statusLabel}</strong></div>
          <div>Players: {contestData.players.length}/{contestData.maxPlayers}</div>
          <div>Wager: {(contestData.wager.toNumber() / LAMPORTS_PER_SOL).toFixed(3)} SOL</div>
          {contestData.status === 1 && (
            <div>Deadline in: {secsLeft}s</div>
          )}
          {contestData.status === 2 && (
            <div>Winner: <code>{contestData.winner.toBase58()}</code></div>
          )}
          <ul style={{ marginTop: 8, fontSize: 12 }}>
            {contestData.players.map((p, i) => (
              <li key={i}>
                [{i}] {p.toBase58()}
                {contestData.finalScores[i] !== undefined && ` → ${contestData.finalScores[i]}`}
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 12 }}>
            <button
              onClick={handleSettle}
              disabled={contestData.status !== 1 || secsLeft > 0 || busy}
              style={btn}
            >
              {busy ? "…" : "Settle (dev judge, pays winner)"}
            </button>
          </div>
        </section>
      )}

      <section style={section}>
        <div style={{ fontSize: 12, color: "#888" }}>log</div>
        <pre style={{ fontSize: 11, maxHeight: 240, overflow: "auto", margin: 0 }}>
          {log.join("\n")}
        </pre>
      </section>
    </div>
  );
}

const section: React.CSSProperties = {
  marginBottom: 16,
  padding: 12,
  border: "1px solid #333",
  borderRadius: 6,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const btn: React.CSSProperties = {
  padding: "6px 12px",
  background: "#222",
  border: "1px solid #444",
  color: "#ddd",
  cursor: "pointer",
  borderRadius: 4,
  fontFamily: "inherit",
  fontSize: 12,
  marginRight: 6,
};

const input: React.CSSProperties = {
  padding: "6px 10px",
  background: "#1a1a1a",
  border: "1px solid #333",
  color: "#ddd",
  fontFamily: "inherit",
  fontSize: 12,
  flex: 1,
};
