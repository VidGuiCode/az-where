import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasArg, isCompactMode } from "./runtime.js";
import { c, colorEnabled } from "./color.js";

/**
 * Non-blocking "is there a newer release?" check. Runs after the verb's
 * output has already been flushed, on stderr, so it never delays or
 * contaminates stdout for pipelines.
 *
 * Design constraints we explicitly respected:
 *   - Cache-first. GitHub's unauth rate limit is 60/h/IP and we don't want
 *     every `azw` invocation to burn one. Persist `{checkedAt, latestTag}`
 *     to the user cache dir with a 24h TTL.
 *   - Silent on failure. Offline, DNS down, GitHub 503 — swallow it. We're
 *     a diagnostics tool, breaking `azw B1s` because a courtesy check timed
 *     out would be absurd.
 *   - Short timeout (1.5s). Worst case hits once per day; users won't
 *     tolerate a multi-second tax on every command.
 *   - Opt-out everywhere. `--json`, `--name`, `--compact`, `--no-update-check`,
 *     `NO_COLOR`, `CI`, and `AZ_WHERE_NO_UPDATE_CHECK=1` all suppress both
 *     the network call and the banner.
 */

const RELEASES_LATEST_URL = "https://api.github.com/repos/VidGuiCode/az-where/releases/latest";
const CACHE_FILENAME = "version-check.json";
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1_500;

interface CacheEntry {
  checkedAt: string; // ISO
  latestTag: string; // e.g. "v0.2.0"
}

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  behind: boolean;
}

/**
 * Passive-banner suppression. Only consulted by `maybePrintUpdateBanner`.
 * `checkForUpdate` itself never bails here — if a user explicitly runs
 * `azw update`, they want the result regardless of flags that suggest
 * machine-readable mode. Same shape as npm: `update-notifier` can be off
 * while `npm outdated` still works.
 */
export function shouldSkipAutomaticBanner(): boolean {
  if (hasArg("--no-update-check")) return true;
  if (hasArg("--json") || hasArg("--name") || hasArg("--pick") || isCompactMode()) return true;
  if (process.env.AZ_WHERE_NO_UPDATE_CHECK) return true;
  if (process.env.CI) return true;
  if (process.env.NO_COLOR) return true;
  return false;
}

/** Kept as an alias so older imports keep compiling during refactors. */
export const shouldSkipUpdateCheck = shouldSkipAutomaticBanner;

function cacheDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "az-where");
  }
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return path.join(xdg, "az-where");
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "az-where");
  }
  return path.join(os.homedir(), ".cache", "az-where");
}

function cachePath(): string {
  return path.join(cacheDir(), CACHE_FILENAME);
}

async function readCache(): Promise<CacheEntry | null> {
  try {
    const raw = await fs.readFile(cachePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<CacheEntry>;
    if (typeof parsed.checkedAt !== "string" || typeof parsed.latestTag !== "string") return null;
    return { checkedAt: parsed.checkedAt, latestTag: parsed.latestTag };
  } catch {
    return null;
  }
}

async function writeCache(entry: CacheEntry): Promise<void> {
  try {
    await fs.mkdir(cacheDir(), { recursive: true });
    await fs.writeFile(cachePath(), JSON.stringify(entry, null, 2), "utf-8");
  } catch {
    // Cache is a nice-to-have. If the disk is read-only or full we just
    // re-fetch next run — worst case the rate limit burn is N-per-day.
  }
}

function isFresh(entry: CacheEntry | null, now: number = Date.now()): boolean {
  if (!entry) return false;
  const checkedAt = Date.parse(entry.checkedAt);
  if (!Number.isFinite(checkedAt)) return false;
  return now - checkedAt < TTL_MS;
}

async function fetchLatestTag(userAgentVersion: string): Promise<string | null> {
  try {
    const res = await fetch(RELEASES_LATEST_URL, {
      headers: {
        "User-Agent": `az-where/${userAgentVersion}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: unknown };
    if (typeof data.tag_name !== "string") return null;
    return data.tag_name;
  } catch {
    return null;
  }
}

/**
 * Compare two dotted version strings (e.g. "0.2.0" and "0.1.3").
 * Returns negative if a < b, positive if a > b, 0 if equal.
 * Non-numeric / missing components default to 0, so `0.2` == `0.2.0`.
 * Pre-release suffixes (`-beta.1`) are stripped before comparison.
 */
export function compareVersions(a: string, b: string): number {
  const strip = (s: string): number[] =>
    s
      .replace(/^v/, "")
      .split("-")[0]
      .split(".")
      .map((p) => {
        const n = Number.parseInt(p, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const pa = strip(a);
  const pb = strip(b);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

/** Strip a leading "v" so "v0.2.0" and "0.2.0" compare cleanly. */
export function normalizeTag(tag: string): string {
  return tag.replace(/^v/, "");
}

/**
 * Resolve the freshest known latest version. Reads cache; if stale (or
 * missing), tries the network once with a 1.5s budget and refreshes the
 * cache on success. Always returns — never throws.
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateStatus> {
  const status: UpdateStatus = {
    currentVersion: normalizeTag(currentVersion),
    latestVersion: null,
    behind: false,
  };

  const cached = await readCache();
  let latestTag = isFresh(cached) ? cached?.latestTag ?? null : null;

  if (!latestTag) {
    const fetched = await fetchLatestTag(currentVersion);
    if (fetched) {
      latestTag = fetched;
      await writeCache({ checkedAt: new Date().toISOString(), latestTag: fetched });
    } else if (cached) {
      // Network down but we have a stale cache — better than nothing.
      latestTag = cached.latestTag;
    }
  }

  if (!latestTag) return status;

  status.latestVersion = normalizeTag(latestTag);
  status.behind = compareVersions(status.currentVersion, status.latestVersion) < 0;
  return status;
}

/**
 * Print a one-line stderr banner if we're behind. Called from cli.ts after
 * the verb's action has finished, so it never interferes with stdout.
 */
export async function maybePrintUpdateBanner(currentVersion: string): Promise<void> {
  if (shouldSkipAutomaticBanner()) return;
  const status = await checkForUpdate(currentVersion);
  if (!status.behind || !status.latestVersion) return;
  const msg = `A new az-where is available: ${status.latestVersion} (you're on ${status.currentVersion}). Run 'azw update' for install steps, or set AZ_WHERE_NO_UPDATE_CHECK=1 to silence this.`;
  process.stderr.write(`\n${colorEnabled() ? c.dim(msg) : msg}\n`);
}
