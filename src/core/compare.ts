import { armList, getToken } from "./arm.js";
import { classifyAvailableSkuRegion, type AvailableRegion } from "./available.js";
import { c, colorEnabled } from "./color.js";
import { ValidationError } from "./errors.js";
import { shortGeo } from "./geo.js";
import type { PolicyCheck } from "./policy.js";
import { Progress } from "./progress.js";
import { isSkuBlockedForSubscription, normalizeSku, skuMemoryGiB, skuVcpus } from "./sku.js";
import type { AzLocation, AzVmSku, AzVmUsage, RegionVerdict } from "./types.js";

/**
 * `azw compare vm B1s,B2s,D2s_v5 --eu` — a region × size matrix of
 * deployability verdicts.
 *
 * Cost note: the per-region SKU catalog call already returns *every* VM SKU
 * offered in that region, so classifying N requested sizes costs the same two
 * ARM calls per region (skus + usages) as a single-SKU availability scan.
 */

/** Guard against unreadable tables and unbounded per-SKU summary blocks. */
export const MAX_COMPARE_SKUS = 30;

/** Split a comma-separated SKU list into normalized, deduplicated SKU names. */
export function parseSkuList(raw: string): string[] {
  const parts = raw.split(",").map((t) => t.trim());
  if (parts.every((p) => p.length === 0)) {
    throw new ValidationError("Missing SKU list. Try: azw compare vm B1s,B2s,D2s_v5 --eu");
  }
  if (parts.some((p) => p.length === 0)) {
    throw new ValidationError(
      "SKU list contains an empty entry. Try: azw compare vm B1s,B2s,D2s_v5 --eu",
    );
  }
  const skus: string[] = [];
  for (const token of parts) {
    const sku = normalizeSku(token);
    if (!skus.includes(sku)) skus.push(sku);
  }
  if (skus.length > MAX_COMPARE_SKUS) {
    throw new ValidationError(
      `compare vm supports up to ${MAX_COMPARE_SKUS} SKUs per invocation (got ${skus.length}).`,
    );
  }
  return skus;
}

/** One matrix cell: a RegionVerdict-shaped row plus the SKU it belongs to. */
export interface CompareCell extends AvailableRegion {
  sku: string;
}

/** One matrix row: the region plus one cell per requested SKU, in SKU order. */
export interface CompareRegionRow {
  location: AzLocation;
  cells: CompareCell[];
}

/** Region-independent SKU facts, taken from the first region that offers it. */
export interface CompareSkuInfo {
  family: string | null;
  vcpus: number | null;
  memoryGiB: number | null;
}

/**
 * Classify every requested SKU for one location, given the region's SKU
 * catalog and usage rows. Pure: no ARM calls, so tests feed fakes directly.
 * Verdict precedence matches the single-SKU scan: policy → offered →
 * subscription restriction → quota.
 */
export function classifyCompareLocation(input: {
  location: AzLocation;
  skus: string[];
  skuCatalog: AzVmSku[];
  usages: AzVmUsage[] | null;
  policyAllowed: boolean | null;
  policyReason: string | null;
}): CompareCell[] {
  return input.skus.map((sku) => {
    const found = input.skuCatalog.find(
      (s) => s.resourceType === "virtualMachines" && s.name === sku,
    );
    const family = found?.family ?? null;
    return {
      sku,
      ...classifyAvailableSkuRegion({
        location: input.location,
        skuOffered: Boolean(found),
        family: family ?? "",
        requiredVcpus: found ? (skuVcpus(found) ?? 1) : 1,
        usage: family
          ? input.usages?.find((u) => u.name?.value === family)
          : undefined,
        blockedForSubscription: found ? isSkuBlockedForSubscription(found) : false,
        policyAllowed: input.policyAllowed,
        policyReason: input.policyReason,
      }),
    };
  });
}

/**
 * Collect SKU facts (family, vCPUs, memory) from a region's catalog. First
 * region that offers the SKU wins; the values are region-independent.
 */
export function collectSkuInfo(catalog: AzVmSku[], into: Map<string, CompareSkuInfo>): void {
  for (const sku of catalog) {
    if (sku.resourceType !== "virtualMachines") continue;
    if (into.has(sku.name)) continue;
    into.set(sku.name, {
      family: sku.family ?? null,
      vcpus: skuVcpus(sku),
      memoryGiB: skuMemoryGiB(sku),
    });
  }
}

export interface CompareSkuSummary {
  sku: string;
  family: string | null;
  vcpus: number | null;
  memoryGiB: number | null;
  /** Cells in the same order as the region axis of the enclosing result. */
  regions: AvailableRegion[];
  deployableCount: number;
  /** Region names where the verdict is AVAILABLE, in region-axis order. */
  deployableRegions: string[];
  verdictCounts: Record<RegionVerdict["verdict"], number>;
}

/** Pivot region-major rows into per-SKU summaries, preserving SKU order. */
export function summarizeCompare(
  rows: CompareRegionRow[],
  skus: string[],
  skuInfo?: Map<string, CompareSkuInfo>,
): CompareSkuSummary[] {
  return skus.map((sku) => {
    const info = skuInfo?.get(sku) ?? { family: null, vcpus: null, memoryGiB: null };
    const regions: AvailableRegion[] = [];
    const verdictCounts = emptyVerdictCounts();
    for (const row of rows) {
      const cell = row.cells.find((c) => c.sku === sku);
      if (!cell) continue;
      const { sku: _sku, ...region } = cell;
      regions.push(region);
      verdictCounts[cell.verdict]++;
    }
    const deployableRegions = regions
      .filter((r) => r.verdict === "AVAILABLE")
      .map((r) => r.region);
    return {
      sku,
      family: info.family,
      vcpus: info.vcpus,
      memoryGiB: info.memoryGiB,
      regions,
      deployableCount: deployableRegions.length,
      deployableRegions,
      verdictCounts,
    };
  });
}

function emptyVerdictCounts(): Record<RegionVerdict["verdict"], number> {
  return {
    AVAILABLE: 0,
    FULL: 0,
    SKU_NOT_OFFERED: 0,
    BLOCKED_FOR_SUB: 0,
    POLICY_DENIED: 0,
    QUOTA_UNKNOWN: 0,
  };
}

export interface CompareScanOptions {
  skus: string[];
  locations: AzLocation[];
  concurrency?: number;
  refresh?: boolean;
  policy?: PolicyCheck;
}

export interface CompareScanResult {
  /** Region axis, sorted by geography group then region name (stable). */
  regionRows: CompareRegionRow[];
  /** Per-SKU summaries in the user's requested order. */
  skus: CompareSkuSummary[];
  elapsedMs: number;
}

/** Parallel per-region scan, mirroring scanRegions: shared token, worker pool. */
export async function scanCompare(opts: CompareScanOptions): Promise<CompareScanResult> {
  const concurrency = Math.min(opts.concurrency ?? 16, opts.locations.length);
  const progress = new Progress(
    opts.locations.length,
    `Comparing ${opts.skus.length} VM size${opts.skus.length === 1 ? "" : "s"}`,
  );

  // Mint the token once up-front so the first worker doesn't block on it.
  await getToken();

  const skuInfo = new Map<string, CompareSkuInfo>();
  const results: (CompareRegionRow | undefined)[] = new Array(opts.locations.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= opts.locations.length) return;
      const loc = opts.locations[i];
      let row: CompareRegionRow;
      let status: "ok" | "sub" | "off" | "err";
      try {
        const scanned = await scanCompareLocation(loc, opts.skus, Boolean(opts.refresh), opts.policy, skuInfo);
        row = { location: loc, cells: scanned.cells };
        status = scanned.status;
      } catch {
        row = {
          location: loc,
          cells: opts.skus.map((sku) => ({
            sku,
            ...classifyAvailableSkuRegion({
              location: loc,
              skuOffered: false,
              family: "",
              requiredVcpus: 1,
              policyAllowed: opts.policy ? opts.policy.isAllowed(loc.name) : null,
              policyReason: opts.policy?.reason(loc.name) ?? null,
            }),
          })),
        };
        // The ARM call failed; quota is the honest verdict for every cell.
        for (const cell of row.cells) cell.verdict = "QUOTA_UNKNOWN";
        status = "err";
      }
      results[i] = row;
      progress.tick(loc.name, status);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  progress.done();

  const regionRows = results
    .filter((r): r is CompareRegionRow => r !== undefined)
    .sort((a, b) => {
      const g = (a.location.metadata?.geographyGroup ?? "").localeCompare(
        b.location.metadata?.geographyGroup ?? "",
      );
      if (g !== 0) return g;
      return a.location.name.localeCompare(b.location.name);
    });

  return {
    regionRows,
    skus: summarizeCompare(regionRows, opts.skus, skuInfo),
    elapsedMs: progress.elapsedMs(),
  };
}

async function scanCompareLocation(
  location: AzLocation,
  skus: string[],
  refresh: boolean,
  policy: PolicyCheck | undefined,
  skuInfo: Map<string, CompareSkuInfo>,
): Promise<{ cells: CompareCell[]; status: "ok" | "sub" | "off" | "err" }> {
  const policyAllowed = policy ? policy.isAllowed(location.name) : null;
  const policyReason = policy?.reason(location.name) ?? null;

  // Policy-denied regions need no ARM calls — every SKU is denied there.
  if (policyAllowed === false) {
    return {
      cells: classifyCompareLocation({
        location,
        skus,
        skuCatalog: [],
        usages: null,
        policyAllowed,
        policyReason,
      }),
      status: "sub",
    };
  }

  const catalog = await armList<AzVmSku>(
    `/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=location eq '${encodeURIComponent(
      location.name,
    )}'`,
    { refresh },
  );
  collectSkuInfo(catalog, skuInfo);

  const offered = skus.some((sku) =>
    catalog.some((s) => s.resourceType === "virtualMachines" && s.name === sku),
  );
  const usages = offered
    ? await armList<AzVmUsage>(
        `/providers/Microsoft.Compute/locations/${encodeURIComponent(location.name)}/usages?api-version=2021-07-01`,
        { cache: false },
      ).catch(() => null)
    : null;

  const cells = classifyCompareLocation({
    location,
    skus,
    skuCatalog: catalog,
    usages,
    policyAllowed,
    policyReason,
  });

  let status: "ok" | "sub" | "off" | "err" = "ok";
  if (cells.some((cell) => cell.verdict === "AVAILABLE")) status = "ok";
  else if (cells.some((cell) => cell.verdict === "BLOCKED_FOR_SUB")) status = "sub";
  else if (cells.every((cell) => cell.verdict === "SKU_NOT_OFFERED")) status = "off";
  return { cells, status };
}

/** ── Human table rendering ─────────────────────────────────────────────────── */

/** Column header for a SKU: drop the `Standard_` prefix everyone omits. */
export function compareColumnLabel(sku: string): string {
  return sku.replace(/^Standard_/, "");
}

const COMPARE_CELL_LABEL: Record<RegionVerdict["verdict"], string> = {
  AVAILABLE: "✓",
  FULL: "quota",
  SKU_NOT_OFFERED: "n/a",
  BLOCKED_FOR_SUB: "sub",
  POLICY_DENIED: "policy",
  QUOTA_UNKNOWN: "?",
};

export function compareCellLabel(v: RegionVerdict["verdict"]): string {
  const label = COMPARE_CELL_LABEL[v];
  if (!colorEnabled()) return label;
  switch (v) {
    case "AVAILABLE":
      return c.green(c.bold(label));
    case "FULL":
    case "BLOCKED_FOR_SUB":
    case "POLICY_DENIED":
      return c.red(label);
    case "SKU_NOT_OFFERED":
      return c.dim(label);
    case "QUOTA_UNKNOWN":
      return c.yellow(label);
  }
}

export function compareLegendLine(): string {
  const legend =
    "✓ deployable · quota full · n/a not offered · sub sub-blocked · policy denied · ? quota unknown";
  return colorEnabled() ? c.dim(legend) : legend;
}

/**
 * Regions where every requested SKU is deployable first, then by how many
 * SKUs deploy there, then geo/name — so "regions that can host any of my
 * fallbacks" float to the top of the matrix.
 */
export function sortCompareRowsForTable(rows: CompareRegionRow[]): CompareRegionRow[] {
  return [...rows].sort((a, b) => {
    const allA = a.cells.every((cell) => cell.verdict === "AVAILABLE");
    const allB = b.cells.every((cell) => cell.verdict === "AVAILABLE");
    if (allA !== allB) return allA ? -1 : 1;
    const okA = a.cells.filter((cell) => cell.verdict === "AVAILABLE").length;
    const okB = b.cells.filter((cell) => cell.verdict === "AVAILABLE").length;
    if (okA !== okB) return okB - okA;
    const g = (a.location.metadata?.geographyGroup ?? "").localeCompare(
      b.location.metadata?.geographyGroup ?? "",
    );
    if (g !== 0) return g;
    return a.location.name.localeCompare(b.location.name);
  });
}

/** Build the human matrix (region rows × SKU columns) for printTable. */
export function buildCompareTable(
  rows: CompareRegionRow[],
  skus: string[],
): { headers: string[]; body: string[][] } {
  const headers = ["REGION", "GEO", ...skus.map(compareColumnLabel)];
  const body = rows.map((row) => [
    row.location.name,
    shortGeo(row.location.metadata?.geographyGroup),
    ...skus.map((sku) => {
      const cell = row.cells.find((c) => c.sku === sku);
      return cell ? compareCellLabel(cell.verdict) : "";
    }),
  ]);
  return { headers, body };
}

/** Region names where every requested SKU is deployable, in row order. */
export function allDeployableRegions(rows: CompareRegionRow[]): string[] {
  return rows
    .filter((row) => row.cells.every((cell) => cell.verdict === "AVAILABLE"))
    .map((row) => row.location.name);
}
