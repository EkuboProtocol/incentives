/**
 * Retry and failover helpers for Starknet RPC calls.
 *
 * The deploy workflows failed with `-32001: Unable to complete request at
 * this time` from the primary RPC node, persistently (not just on the
 * `pending` block), so reads are retried and, if the endpoint stays down,
 * the operation fails over to the next configured endpoint. Endpoints may
 * also serve different RPC spec versions (0.9 vs 0.10), so a node whose spec
 * the client cannot speak is skipped the same way.
 *
 * Later a deploy failed with every endpoint exhausted at once (`-32029: Too
 * Many Requests` on the primary and on the keyless public fallback), so
 * failover now makes several passes over the endpoint list with a growing
 * wait between passes: rate-limit windows usually clear within minutes,
 * while a pass that fails without any transient error (e.g. unsupported RPC
 * spec everywhere) still stops immediately.
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
// Full passes over the endpoint list before giving up. One pass is ~30s of
// retries per endpoint, so three passes ride out rate-limit windows of a few
// minutes without burning much runner time.
const DEFAULT_ROUNDS = 3;
const DEFAULT_ROUND_BASE_DELAY_MS = 60_000;
const UNSUPPORTED_SPEC_MESSAGE =
  "specification version is not supported by this library";

/**
 * Fee/confirmation options for airdrop deploys. starknet.js v10 analyzes
 * recent-block tips (several heavy getBlockWithTxs calls) unless a tip is
 * given; tip 0 matches pre-v10 behavior. Confirmation polls are paced at
 * 15s so fragile quota-limited endpoints are not rate-limited by the wait.
 */
export const DEPLOY_DETAILS = { tip: 0, retryInterval: 15_000 };

// Keyless public endpoint used as a last resort when every configured
// endpoint is down. Quota is tight, so it is only ever tried after the
// configured endpoints have been exhausted.
const PUBLIC_FALLBACK_NODE_URL = "https://starknet.api.onfinality.io/public";

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
 * Ordered RPC endpoints: NODE_URL first, then FALLBACK_NODE_URL, then the
 * built-in public fallback. Both env vars accept comma-separated lists.
 */
export function getNodeUrls(): string[] {
  const urls: string[] = [];
  appendUrls(urls, process.env.NODE_URL);
  appendUrls(urls, process.env.FALLBACK_NODE_URL);
  if (urls.length === 0) {
    throw new Error("Missing NODE_URL or FALLBACK_NODE_URL");
  }
  appendUrls(urls, PUBLIC_FALLBACK_NODE_URL);
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
 * Runs `run` against each endpoint in order, failing over to the next one
 * when the current one keeps returning transient RPC errors or serves an RPC
 * spec version the client cannot speak. Non-transient errors are rethrown
 * immediately without trying further endpoints.
 *
 * When every endpoint is exhausted by transient errors (e.g. `-32029` rate
 * limits on all of them at once), the whole list is retried for a few more
 * passes with a growing wait between passes instead of failing the run.
 *
 * Keep broadcasts and their confirmation polls in separate failover calls:
 * failing over a confirmation must never re-broadcast the transaction.
 */
export interface FailoverOptions {
  /** Full passes over the endpoint list before giving up. Default 3. */
  rounds?: number;
  /** Base wait between passes; doubles each pass with jitter. Default 60s. */
  baseDelayMs?: number;
  /** Overridable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

function roundDelayMs(baseDelayMs: number, round: number): number {
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(baseDelayMs * 2 ** (round - 1) * jitter);
}

function logEndpoint(
  url: string,
  endpointCount: number,
  round: number,
  rounds: number,
): void {
  if (endpointCount > 1 || round > 1) {
    const pass = round > 1 ? ` (pass ${round}/${rounds})` : "";
    console.log(`Using Starknet RPC ${hostnameForLog(url)}${pass}`);
  }
}

interface PassOutcome<T> {
  succeeded: boolean;
  value?: T;
  sawTransientError: boolean;
  lastError: unknown;
}

async function runEndpointsPass<T>(
  urls: string[],
  run: (nodeUrl: string) => Promise<T>,
  round: number,
  rounds: number,
): Promise<PassOutcome<T>> {
  let sawTransientError = false;
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      logEndpoint(url, urls.length, round, rounds);
      return {
        succeeded: true,
        value: await run(url),
        sawTransientError,
        lastError,
      };
    } catch (error) {
      lastError = error;
      if (!isFailoverError(error)) throw error;
      if (isTransientRpcError(error)) sawTransientError = true;
      console.warn(
        `Endpoint ${hostnameForLog(url)} keeps failing (${errorSummary(error)}), failing over`,
      );
    }
  }
  return { succeeded: false, sawTransientError, lastError };
}

export async function withEndpointFailover<T>(
  urls: string[],
  run: (nodeUrl: string) => Promise<T>,
  options: FailoverOptions = {},
): Promise<T> {
  const {
    rounds = DEFAULT_ROUNDS,
    baseDelayMs = DEFAULT_ROUND_BASE_DELAY_MS,
    sleep: sleepFn = sleep,
  } = options;
  let lastError: unknown = null;
  for (let round = 1; ; round += 1) {
    const pass = await runEndpointsPass(urls, run, round, rounds);
    if (pass.succeeded) return pass.value as T;
    lastError = pass.lastError;
    // A pass with no transient error (e.g. an unsupported RPC spec on every
    // endpoint) will not heal with time, so stop instead of waiting.
    if (!pass.sawTransientError || round >= rounds) break;
    const delayMs = roundDelayMs(baseDelayMs, round);
    console.warn(
      `All Starknet RPC endpoints exhausted (pass ${round}/${rounds}), retrying in ${Math.round(delayMs / 1000)}s`,
    );
    await sleepFn(delayMs);
  }
  throw lastError;
}
