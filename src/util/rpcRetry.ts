/**
 * Retry helper for transient Starknet RPC failures.
 *
 * The deploy workflows intermittently fail with `-32001: Unable to complete
 * request at this time` from the RPC node (observed on `starknet_getNonce`
 * with the `pending` block). These errors happen before a transaction is
 * broadcast, so retrying the operation is safe.
 */

const TRANSIENT_RPC_CODE = -32001;
const DEFAULT_ATTEMPTS = 5;
const DEFAULT_INITIAL_DELAY_MS = 2000;

function isTransientRpcError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown }).code === TRANSIENT_RPC_CODE;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRpcRetry<T>(
  operation: () => Promise<T>,
  attempts: number = DEFAULT_ATTEMPTS,
): Promise<T> {
  let delayMs = DEFAULT_INITIAL_DELAY_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientRpcError(error) || attempt >= attempts) throw error;
      console.warn(
        `Transient RPC error (attempt ${attempt}/${attempts}), retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
      delayMs *= 2;
    }
  }
}
