/**
 * Retry and failover helpers for Starknet RPC calls.
 *
 * The deploy workflows failed with `-32001: Unable to complete request at
 * this time` from the primary RPC node, persistently (not just on the
 * `pending` block), so reads are retried and, if the endpoint stays down,
 * the operation fails over to the next configured endpoint. Endpoints may
 * also serve different RPC spec versions (0.9 vs 0.10), so a node whose spec
 * the client cannot speak is skipped the same way.
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

/**
 * Runs `run` against each endpoint in order, failing over to the next one
 * when the current one keeps returning transient RPC errors or serves an RPC
 * spec version the client cannot speak. Non-transient errors are rethrown
 * immediately without trying further endpoints.
 *
 * Note: if a transaction was already broadcast on a failing endpoint (e.g.
 * the confirmation poll failed), failing over can broadcast it a second
 * time. The duplicate contract is inert (funding matches drops by root),
 * so availability is worth the trade-off.
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
        `Endpoint ${hostnameForLog(url)} keeps failing, failing over`,
      );
    }
  }
  throw lastError;
}
