import { az } from "./az.js";
import { isArmCacheablePath, readArmCache, writeArmCache } from "./cache.js";

/**
 * Hit ARM directly with a single bearer token instead of shelling out to `az`
 * per request. Two reasons:
 *   1. Cold-start tax. Each `az` invocation loads Python + the CLI modules
 *      (~2-5s on Windows). 17 regions × 2 calls = 34 starts = minutes.
 *   2. MSAL token-cache file lock. Concurrent `az` processes serialise on
 *      `%USERPROFILE%\.azure\msal_token_cache.json`, so `concurrency: 8`
 *      in node still runs effectively serially through the CLI.
 *
 * We still use `az` for one-off metadata (`account show`, `list-locations`)
 * and to mint the token. After that we speak ARM ourselves.
 */

interface AccessToken {
  accessToken: string;
  subscription: string;
  tenant: string;
  expiresOn: string;
  tokenType: "Bearer";
}

let tokenPromise: Promise<AccessToken> | undefined;

export function getToken(): Promise<AccessToken> {
  if (!tokenPromise) {
    tokenPromise = az<AccessToken>(["account", "get-access-token"]);
  }
  return tokenPromise;
}

/**
 * Per-call budget. Observed tail latency on West Europe was ~22s on a
 * healthy sub, which dragged the whole scan since wall-time is `max(per-call)`.
 * 10s + one retry caps a region at ~20s while forgiving transient blips.
 */
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 1;

export interface ArmListOptions {
  /** Per-page timeout in ms. Default 10s; raise for unfiltered list endpoints. */
  timeoutMs?: number;
  /** Bypass cached ARM list data for cacheable read-only endpoints. */
  refresh?: boolean;
  /** Disable cache reads/writes for this call. Defaults to true for safe endpoints. */
  cache?: boolean;
}

export async function armList<T>(path: string, opts: ArmListOptions = {}): Promise<T[]> {
  const tok = await getToken();
  const cacheable = opts.cache !== false && isArmCacheablePath(path);
  if (cacheable) {
    const cached = await readArmCache<T[]>(tok.subscription, path, opts.refresh);
    if (cached) return cached;
  }

  let url = path.startsWith("http")
    ? path
    : `https://management.azure.com/subscriptions/${tok.subscription}${path}`;
  const out: T[] = [];
  while (url) {
    const res = await fetchWithRetry(url, tok.accessToken, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const data = (await res.json()) as { value?: T[]; nextLink?: string };
    if (data.value) out.push(...data.value);
    url = data.nextLink ?? "";
  }
  if (cacheable) await writeArmCache(tok.subscription, path, out);
  return out;
}

async function fetchWithRetry(
  url: string,
  accessToken: string,
  timeoutMs: number,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Retry transient server-side failures (5xx, 429). 4xx are the caller's
      // problem (auth, not-found, subscription scoping) — don't waste a retry.
      if ((res.status >= 500 || res.status === 429) && attempt < MAX_RETRIES) {
        lastErr = new Error(`ARM ${res.status} ${res.statusText}`);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`ARM ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
      }
      return res;
    } catch (err) {
      // Network/timeout errors (AbortError, fetch TypeError) are worth retrying;
      // the thrown Error above from 4xx is not, so it falls through after the loop.
      lastErr = err;
      if (!isRetryable(err) || attempt >= MAX_RETRIES) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("ARM request failed");
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // AbortSignal.timeout throws a DOMException with name "TimeoutError".
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  // undici wraps network failures as TypeError with cause. Treat any non-ARM
  // error (i.e. before we've seen an HTTP status) as retryable once.
  if (err.name === "TypeError") return true;
  return false;
}
