import { PublicKey, Transaction } from "@solana/web3.js";
import { clog, cerror } from "./log";

/**
 * Minimal Phantom wallet adapter matching @coral-xyz/anchor's Wallet interface.
 * No ceremony from @solana/wallet-adapter — we only support Phantom, for now.
 */
export interface PhantomWallet {
  publicKey: PublicKey;
  signTransaction<T extends Transaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction>(txs: T[]): Promise<T[]>;
}

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: { toBytes(): Uint8Array };
  connect(): Promise<{ publicKey: { toBytes(): Uint8Array } }>;
  disconnect(): Promise<void>;
  signTransaction<T>(tx: T): Promise<T>;
  signAllTransactions<T>(txs: T[]): Promise<T[]>;
}

declare global {
  interface Window {
    solana?: PhantomProvider;
  }
}

export async function connectPhantom(): Promise<PhantomWallet> {
  clog("wallet", "connectPhantom: requesting connection…");
  if (!window.solana?.isPhantom) {
    cerror("wallet", "connectPhantom: window.solana.isPhantom is falsy");
    throw new Error("Phantom wallet not found. Install from phantom.app.");
  }
  try {
    const resp = await window.solana.connect();
    const publicKey = new PublicKey(resp.publicKey.toBytes());
    clog("wallet", "connectPhantom: connected", publicKey.toBase58());
    return {
      publicKey,
      signTransaction: (tx) => window.solana!.signTransaction(tx),
      signAllTransactions: (txs) => window.solana!.signAllTransactions(txs),
    };
  } catch (e: any) {
    cerror("wallet", "connectPhantom: connect() rejected", e?.message ?? e);
    throw e;
  }
}

export async function disconnectPhantom(): Promise<void> {
  clog("wallet", "disconnectPhantom");
  await window.solana?.disconnect();
}
