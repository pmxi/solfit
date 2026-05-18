/* Tiny tagged logger for the contest-related client code. Prefix every line
 * with [solfit:<scope>] so it's easy to filter in devtools. Flip the global
 * debug flag by setting localStorage.solfit_debug = "0" to silence info/debug
 * (errors and warnings always print). */

function enabled(): boolean {
  try {
    return localStorage.getItem('solfit_debug') !== '0';
  } catch {
    return true;
  }
}

export const clog = (scope: string, ...args: unknown[]): void => {
  if (!enabled()) return;
  // eslint-disable-next-line no-console
  console.log(`[solfit:${scope}]`, ...args);
};

export const cwarn = (scope: string, ...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.warn(`[solfit:${scope}]`, ...args);
};

export const cerror = (scope: string, ...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error(`[solfit:${scope}]`, ...args);
};

/** web3.js sometimes retries a signed tx whose first send already landed; the
 * RPC then rejects with "already been processed". The on-chain state is fine —
 * only the JS error is wrong. Callers should treat this as success. */
export function isAlreadyProcessed(e: unknown): boolean {
  const msg = String((e as { message?: string } | null)?.message ?? e).toLowerCase();
  return msg.includes("already been processed");
}
