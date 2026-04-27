import { armList, getToken } from "./arm.js";
import type { PolicyCheck } from "./policy.js";
import { Progress } from "./progress.js";
import { isSkuBlockedForSubscription, skuVcpus } from "./sku.js";
import type { AzLocation, AzVmSku, AzVmUsage, RegionVerdict } from "./types.js";

export interface ScanOptions {
  sku: string;
  locations: AzLocation[];
  concurrency?: number;
  refresh?: boolean;
  policy?: PolicyCheck;
  /**
   * Stop dispatching new regions once any completed result matches. In-flight
   * calls still finish; their results are kept. Used by `pick`, which only
   * needs a single AVAILABLE verdict.
   */
  stopWhen?: (result: RegionVerdict) => boolean;
}

export interface ScanResult {
  rows: RegionVerdict[];
  elapsedMs: number;
}

/**
 * Parallel per-region scan over ARM REST, not the `az` CLI — see [arm.ts] for
 * why spawning `az` per region was the bottleneck. With direct fetch, 17
 * regions typically finish in ~3-5s instead of ~4 minutes.
 *
 * Per region we fetch skus filtered by location and, only if the SKU is
 * actually offered, a follow-up usage call to check quota.
 */
export async function scanRegions(opts: ScanOptions): Promise<ScanResult> {
  const { sku, locations, stopWhen } = opts;
  const concurrency = Math.min(opts.concurrency ?? 16, locations.length);
  const progress = new Progress(locations.length, `Scanning for ${sku}`);

  // Mint the token once up-front so the first worker doesn't block on it.
  await getToken();

  const results: (RegionVerdict | undefined)[] = new Array(locations.length);
  let cursor = 0;
  let stopped = false;

  async function worker(): Promise<void> {
    while (!stopped) {
      const i = cursor++;
      if (i >= locations.length) return;
      const loc = locations[i];
      let v: RegionVerdict;
      let status: "ok" | "sub" | "off" | "err";
      try {
        v = await scanOne(loc, sku, Boolean(opts.refresh), opts.policy);
        status = verdictStatus(v.verdict);
      } catch (err) {
        v = errorVerdict(loc, err);
        status = "err";
      }
      results[i] = v;
      progress.tick(loc.name, status);
      if (stopWhen?.(v)) stopped = true;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  progress.done();
  const rows = results.filter((r): r is RegionVerdict => r !== undefined);
  return { rows, elapsedMs: progress.elapsedMs() };
}

/**
 * Reason hint for the progress log line so a ✗ discloses *why*:
 *   ok  — query succeeded (even if quota-full; it answered)
 *   sub — subscription is blocked in this region
 *   sub — Azure Policy or subscription restrictions block this region
 *   off — Azure doesn't offer the SKU here
 *   err — ARM call failed
 */
function verdictStatus(v: RegionVerdict["verdict"]): "ok" | "sub" | "off" | "err" {
  if (v === "BLOCKED_FOR_SUB" || v === "POLICY_DENIED") return "sub";
  if (v === "SKU_NOT_OFFERED") return "off";
  return "ok";
}

async function scanOne(
  location: AzLocation,
  sku: string,
  refresh: boolean,
  policy?: PolicyCheck,
): Promise<RegionVerdict> {
  const rawBase = baseVerdict(location);
  const base = policy ? { ...rawBase, policyAllowed: true } : rawBase;
  if (policy && !policy.isAllowed(location.name)) {
    return {
      ...base,
      policyAllowed: false,
      policyReason: policy.reason(location.name),
      verdict: "POLICY_DENIED",
    };
  }

  const skus = await armList<AzVmSku>(
    `/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=location eq '${encodeURIComponent(
      location.name,
    )}'`,
    { refresh },
  );

  const vmSku = skus.find((s) => s.resourceType === "virtualMachines" && s.name === sku);
  if (!vmSku) {
    return { ...base, skuOffered: false, verdict: "SKU_NOT_OFFERED" };
  }

  if (isSkuBlockedForSubscription(vmSku)) {
    return {
      ...base,
      skuOffered: false,
      family: vmSku.family ?? null,
      verdict: "BLOCKED_FOR_SUB",
    };
  }

  const usages = await armList<AzVmUsage>(
    `/providers/Microsoft.Compute/locations/${encodeURIComponent(location.name)}/usages?api-version=2021-07-01`,
    { cache: false },
  ).catch(() => [] as AzVmUsage[]);

  const family = vmSku.family ?? null;
  const usage = family ? usages.find((u) => u.name?.value === family) : undefined;
  if (!usage) {
    return { ...base, skuOffered: true, family, verdict: "QUOTA_UNKNOWN" };
  }

  const free = usage.limit - usage.currentValue;
  const requiredVcpus = skuVcpus(vmSku) ?? 1;
  return {
    ...base,
    skuOffered: true,
    family,
    used: usage.currentValue,
    limit: usage.limit,
    free,
    verdict: free >= requiredVcpus ? "AVAILABLE" : "FULL",
  };
}

function baseVerdict(location: AzLocation): RegionVerdict {
  return {
    region: location.name,
    displayName: location.displayName,
    geographyGroup: location.metadata?.geographyGroup,
    physicalLocation: location.metadata?.physicalLocation,
    skuOffered: false,
    family: null,
    used: null,
    limit: null,
    free: null,
    policyAllowed: null,
    policyReason: null,
    verdict: "SKU_NOT_OFFERED",
  };
}

function errorVerdict(location: AzLocation, _err: unknown): RegionVerdict {
  return {
    ...baseVerdict(location),
    verdict: "QUOTA_UNKNOWN",
    skuOffered: false,
  };
}

/** Sort: deployable first, then unknown/partial, then hard-no. Within each, by geo then region. */
export function sortVerdicts(rows: RegionVerdict[]): RegionVerdict[] {
  const rank: Record<RegionVerdict["verdict"], number> = {
    AVAILABLE: 0,
    QUOTA_UNKNOWN: 1,
    FULL: 2,
    BLOCKED_FOR_SUB: 3,
    POLICY_DENIED: 4,
    SKU_NOT_OFFERED: 5,
  };
  return [...rows].sort((a, b) => {
    const r = rank[a.verdict] - rank[b.verdict];
    if (r !== 0) return r;
    const g = (a.geographyGroup ?? "").localeCompare(b.geographyGroup ?? "");
    if (g !== 0) return g;
    return a.region.localeCompare(b.region);
  });
}
