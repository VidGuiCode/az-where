import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const ARM_CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry<T> {
  createdAt: string;
  value: T;
}

interface ArmCacheStats {
  hits: number;
  misses: number;
  writes: number;
  refreshes: number;
}

const stats: ArmCacheStats = {
  hits: 0,
  misses: 0,
  writes: 0,
  refreshes: 0,
};

export interface CacheSummary {
  used: boolean;
  refreshed: boolean;
  ttlSeconds: number;
}

export function armCacheSummary(): CacheSummary {
  return {
    used: stats.hits > 0,
    refreshed: stats.refreshes > 0,
    ttlSeconds: Math.round(ARM_CACHE_TTL_MS / 1000),
  };
}

export function resetArmCacheStatsForTests(): void {
  stats.hits = 0;
  stats.misses = 0;
  stats.writes = 0;
  stats.refreshes = 0;
}

export function armCacheKey(subscriptionId: string, requestPath: string): string {
  return createHash("sha256").update(`${subscriptionId}\n${requestPath}`).digest("hex");
}

export function isArmCacheablePath(requestPath: string): boolean {
  if (requestPath.startsWith("http")) return false;
  if (requestPath.startsWith("/locations?")) return true;
  return requestPath.startsWith("/providers/Microsoft.Compute/skus?");
}

export async function readArmCache<T>(
  subscriptionId: string,
  requestPath: string,
  refresh = false,
): Promise<T | undefined> {
  if (refresh) {
    stats.refreshes++;
    return undefined;
  }

  try {
    const raw = await fs.readFile(armCacheFile(subscriptionId, requestPath), "utf-8");
    const parsed = JSON.parse(raw) as Partial<CacheEntry<T>>;
    if (typeof parsed.createdAt !== "string" || parsed.value === undefined) {
      stats.misses++;
      return undefined;
    }

    const age = Date.now() - Date.parse(parsed.createdAt);
    if (!Number.isFinite(age) || age < 0 || age > ARM_CACHE_TTL_MS) {
      stats.misses++;
      return undefined;
    }

    stats.hits++;
    return parsed.value;
  } catch {
    stats.misses++;
    return undefined;
  }
}

export async function writeArmCache<T>(
  subscriptionId: string,
  requestPath: string,
  value: T,
): Promise<void> {
  try {
    const file = armCacheFile(subscriptionId, requestPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ createdAt: new Date().toISOString(), value }, null, 2),
      "utf-8",
    );
    stats.writes++;
  } catch {
    // Cache is opportunistic. Read-only disks or corrupt state should never
    // break the actual ARM request path.
  }
}

export function armCacheFile(subscriptionId: string, requestPath: string): string {
  return path.join(cacheRoot(), `${armCacheKey(subscriptionId, requestPath)}.json`);
}

function cacheRoot(): string {
  if (process.env.AZ_WHERE_CACHE_DIR) {
    return path.join(process.env.AZ_WHERE_CACHE_DIR, "arm-cache");
  }

  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "az-where", "arm-cache");
  }

  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return path.join(xdg, "az-where", "arm-cache");
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "az-where", "arm-cache");
  }
  return path.join(os.homedir(), ".cache", "az-where", "arm-cache");
}
