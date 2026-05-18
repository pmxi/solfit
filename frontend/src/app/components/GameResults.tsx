import { useNavigate, useLocation } from 'react-router';
import { Trophy, Crown, Star, Home, RotateCcw, Award, Zap } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import confetti from 'canvas-confetti';
import { useGame } from '../../context/GameContext';
import { PlayerAvatar } from './PlayerAvatar';
import { clog, cerror, isAlreadyProcessed, settleWithJudgeServer } from '../../lib/contest';

interface ResultPlayer {
  id: string;
  name: string;
  count: number;
  isYou: boolean;
  prize: number;
}

type OnchainStatus = 'idle' | 'settling' | 'settled' | 'error';

export default function GameResults() {
  const navigate = useNavigate();
  const location = useLocation();
  const { playerId, updateStats, program, wallet, room, isHost } = useGame();
  const statsUpdated = useRef(false);
  const settledRef = useRef(false);

  const [onchainStatus, setOnchainStatus] = useState<OnchainStatus>('idle');
  const [winnerPubkey, setWinnerPubkey] = useState<string | null>(null);
  const [onchainError, setOnchainError] = useState<string>('');

  const {
    results: rawResults,
    gameType = 'Pushup',
    entryFee = 0.1,
    playerCount,
  } = (location.state ?? {}) as {
    results?: Array<{ id: string; name: string; count: number; isYou: boolean }>;
    gameType?: string;
    entryFee?: number;
    playerCount?: number;
  };

  const rawList = rawResults ?? [
    { id: playerId, name: 'You', count: 48, isYou: true },
    { id: 'bot1', name: 'Bot Alpha', count: 42, isYou: false },
    { id: 'bot2', name: 'Bot Beta', count: 38, isYou: false },
  ];

  const count = playerCount ?? rawList.length;
  const totalPot = entryFee * count * 0.95;

  const results: ResultPlayer[] = rawList.map((p, i) => ({
    ...p,
    prize: i === 0 ? parseFloat((totalPot * 0.9).toFixed(3))
      : i === 1 && rawList.length > 1 ? parseFloat((totalPot * 0.1).toFixed(3))
      : 0,
  }));

  const winner = results[0];
  const myResult = results.find(p => p.id === playerId || p.isYou);
  const iWon = myResult ? results.indexOf(myResult) === 0 : false;

  useEffect(() => {
    if (statsUpdated.current || !myResult) return;
    statsUpdated.current = true;
    updateStats(myResult.count, myResult.prize ?? 0, gameType);
  }, [myResult, gameType, updateStats]);

  // Auto-settle on behalf of the room host once results are in.
  // Anyone could call settle (permissionless), but host does it to avoid double-submits.
  useEffect(() => {
    const pda = room?.contestPda;
    if (!pda || !program || !wallet || !isHost) return;
    if (settledRef.current) return;
    if (!rawResults || rawResults.length === 0) return;
    settledRef.current = true;

    (async () => {
      setOnchainStatus('settling');
      setOnchainError('');
      clog('GameResults', 'settle effect: fetching contest', { pda });
      try {
        const contestPk = new PublicKey(pda);
        // @ts-expect-error — anchor's dynamic account access
        const contest: any = await program.account.contest.fetch(contestPk);
        clog('GameResults', 'settle effect: contest state', {
          status: Number(contest.status),
          players: contest.players.map((p: PublicKey) => p.toBase58()),
          deadline: contest.deadline?.toString?.(),
        });

        // Align scores with contest.players order (by walletPubkey).
        const scores: number[] = contest.players.map((walletPk: PublicKey) => {
          const walletStr = walletPk.toBase58();
          const socketPlayer = room.players.find((p) => p.walletPubkey === walletStr);
          if (!socketPlayer) return 0;
          const res = rawResults.find((r) => r.id === socketPlayer.id);
          return res?.count ?? 0;
        });

        // Compute winner locally — must match program's argmax + lowest-index tiebreak.
        let winnerIdx = 0;
        for (let i = 1; i < scores.length; i++) {
          if (scores[i] > scores[winnerIdx]) winnerIdx = i;
        }
        const winnerPk = contest.players[winnerIdx] as PublicKey;
        clog('GameResults', 'settle effect: computed scores + winner', {
          scores,
          winner: winnerPk.toBase58(),
        });

        await settleWithJudgeServer(program, contestPk, scores, winnerPk);
        setWinnerPubkey(winnerPk.toBase58());
        setOnchainStatus('settled');
      } catch (e: any) {
        if (isAlreadyProcessed(e)) {
          clog('GameResults', 'settle retry hit already-processed; treating as success');
          setOnchainStatus('settled');
          return;
        }
        const msg = String(e?.message ?? e);
        cerror('GameResults', 'settle failed', msg);
        setOnchainError(msg);
        setOnchainStatus('error');
        settledRef.current = false; // allow retry
      }
    })();
  }, [room?.contestPda, room?.players, program, wallet, isHost, rawResults]);

  const iAmOnchainWinner =
    !!(winnerPubkey && wallet && wallet.publicKey.toBase58() === winnerPubkey);

  useEffect(() => {
    confetti({ particleCount: iWon ? 200 : 100, spread: 70, origin: { y: 0.6 }, colors: ['#b794f6', '#ffd700', '#ffffff'] });
  }, [iWon]);

  return (
    <div className="min-h-full bg-[#0a0a0f] overflow-y-auto">
      <div className="w-full max-w-[390px] md:max-w-4xl mx-auto flex flex-col p-6 md:p-10 min-h-full relative">

        {/* Ambient glow */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[400px] h-[400px] bg-[#b794f6]/8 rounded-full blur-[120px] pointer-events-none" />

        {/* ── Desktop: 2-col (winner + prize | rankings) ── */}
        <div className="md:grid md:grid-cols-2 md:gap-12 md:items-start flex flex-col relative z-10 pt-8">

          {/* Left: Winner + prize */}
          <div className="flex flex-col items-center md:items-start">

            {/* Winner avatar */}
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="flex flex-col items-center mb-8 w-full"
            >
              <div className="relative mb-6">
                <div className="absolute inset-0 bg-gradient-to-tr from-[#b794f6] to-[#8b5cf6] rounded-full blur-2xl opacity-30 animate-pulse" />
                <div className="relative w-28 h-28 rounded-full border-4 border-[#b794f6] bg-[#0a0a0f] flex items-center justify-center shadow-[0_0_50px_rgba(183,148,246,0.3)] overflow-hidden">
                  <PlayerAvatar name={winner.name} size={96} className="rounded-full" showBorder={false} />
                </div>
                <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 bg-[#b794f6] text-black text-[10px] font-black uppercase px-3 py-1 rounded-full shadow-lg whitespace-nowrap">
                  Champion
                </div>
              </div>

              <h1 className="text-4xl font-black italic text-white tracking-tighter uppercase text-center mb-2">
                {winner.name}{winner.isYou ? ' (You)' : ''}
              </h1>
              <div className="flex items-center gap-2 mb-4">
                <Star className="w-3 h-3 text-[#b794f6] fill-[#b794f6]" />
                <span className="text-[10px] font-black text-white/40 uppercase tracking-[0.2em]">
                  {winner.count} {gameType} Reps
                </span>
                <Star className="w-3 h-3 text-[#b794f6] fill-[#b794f6]" />
              </div>

              {iWon && (
                <motion.div
                  initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 0.5, type: 'spring' }}
                  className="bg-[#b794f6]/20 border border-[#b794f6]/40 px-4 py-2 rounded-xl mb-4"
                >
                  <span className="text-[10px] font-black text-[#b794f6] uppercase tracking-widest">You Won!</span>
                </motion.div>
              )}
            </motion.div>

            {/* Prize banner */}
            <motion.div
              initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.2 }}
              className="w-full bg-gradient-to-br from-[#b794f6]/20 via-white/5 to-[#b794f6]/10 border border-[#b794f6]/30 rounded-[32px] p-6 relative overflow-hidden mb-6"
            >
              <div className="absolute top-0 right-0 p-4 opacity-10">
                <Zap className="w-16 h-16 text-[#b794f6]" />
              </div>
              <div className="flex items-center justify-between relative z-10">
                <div>
                  <span className="text-[9px] font-black text-[#b794f6] uppercase tracking-[0.2em] block mb-1">
                    {iWon ? 'Your Winnings' : 'Total Prize Pool'}
                  </span>
                  <div className="text-4xl font-black text-white italic tracking-tighter leading-none">
                    ◎ {iWon ? (myResult?.prize ?? 0).toFixed(3) : totalPot.toFixed(3)}
                  </div>
                  {myResult && !iWon && myResult.prize > 0 && (
                    <div className="text-sm font-black text-[#b794f6] mt-1">
                      Your share: ◎ {myResult.prize.toFixed(3)}
                    </div>
                  )}
                </div>
                <div className="w-14 h-14 rounded-2xl bg-[#b794f6]/10 border border-[#b794f6]/20 flex items-center justify-center">
                  <Award className="w-8 h-8 text-[#b794f6]" />
                </div>
              </div>
            </motion.div>

            {/* On-chain status */}
            {room?.contestPda && (
              <div className="w-full mb-4 px-4 py-3 rounded-2xl bg-white/5 border border-white/10">
                <div className="text-[9px] font-black text-white/40 uppercase tracking-[0.2em] mb-1">
                  On-chain
                </div>
                <div className="text-xs font-bold text-white/80">
                  {onchainStatus === 'idle' && isHost && 'waiting for settlement…'}
                  {onchainStatus === 'idle' && !isHost && 'waiting for host to settle…'}
                  {onchainStatus === 'settling' && 'settling on devnet…'}
                  {onchainStatus === 'settled' && winnerPubkey && (
                    <>
                      {iAmOnchainWinner ? '✓ pot paid to you' : (
                        <>settled — pot paid to <code className="text-[#b794f6]">{winnerPubkey.slice(0, 4)}…{winnerPubkey.slice(-4)}</code></>
                      )}
                    </>
                  )}
                  {onchainStatus === 'error' && (
                    <span className="text-red-400">error: {onchainError.slice(0, 80)}</span>
                  )}
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex flex-col gap-3 w-full">
              <button
                onClick={() => navigate('/lobby')}
                className="w-full bg-[#b794f6] text-white rounded-2xl py-5 font-black text-lg uppercase italic tracking-tighter flex items-center justify-center gap-3 shadow-[0_10px_30px_rgba(183,148,246,0.3)] active:scale-95 transition-all"
              >
                <RotateCcw className="w-5 h-5" /> Play Again
              </button>
              <button
                onClick={() => navigate('/')}
                className="w-full bg-white/5 hover:bg-white/10 text-white/60 rounded-2xl py-5 font-black text-sm uppercase tracking-[0.2em] flex items-center justify-center gap-3 border border-white/10 transition-all active:scale-95"
              >
                <Home className="w-5 h-5" /> Back to Home
              </button>
            </div>
          </div>

          {/* Right: Rankings */}
          <div className="mt-10 md:mt-0">
            <h3 className="text-[10px] font-black text-white/20 uppercase tracking-[0.3em] px-2 mb-4 flex items-center gap-2">
              <Trophy className="w-3 h-3" /> Final Rankings
            </h3>
            <div className="space-y-3">
              {results.map((player, index) => (
                <motion.div
                  key={player.id}
                  initial={{ x: 20, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  transition={{ delay: 0.3 + index * 0.08 }}
                  className={`flex items-center justify-between p-4 rounded-2xl border transition-all ${
                    index === 0 ? 'bg-[#b794f6]/5 border-[#b794f6]/20'
                      : (player.id === playerId || player.isYou) ? 'bg-white/8 border-[#b794f6]/10'
                      : 'bg-white/5 border-white/5'
                  }`}
                >
                  <div className="flex items-center gap-4">
                    <div className={`w-6 font-black italic text-center text-sm ${index === 0 ? 'text-[#b794f6]' : 'text-white/20'}`}>
                      {index + 1}
                    </div>
                    <PlayerAvatar name={player.name} size={36} className="rounded-xl" />
                    <div>
                      <span className={`text-sm font-bold ${index === 0 ? 'text-white' : 'text-white/60'}`}>
                        {player.name}{player.isYou ? ' (You)' : ''}
                      </span>
                      {player.prize > 0 && (
                        <div className="text-[10px] font-black text-[#b794f6]">◎ {player.prize.toFixed(3)}</div>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`text-lg font-black italic leading-none ${index === 0 ? 'text-[#b794f6]' : 'text-white/40'}`}>
                      {player.count}
                    </div>
                    <span className="text-[8px] font-bold text-white/10 uppercase tracking-widest">Reps</span>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
