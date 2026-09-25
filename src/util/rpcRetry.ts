/**
 * Retry helper for Starknet RPC calls against the configured Alchemy node.
 *
 * Reads are retried with backoff because the node can fail transiently
 * (`-32001: Unable to complete request at this time`, `-32029: Too Many
 * Requests`, transport blips). Every retry logs the underlying error code
 * and message so the next failure is diagnosable from the run log.
 */

const TRANSIENT_RPC_CODES = new Set([-32001, -32029]);
// starknet.js sometimes wraps the underlying RPC failure in a LibraryError
// (e.g. tip analysis during fee estimation), hiding the code, so also match
// on the message text.
const TRANSIENT_MESSAGE_FRAGMENTS = [
  "-32001",
  "-32029",
  "Unable to complete request",
  "Too Many Requests",
];
const DEFAULT_ATTEMPTS = 5;
const DEFAULT_INITIAL_DELAY_MS = 2000;
const UNSUPPORTED_SPEC_MESSAGE =
  "specification version is not supported by this library";

/**
 * Fee/confirmation options for airdrop deploys. starknet.js v10 analyzes
 * recent-block tips (several heavy getBlockWithTxs calls) unless a tip is
 * given; tip 0 matches pre-v10 behavior. Confirmation polls are paced at
 * 15s so fragile quota-limited endpoints are not rate-limited by the wait.
 */
export const DEPLOY_DETAILS = { tip: 0, retryInterval: 15_000 };

function isTransientRpcError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  // Transport failures (connection refused, DNS, TLS) surface as TypeError
  // in some versions, or as `Error("Unable to connect. ...")` in v10+.
  if (error instanceof TypeError) return true;
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string") {
    if (message.startsWith("Unable to connect")) return true;
    if (
      TRANSIENT_MESSAGE_FRAGMENTS.some((fragment) => message.includes(fragment))
    ) {
      return true;
    }
  }
  if ((error as { name?: unknown }).name === "TimeoutError") return true;
  return TRANSIENT_RPC_CODES.has((error as { code?: unknown }).code as number);
}

function isUnsupportedSpecError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === "string" && message.includes(UNSUPPORTED_SPEC_MESSAGE)
  );
}

function isFailoverError(error: unknown): boolean {
  return isTransientRpcError(error) || isUnsupportedSpecError(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendUrls(target: string[], raw: string | undefined): void {
  for (const part of (raw ?? "").split(",")) {
    const url = part.trim();
    if (url && !target.includes(url)) target.push(url);
  }
}

/**
 * Ordered RPC endpoints: NODE_URL first, then FALLBACK_NODE_URL. Both env
 * vars accept comma-separated lists.
 */
export function getNodeUrls(): string[] {
  const urls: string[] = [];
  appendUrls(urls, process.env.NODE_URL);
  appendUrls(urls, process.env.FALLBACK_NODE_URL);
  if (urls.length === 0) {
    throw new Error("Missing NODE_URL or FALLBACK_NODE_URL");
  }
  return urls;
}

function hostnameForLog(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "configured endpoint";
  }
}

// One-line error summary for retry/failover warnings. The Sep 24 deploy
// failure showed the primary node failing five times with no record of what
// it actually returned, so the code, if any, is always logged now.
function errorSummary(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown error";
  const code = (error as { code?: unknown }).code;
  const prefix =
    typeof code === "number" || typeof code === "string" ? `${code}: ` : "";
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return `${prefix}no message`;
  return `${prefix}${message.split("\n")[0].slice(0, 200)}`;
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
        `Transient RPC error (attempt ${attempt}/${attempts}): ${errorSummary(error)}, retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
      delayMs *= 2;
    }
  }
}

/**
 * Runs `run` against each configured endpoint in order, failing over to the
 * next one when the current one keeps returning transient RPC errors or
 * serves an RPC spec version the client cannot speak. Non-transient errors
 * are rethrown immediately without trying further endpoints.
 *
 * Keep broadcasts and their confirmation polls in separate failover calls:
 * failing over a confirmation must never re-broadcast the transaction.
 */
export async function withEndpointFailover<T>(
  urls: string[],
  run: (nodeUrl: string) => Promise<T>,
): Promise<T> {
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      if (urls.length > 1) {
        console.log(`Using Starknet RPC ${hostnameForLog(url)}`);
      }
      return await run(url);
    } catch (error) {
      lastError = error;
      if (!isFailoverError(error)) throw error;
      console.warn(
        `Endpoint ${hostnameForLog(url)} keeps failing (${errorSummary(error)}), failing over`,
      );
    }
  }
  throw lastError;
}
