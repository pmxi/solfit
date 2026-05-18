import { BN, Program } from "@coral-xyz/anchor";
import {
  Ed25519Program,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import type { Solfit } from "../../idl/solfit";
import { contestPda } from "./pda";
import { serializeScoresMessage } from "./message";
import { getDevJudge } from "./devJudge";
import { requestJudgeSignature } from "./judge";
import { clog, cerror } from "./log";

/**
 * Create a new contest. The `judge` param is the Ed25519 pubkey that will sign
 * final scores at settlement time. In dev mode, pass `getDevJudge().publicKey`.
 */
export async function createContest(
  program: Program<Solfit>,
  opts: {
    contestId: BN;
    wagerLamports: BN;
    maxPlayers: number;
    durationSecs: number;
    judge: PublicKey;
  },
): Promise<{ signature: string; contestPda: PublicKey }> {
  const creator = program.provider.publicKey!;
  const pda = contestPda(creator, opts.contestId);
  clog("createContest", "submitting", {
    creator: creator.toBase58(),
    contestId: opts.contestId.toString(),
    pda: pda.toBase58(),
    wagerLamports: opts.wagerLamports.toString(),
    maxPlayers: opts.maxPlayers,
    durationSecs: opts.durationSecs,
    judge: opts.judge.toBase58(),
  });
  try {
    const signature = await program.methods
      .createContest(
        opts.contestId,
        opts.wagerLamports,
        opts.maxPlayers,
        opts.durationSecs,
        opts.judge,
      )
      .accounts({
        contest: pda,
        creator,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    clog("createContest", "confirmed", { pda: pda.toBase58(), signature });
    return { signature, contestPda: pda };
  } catch (e: any) {
    cerror("createContest", "tx failed", e?.message ?? e);
    throw e;
  }
}

export async function joinContest(
  program: Program<Solfit>,
  contest: PublicKey,
): Promise<string> {
  const player = program.provider.publicKey!;
  clog("joinContest", "submitting", {
    contest: contest.toBase58(),
    player: player.toBase58(),
  });
  try {
    const signature = await program.methods
      .joinContest()
      .accounts({
        contest,
        player,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    clog("joinContest", "confirmed", { signature });
    return signature;
  } catch (e: any) {
    cerror("joinContest", "tx failed", e?.message ?? e);
    throw e;
  }
}

/**
 * Settle a contest. Signs the (pda, scores) message with the dev judge, builds
 * the Ed25519 precompile instruction, and submits it paired with `settle`.
 *
 * In production, the `signature` and judge pubkey come from the real judge
 * server; only the precompile-ix assembly and settle call stay on the client.
 */
export async function settleWithDevJudge(
  program: Program<Solfit>,
  contest: PublicKey,
  scores: number[],
  winner: PublicKey,
): Promise<string> {
  const judge = getDevJudge();
  clog("settleWithDevJudge", "start", {
    contest: contest.toBase58(),
    scores,
    winner: winner.toBase58(),
    devJudgePubkey: judge.publicKey.toBase58(),
  });
  const msg = serializeScoresMessage(contest, scores);
  const sig = judge.sign(msg);
  clog("settleWithDevJudge", "signed locally", {
    messageBytes: msg.length,
    sigBytes: sig.length,
  });

  const edIx = Ed25519Program.createInstructionWithPublicKey({
    publicKey: judge.publicKey.toBytes(),
    message: msg,
    signature: sig,
  });

  try {
    const signature = await program.methods
      .settle(scores)
      .accounts({
        contest,
        winner,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([edIx])
      .rpc();
    clog("settleWithDevJudge", "confirmed", { signature });
    return signature;
  } catch (e: any) {
    cerror("settleWithDevJudge", "tx failed", e?.message ?? e);
    throw e;
  }
}

/**
 * Settle a contest by fetching a signature from the judge server.
 * The server must be the one whose pubkey was baked into the contest at
 * create_contest time — otherwise the on-chain check fails.
 *
 * Caller must also pass the expected `winner` pubkey (argmax of `scores`
 * on `contest.players`). The program re-computes argmax and rejects if
 * the caller lied.
 *
 * On success, the pot is transferred to `winner` and the contest PDA is
 * closed in the same tx — no separate claim step.
 */
export async function settleWithJudgeServer(
  program: Program<Solfit>,
  contest: PublicKey,
  scores: number[],
  winner: PublicKey,
): Promise<string> {
  clog("settleWithJudgeServer", "start", {
    contest: contest.toBase58(),
    scores,
    winner: winner.toBase58(),
  });
  const msg = serializeScoresMessage(contest, scores);
  clog("settleWithJudgeServer", "built message", { messageBytes: msg.length });

  const { publicKey, signature } = await requestJudgeSignature(msg);
  clog("settleWithJudgeServer", "got signature from judge server", {
    judge: publicKey.toBase58(),
    sigBytes: signature.length,
  });

  const edIx = Ed25519Program.createInstructionWithPublicKey({
    publicKey: publicKey.toBytes(),
    message: msg,
    signature,
  });

  try {
    const sig = await program.methods
      .settle(scores)
      .accounts({
        contest,
        winner,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([edIx])
      .rpc();
    clog("settleWithJudgeServer", "confirmed", { signature: sig });
    return sig;
  } catch (e: any) {
    cerror("settleWithJudgeServer", "tx failed", e?.message ?? e);
    throw e;
  }
}
