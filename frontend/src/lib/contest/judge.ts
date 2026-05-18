import { PublicKey } from '@solana/web3.js';
import { clog, cerror } from './log';

const DEFAULT_JUDGE_API_BASE = import.meta.env.DEV ? 'http://localhost:3001' : undefined;
const JUDGE_API_BASE =
  (import.meta.env.VITE_JUDGE_URL as string | undefined) ||
  (import.meta.env.VITE_SERVER_URL as string | undefined) ||
  DEFAULT_JUDGE_API_BASE;

export interface JudgeSignature {
  publicKey: PublicKey;
  signature: Uint8Array;
}

/** Fetches the judge server's Ed25519 pubkey. Cache across calls. */
let cachedPubkey: PublicKey | null = null;

function requireJudgeApiBase(): string {
  if (!JUDGE_API_BASE) {
    throw new Error('Judge server is not configured for this deployment');
  }
  return JUDGE_API_BASE;
}

export async function getJudgePubkey(): Promise<PublicKey> {
  if (cachedPubkey) {
    clog('judge', 'getJudgePubkey: cache hit', cachedPubkey.toBase58());
    return cachedPubkey;
  }
  const judgeApiBase = requireJudgeApiBase();
  clog('judge', 'getJudgePubkey: fetching from', `${judgeApiBase}/api/judge-pubkey`);
  try {
    const res = await fetch(`${judgeApiBase}/api/judge-pubkey`);
    if (!res.ok) {
      cerror('judge', 'getJudgePubkey: HTTP', res.status);
      throw new Error(`judge-pubkey ${res.status}`);
    }
    const { publicKey } = (await res.json()) as { publicKey: string };
    cachedPubkey = new PublicKey(publicKey);
    clog('judge', 'getJudgePubkey: resolved', cachedPubkey.toBase58());
    return cachedPubkey;
  } catch (e: any) {
    cerror('judge', 'getJudgePubkey: request failed', e?.message ?? e);
    throw e;
  }
}

/** Asks the judge server to sign a message. Returns the signature + the judge's pubkey. */
export async function requestJudgeSignature(message: Uint8Array): Promise<JudgeSignature> {
  const judgeApiBase = requireJudgeApiBase();
  const messageBase64 = btoa(String.fromCharCode(...message));
  clog('judge', 'requestJudgeSignature: POST /api/sign', {
    messageBytes: message.length,
  });
  try {
    const res = await fetch(`${judgeApiBase}/api/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageBase64 }),
    });
    if (!res.ok) {
      cerror('judge', 'requestJudgeSignature: HTTP', res.status);
      throw new Error(`judge sign ${res.status}`);
    }
    const { signatureBase64, publicKey } = (await res.json()) as {
      signatureBase64: string;
      publicKey: string;
    };
    const signature = Uint8Array.from(atob(signatureBase64), (c) => c.charCodeAt(0));
    clog('judge', 'requestJudgeSignature: signed', {
      judge: publicKey,
      sigBytes: signature.length,
    });
    return { publicKey: new PublicKey(publicKey), signature };
  } catch (e: any) {
    cerror('judge', 'requestJudgeSignature: failed', e?.message ?? e);
    throw e;
  }
}
