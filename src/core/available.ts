import { armList, getToken } from "./arm.js";
import type { PolicyCheck } from "./policy.js";
import { Progress } from "./progress.js";
import {
  isSkuBlockedForSubscription,
  skuMatchesFamilyPrefix,
  skuMemoryGiB,
  skuVcpus,
} from "./sku.js";
import type { AzLocation, AzVmSku, AzVmUsage, RegionVerdict } from "./types.js";

export interface AvailableScanOptions {
  family: string;
  locations: AzLocation[];
  refresh?: boolean;
  includeAll?: boolean;
  concurrency?: number;
  policy?: PolicyCheck;
}

export interface AvailableRegion extends Omit<RegionVerdict, "family"> {
  used: number | null;
  limit: number | null;
  free: number | null;
}

export interface AvailableSku {
  sku: string;
  family: string;
  vcpus: number | null;
  memoryGiB: number | null;
  regions: AvailableRegion[];
}

export interface CandidateRow {
  sku: string;
  family: string;
  vcpus: number | null;
  memoryGiB: number | null;
  region: AvailableRegion;
}

export interface AvailableScanResult {
  skus: AvailableSku[];
  elapsedMs: number;
}

export async function scanAvailableFamily(
  opts: AvailableScanOptions,
): Promise<AvailableScanResult> {
  const concurrency = Math.min(opts.concurrency ?? 16, opts.locations.length);
  const progress = new Progress(opts.locations.length, `Finding available ${opts.family} family`);

  await getToken();

  const results: CandidateRow[][] = new Array(opts.locations.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= opts.locations.length) return;
      const loc = opts.locations[i];
      try {
        const rows = await scanAvailableLocation(
          loc,
          opts.family,
          Boolean(opts.refresh),
          opts.policy,
        );
        results[i] = rows;
        progress.tick(loc.name, availableProgressStatus(rows));
      } catch {
        results[i] = [];
        progress.tick(loc.name, "err");
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  progress.done();

  return {
    skus: groupAvailableRows(results.flat(), opts.locations, Boolean(opts.includeAll), opts.policy),
    elapsedMs: progress.elapsedMs(),
  };
}

function availableProgressStatus(rows: CandidateRow[]): "ok" | "sub" | "off" | "err" {
  if (rows.some((r) => r.region.verdict === "AVAILABLE")) return "ok";
  if (
    rows.some((r) => r.region.verdict === "POLICY_DENIED" || r.region.verdict === "BLOCKED_FOR_SUB")
  ) {
    return "sub";
  }
  if (rows.length === 0 || rows.every((r) => r.region.verdict === "SKU_NOT_OFFERED")) return "off";
  return "ok";
}

export async function scanAvailableLocation(
  location: AzLocation,
  family: string,
  refresh: boolean,
  policy?: PolicyCheck,
): Promise<CandidateRow[]> {
  const skus = await armList<AzVmSku>(
    `/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=location eq '${encodeURIComponent(
      location.name,
    )}'`,
    { refresh },
  );

  const matches = skus
    .filter((s) => s.resourceType === "virtualMachines")
    .filter((s) => skuMatchesFamilyPrefix(s.name, family));
  if (matches.length === 0) return [];

  const policyAllowed = policy ? policy.isAllowed(location.name) : null;
  let usages: AzVmUsage[] | null = null;
  if (policyAllowed !== false && matches.some((s) => !isSkuBlockedForSubscription(s))) {
    usages = await armList<AzVmUsage>(
      `/providers/Microsoft.Compute/locations/${encodeURIComponent(location.name)}/usages?api-version=2021-07-01`,
      { cache: false },
    ).catch(() => null);
  }

  return matches.map((sku) => {
    const familyName = sku.family ?? "";
    return {
      sku: sku.name,
      family: familyName,
      vcpus: skuVcpus(sku),
      memoryGiB: skuMemoryGiB(sku),
      region: classifyAvailableSkuRegion({
        location,
        skuOffered: true,
        family: familyName,
        requiredVcpus: skuVcpus(sku) ?? 1,
        usage: usages?.find((u) => u.name?.value === familyName),
        blockedForSubscription: isSkuBlockedForSubscription(sku),
        policyAllowed,
        policyReason: policy?.reason(location.name) ?? null,
      }),
    };
  });
}

export function classifyAvailableSkuRegion(input: {
  location: AzLocation;
  skuOffered: boolean;
  family: string;
  requiredVcpus: number;
  usage?: AzVmUsage;
  blockedForSubscription?: boolean;
  policyAllowed: boolean | null;
  policyReason: string | null;
}): AvailableRegion {
  const base = availableRegionBase(input.location, input.policyAllowed, input.policyReason);
  if (input.policyAllowed === false) {
    return { ...base, skuOffered: input.skuOffered, verdict: "POLICY_DENIED" };
  }
  if (!input.skuOffered) {
    return { ...base, skuOffered: false, verdict: "SKU_NOT_OFFERED" };
  }
  if (input.blockedForSubscription) {
    return { ...base, skuOffered: false, verdict: "BLOCKED_FOR_SUB" };
  }
  if (!input.usage) {
    return { ...base, skuOffered: true, verdict: "QUOTA_UNKNOWN" };
  }

  const free = input.usage.limit - input.usage.currentValue;
  return {
    ...base,
    skuOffered: true,
    used: input.usage.currentValue,
    limit: input.usage.limit,
    free,
    verdict: free >= input.requiredVcpus ? "AVAILABLE" : "FULL",
  };
}

export function groupAvailableRows(
  rows: CandidateRow[],
  locations: AzLocation[],
  includeAll: boolean,
  policy?: PolicyCheck,
): AvailableSku[] {
  const bySku = new Map<string, AvailableSku>();
  const seenRegionBySku = new Map<string, Set<string>>();

  for (const row of rows) {
    const existing = bySku.get(row.sku) ?? {
      sku: row.sku,
      family: row.family,
      vcpus: row.vcpus,
      memoryGiB: row.memoryGiB,
      regions: [],
    };
    existing.regions.push(row.region);
    bySku.set(row.sku, existing);

    const seen = seenRegionBySku.get(row.sku) ?? new Set<string>();
    seen.add(row.region.region);
    seenRegionBySku.set(row.sku, seen);
  }

  if (includeAll) {
    for (const sku of bySku.values()) {
      const seen = seenRegionBySku.get(sku.sku) ?? new Set<string>();
      for (const location of locations) {
        if (seen.has(location.name)) continue;
        const policyAllowed = policy ? policy.isAllowed(location.name) : null;
        sku.regions.push(
          classifyAvailableSkuRegion({
            location,
            skuOffered: false,
            family: sku.family,
            requiredVcpus: sku.vcpus ?? 1,
            policyAllowed,
            policyReason: policy?.reason(location.name) ?? null,
          }),
        );
      }
    }
  }

  const skus = [...bySku.values()]
    .map((sku) => ({
      ...sku,
      regions: sortAvailableRegions(
        includeAll ? sku.regions : sku.regions.filter((r) => r.verdict === "AVAILABLE"),
      ),
    }))
    .filter((sku) => sku.regions.length > 0);

  return skus.sort((a, b) => {
    const av = a.vcpus ?? Number.MAX_SAFE_INTEGER;
    const bv = b.vcpus ?? Number.MAX_SAFE_INTEGER;
    if (av !== bv) return av - bv;
    const am = a.memoryGiB ?? Number.MAX_SAFE_INTEGER;
    const bm = b.memoryGiB ?? Number.MAX_SAFE_INTEGER;
    if (am !== bm) return am - bm;
    return a.sku.localeCompare(b.sku);
  });
}

export function formatAvailableFamily(input: string): string {
  return `${input.trim()}-family`;
}

function sortAvailableRegions(regions: AvailableRegion[]): AvailableRegion[] {
  const rank: Record<RegionVerdict["verdict"], number> = {
    AVAILABLE: 0,
    QUOTA_UNKNOWN: 1,
    FULL: 2,
    BLOCKED_FOR_SUB: 3,
    POLICY_DENIED: 4,
    SKU_NOT_OFFERED: 5,
  };
  return [...regions].sort((a, b) => {
    const r = rank[a.verdict] - rank[b.verdict];
    if (r !== 0) return r;
    return a.region.localeCompare(b.region);
  });
}

function availableRegionBase(
  location: AzLocation,
  policyAllowed: boolean | null,
  policyReason: string | null,
): AvailableRegion {
  return {
    region: location.name,
    displayName: location.displayName,
    geographyGroup: location.metadata?.geographyGroup,
    physicalLocation: location.metadata?.physicalLocation,
    skuOffered: false,
    used: null,
    limit: null,
    free: null,
    policyAllowed,
    policyReason,
    verdict: "SKU_NOT_OFFERED",
  };
}
