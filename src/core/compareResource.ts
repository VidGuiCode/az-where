import { c, colorEnabled } from "./color.js";
import { ValidationError } from "./errors.js";
import { shortGeo } from "./geo.js";
import type { PolicyCheck } from "./policy.js";
import {
  classifyResourceType,
  listProviderCatalog,
  resolveResourceType,
  type ResolvedResourceType,
} from "./resources.js";
import type { AzLocation, AzProvider, ResourceAvailabilityVerdict } from "./types.js";

/**
 * `azw compare resource storage-account,key-vault,aks --eu` — a region × type
 * matrix of generic resource availability verdicts, mirroring `compare vm`
 * (0.4.5) with the resource vocabulary and `availability` confidence on every
 * row — never deployability.
 *
 * Cost note: this reuses the provider-catalog engine split out in 0.4.8
 * (`classifyResourceType` + `listProviderCatalog`) — one shared catalog call
 * per run, so comparing N types costs the same as one `check resource` scan.
 * There is nothing to parallelize, hence no `--concurrency` flag.
 */

/** Guard against unreadable tables, matching `compare vm`. */
export const MAX_COMPARE_TARGETS = 30;

/**
 * Split a comma-separated target list into validated, deduplicated resource
 * targets (aliases or raw Azure types). Deduplication is case-insensitive on
 * the resolved resource type, so `storage-account`,
 * `Microsoft.Storage/storageAccounts`, and case variants collapse to the
 * first form given.
 */
export function parseResourceTargetList(raw: string): string[] {
  const parts = raw.split(",").map((t) => t.trim());
  if (parts.every((p) => p.length === 0)) {
    throw new ValidationError(
      "Missing resource list. Try: azw compare resource storage-account,key-vault,aks --eu",
    );
  }
  if (parts.some((p) => p.length === 0)) {
    throw new ValidationError(
      "Resource list contains an empty entry. Try: azw compare resource storage-account,key-vault,aks --eu",
    );
  }
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const token of parts) {
    const resolved = resolveResourceType(token);
    if (!resolved) {
      throw new ValidationError(
        `Unknown resource alias or invalid Azure resource type '${token}'. Try: storage-account or Microsoft.Storage/storageAccounts`,
      );
    }
    const key = resolved.resourceType.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(token);
  }
  if (targets.length > MAX_COMPARE_TARGETS) {
    throw new ValidationError(
      `compare resource supports up to ${MAX_COMPARE_TARGETS} resource types per invocation (got ${targets.length}).`,
    );
  }
  return targets;
}

/** One matrix row: the location plus one cell per requested target, in target order. */
export interface CompareResourceRegionRow {
  location: AzLocation;
  /** Verdict rows; each row's `target` names the column it belongs to. */
  cells: ResourceAvailabilityVerdict[];
}

/** Per-target summary pivoted off the shared region axis, in request order. */
export interface CompareResourceSummary {
  /** Target as the user gave it (first occurrence after dedupe). */
  target: string;
  resolved: ResolvedResourceType;
  /** Cells in the same order as the region axis of the enclosing result. */
  regions: ResourceAvailabilityVerdict[];
  /** Region names where the verdict is RESOURCE_SUPPORTED, in axis order. */
  supportedRegions: string[];
  supportedCount: number;
  verdictCounts: Record<ResourceAvailabilityVerdict["verdict"], number>;
}

/**
 * Classify every requested target across the given locations against an
 * already-fetched provider catalog. Pure — no ARM calls — so tests feed fake
 * catalogs directly. Verdict precedence matches `check resource`:
 * policy → provider-catalog advertisement.
 */
export function classifyCompareResources(input: {
  targets: string[];
  locations: AzLocation[];
  providers: AzProvider[];
  policy?: PolicyCheck;
}): { regionRows: CompareResourceRegionRow[]; summaries: CompareResourceSummary[] } {
  const axis = sortLocations(input.locations);
  const summaries: CompareResourceSummary[] = [];
  for (const target of input.targets) {
    const classified = classifyResourceType({
      target,
      locations: axis,
      providers: input.providers,
      policy: input.policy,
    });
    // parseResourceTargetList already rejected unresolvable targets.
    if (!classified) continue;
    const verdictCounts = emptyResourceVerdictCounts();
    for (const row of classified.rows) verdictCounts[row.verdict]++;
    const supportedRegions = classified.rows
      .filter((r) => r.verdict === "RESOURCE_SUPPORTED")
      .map((r) => r.region);
    summaries.push({
      target,
      resolved: classified.resolved,
      regions: classified.rows,
      supportedRegions,
      supportedCount: supportedRegions.length,
      verdictCounts,
    });
  }
  const regionRows = axis.map((location, i) => ({
    location,
    cells: summaries.map((summary) => summary.regions[i]!),
  }));
  return { regionRows, summaries };
}

export interface CompareResourceScanResult {
  /** Region axis, sorted by geography group then region name (stable). */
  regionRows: CompareResourceRegionRow[];
  /** Per-target summaries in the user's requested order. */
  targets: CompareResourceSummary[];
  elapsedMs: number;
}

/**
 * Fetch the provider catalog once and classify every requested target against
 * it — one cached ARM call per run (one live call with `--refresh`),
 * regardless of how many types are compared.
 */
export async function scanCompareResources(opts: {
  targets: string[];
  locations: AzLocation[];
  refresh?: boolean;
  policy?: PolicyCheck;
}): Promise<CompareResourceScanResult> {
  const started = Date.now();
  const providers = await listProviderCatalog(Boolean(opts.refresh));
  const { regionRows, summaries } = classifyCompareResources({
    targets: opts.targets,
    locations: opts.locations,
    providers,
    policy: opts.policy,
  });
  return {
    regionRows,
    targets: summaries,
    elapsedMs: Date.now() - started,
  };
}

function sortLocations(locations: AzLocation[]): AzLocation[] {
  return [...locations].sort((a, b) => {
    const g = (a.metadata?.geographyGroup ?? "").localeCompare(b.metadata?.geographyGroup ?? "");
    if (g !== 0) return g;
    return a.name.localeCompare(b.name);
  });
}

function emptyResourceVerdictCounts(): Record<ResourceAvailabilityVerdict["verdict"], number> {
  return { RESOURCE_SUPPORTED: 0, RESOURCE_NOT_SUPPORTED: 0, POLICY_DENIED: 0 };
}

/** ── Human table rendering ─────────────────────────────────────────────────── */

/**
 * Column header for a target: aliases stay as typed, raw Azure types use the
 * type path (`Microsoft.Web/sites` → `sites`) so columns stay readable.
 */
export function compareResourceColumnLabel(target: string): string {
  const resolved = resolveResourceType(target);
  return resolved?.alias ?? resolved?.typePath ?? target;
}

const COMPARE_RESOURCE_CELL_LABEL: Record<ResourceAvailabilityVerdict["verdict"], string> = {
  RESOURCE_SUPPORTED: "✓",
  RESOURCE_NOT_SUPPORTED: "n/a",
  POLICY_DENIED: "policy",
};

export function compareResourceCellLabel(v: ResourceAvailabilityVerdict["verdict"]): string {
  const label = COMPARE_RESOURCE_CELL_LABEL[v];
  if (!colorEnabled()) return label;
  switch (v) {
    case "RESOURCE_SUPPORTED":
      return c.green(c.bold(label));
    case "POLICY_DENIED":
      return c.red(label);
    case "RESOURCE_NOT_SUPPORTED":
      return c.dim(label);
  }
}

export function compareResourceLegendLine(): string {
  const legend =
    "✓ supported · n/a not advertised · policy denied — availability, not deployability";
  return colorEnabled() ? c.dim(legend) : legend;
}

/**
 * Regions where every requested type is supported first, then by how many
 * types are supported there, then geo/name — so "regions that can host all of
 * my resources" float to the top of the matrix.
 */
export function sortCompareResourceRowsForTable(
  rows: CompareResourceRegionRow[],
): CompareResourceRegionRow[] {
  return [...rows].sort((a, b) => {
    const allA = a.cells.every((cell) => cell.verdict === "RESOURCE_SUPPORTED");
    const allB = b.cells.every((cell) => cell.verdict === "RESOURCE_SUPPORTED");
    if (allA !== allB) return allA ? -1 : 1;
    const okA = a.cells.filter((cell) => cell.verdict === "RESOURCE_SUPPORTED").length;
    const okB = b.cells.filter((cell) => cell.verdict === "RESOURCE_SUPPORTED").length;
    if (okA !== okB) return okB - okA;
    const g = (a.location.metadata?.geographyGroup ?? "").localeCompare(
      b.location.metadata?.geographyGroup ?? "",
    );
    if (g !== 0) return g;
    return a.location.name.localeCompare(b.location.name);
  });
}

/** Build the human matrix (region rows × target columns) for printTable. */
export function buildCompareResourceTable(
  rows: CompareResourceRegionRow[],
  targets: string[],
): { headers: string[]; body: string[][] } {
  const headers = ["REGION", "GEO", ...targets.map(compareResourceColumnLabel)];
  const body = rows.map((row) => [
    row.location.name,
    shortGeo(row.location.metadata?.geographyGroup),
    ...targets.map((target) => {
      const cell = row.cells.find((c) => c.target === target);
      return cell ? compareResourceCellLabel(cell.verdict) : "";
    }),
  ]);
  return { headers, body };
}

/** Region names where every requested type is supported, in row order. */
export function allSupportedRegions(rows: CompareResourceRegionRow[]): string[] {
  return rows
    .filter((row) => row.cells.every((cell) => cell.verdict === "RESOURCE_SUPPORTED"))
    .map((row) => row.location.name);
}
