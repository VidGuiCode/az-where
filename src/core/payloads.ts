/**
 * Stable JSON payload builders for the contract-documented commands. Every
 * command serializes through these so the field names and their order are
 * pinned in one place (and by tests/core/payloads.test.ts) instead of living
 * as inline literals in command files.
 *
 * Evolution rule (see docs/json-contracts.md): additive-only within
 * schemaVersion 1 — new fields may be appended, existing fields are never
 * renamed or removed. Fields added in 0.4.6 are marked on the row types.
 */

import type { CacheSummary } from "./cache.js";
import type { CompareResourceSummary } from "./compareResource.js";
import { explainResourceVerdict, explainVmVerdict } from "./explain.js";
import type { IacFormat, IacSkippedResource, IacSkippedStorageResource } from "./iac.js";
import type { PolicySummary } from "./policy.js";
import type { ResolvedResourceType } from "./resources.js";
import type { StorageVerdict } from "./storage.js";
import type { ResourceSuggestion, Suggestion } from "./suggest.js";
import type { AzLocation, RegionVerdict, ResourceAvailabilityVerdict } from "./types.js";
import {
  countResourceVerdicts,
  countStorageVerdicts,
  countVerdicts,
  type VerifyResourceResultRow,
  type VerifyResultRow,
  type VerifyStorageResultRow,
} from "./verify.js";

export interface CheckVmPayload {
  schemaVersion: 1;
  kind: "check";
  resourceKind: "vm";
  target: string;
  region: string;
  verdict: RegionVerdict["verdict"];
  confidence: "deployability";
  cache: CacheSummary;
  policy: PolicySummary;
  checks: RegionVerdict;
  /** Factual reason + optional hint for this verdict. Since 0.4.6. */
  explanation: ReturnType<typeof explainVmVerdict>;
}

export function buildCheckVmPayload(
  sku: string,
  row: RegionVerdict,
  cache: CacheSummary,
  policy: PolicySummary,
): CheckVmPayload {
  return {
    schemaVersion: 1,
    kind: "check",
    resourceKind: "vm",
    target: sku,
    region: row.region,
    verdict: row.verdict,
    confidence: "deployability",
    cache,
    policy,
    checks: row,
    explanation: explainVmVerdict(sku, row),
  };
}

export interface CheckResourcePayload {
  schemaVersion: 1;
  kind: "check";
  resourceKind: "resource";
  target: string;
  resolved: ResolvedResourceType;
  region: string;
  verdict: ResourceAvailabilityVerdict["verdict"];
  confidence: "availability";
  cache: CacheSummary;
  policy: PolicySummary;
  checks: ResourceAvailabilityVerdict;
  /** Factual reason + optional hint for this verdict. Since 0.4.6. */
  explanation: ReturnType<typeof explainResourceVerdict>;
}

export function buildCheckResourcePayload(
  target: string,
  resolved: ResolvedResourceType,
  row: ResourceAvailabilityVerdict,
  cache: CacheSummary,
  policy: PolicySummary,
): CheckResourcePayload {
  return {
    schemaVersion: 1,
    kind: "check",
    resourceKind: "resource",
    target,
    resolved,
    region: row.region,
    verdict: row.verdict,
    confidence: "availability",
    cache,
    policy,
    checks: row,
    explanation: explainResourceVerdict(row),
  };
}

export interface AvailabilityVmPayload {
  schemaVersion: 1;
  kind: "availability" | "regions";
  resourceKind: "vm";
  sku: string;
  geography: string | null;
  region: string | null;
  scannedAt: string;
  elapsedMs: number;
  cache: CacheSummary;
  policy: PolicySummary;
  regions: RegionVerdict[];
}

export function buildAvailabilityVmPayload(input: {
  kind: "availability" | "regions";
  sku: string;
  geography: string | null;
  region: string | null;
  scannedAt: string;
  elapsedMs: number;
  cache: CacheSummary;
  policy: PolicySummary;
  rows: RegionVerdict[];
}): AvailabilityVmPayload {
  return {
    schemaVersion: 1,
    kind: input.kind,
    resourceKind: "vm",
    sku: input.sku,
    geography: input.geography,
    region: input.region,
    scannedAt: input.scannedAt,
    elapsedMs: input.elapsedMs,
    cache: input.cache,
    policy: input.policy,
    regions: input.rows,
  };
}

export interface AvailabilityResourcePayload {
  schemaVersion: 1;
  kind: "availability";
  resourceKind: "resource";
  target: string;
  resolved: ResolvedResourceType;
  confidence: "availability";
  geography: string | null;
  region: string | null;
  scannedAt: string;
  elapsedMs: number;
  cache: CacheSummary;
  policy: PolicySummary;
  regions: ResourceAvailabilityVerdict[];
}

export function buildAvailabilityResourcePayload(input: {
  target: string;
  resolved: ResolvedResourceType;
  geography: string | null;
  region: string | null;
  scannedAt: string;
  elapsedMs: number;
  cache: CacheSummary;
  policy: PolicySummary;
  rows: ResourceAvailabilityVerdict[];
}): AvailabilityResourcePayload {
  return {
    schemaVersion: 1,
    kind: "availability",
    resourceKind: "resource",
    target: input.target,
    resolved: input.resolved,
    confidence: "availability",
    geography: input.geography,
    region: input.region,
    scannedAt: input.scannedAt,
    elapsedMs: input.elapsedMs,
    cache: input.cache,
    policy: input.policy,
    regions: input.rows,
  };
}

export interface PickPayload {
  schemaVersion: 1;
  kind: "pick";
  resourceKind: "vm";
  sku: string;
  cache: CacheSummary;
  policy: PolicySummary;
  picked: {
    region: string;
    displayName: string;
    geographyGroup: string | null;
    free: number | null;
    limit: number | null;
  } | null;
}

export function buildPickPayload(
  sku: string,
  cache: CacheSummary,
  policy: PolicySummary,
  row: RegionVerdict | null,
): PickPayload {
  return {
    schemaVersion: 1,
    kind: "pick",
    resourceKind: "vm",
    sku,
    cache,
    policy,
    picked: row
      ? {
          region: row.region,
          displayName: row.displayName,
          geographyGroup: row.geographyGroup ?? null,
          free: row.free,
          limit: row.limit,
        }
      : null,
  };
}

export interface SuggestPayload {
  schemaVersion: 1;
  kind: "suggest";
  resourceKind: "vm";
  sku: string;
  geography: string;
  near: string | null;
  elapsedMs: number;
  cache: CacheSummary;
  policy: PolicySummary;
  suggested: {
    region: string;
    displayName: string;
    reason: string;
    score: number;
    factors: Suggestion["factors"];
  } | null;
}

export function buildSuggestPayload(input: {
  sku: string;
  geography: string;
  near: string | null;
  elapsedMs: number;
  cache: CacheSummary;
  policy: PolicySummary;
  suggestion: Suggestion | null;
}): SuggestPayload {
  return {
    schemaVersion: 1,
    kind: "suggest",
    resourceKind: "vm",
    sku: input.sku,
    geography: input.geography,
    near: input.near,
    elapsedMs: input.elapsedMs,
    cache: input.cache,
    policy: input.policy,
    suggested: input.suggestion
      ? {
          region: input.suggestion.row.region,
          displayName: input.suggestion.row.displayName,
          reason: input.suggestion.reason,
          score: input.suggestion.score,
          factors: input.suggestion.factors,
        }
      : null,
  };
}

/**
 * `azw pick resource` payload: one script-value region where every requested
 * type is `RESOURCE_SUPPORTED`. Mirrors `pick vm` minus the quota fields —
 * resource rows carry no `free`/`limit` signal. Since 0.4.10.
 */
export interface PickResourcePayload {
  schemaVersion: 1;
  kind: "pick";
  resourceKind: "resource";
  confidence: "availability";
  targets: string[];
  /** One resolved entry per target, in request order. */
  resolved: ResolvedResourceType[];
  cache: CacheSummary;
  policy: PolicySummary;
  picked: {
    region: string;
    displayName: string;
    geographyGroup: string | null;
  } | null;
}

export function buildPickResourcePayload(input: {
  targets: string[];
  resolved: ResolvedResourceType[];
  cache: CacheSummary;
  policy: PolicySummary;
  location: AzLocation | null;
}): PickResourcePayload {
  return {
    schemaVersion: 1,
    kind: "pick",
    resourceKind: "resource",
    confidence: "availability",
    targets: input.targets,
    resolved: input.resolved,
    cache: input.cache,
    policy: input.policy,
    picked: input.location
      ? {
          region: input.location.name,
          displayName: input.location.displayName,
          geographyGroup: input.location.metadata?.geographyGroup ?? null,
        }
      : null,
  };
}

/**
 * `azw suggest resource` payload: one human recommendation with a reason.
 * Scoring is proximity-based (`score: -distanceKm` with `--near`, else 0);
 * `factors` carries `distanceKm` (only with `--near`) and `geographyGroup`
 * — never `free`/`limit`. Since 0.4.10.
 */
export interface SuggestResourcePayload {
  schemaVersion: 1;
  kind: "suggest";
  resourceKind: "resource";
  confidence: "availability";
  targets: string[];
  /** One resolved entry per target, in request order. */
  resolved: ResolvedResourceType[];
  geography: string;
  near: string | null;
  elapsedMs: number;
  cache: CacheSummary;
  policy: PolicySummary;
  suggested: {
    region: string;
    displayName: string;
    reason: string;
    score: number;
    factors: ResourceSuggestion["factors"];
  } | null;
}

export function buildSuggestResourcePayload(input: {
  targets: string[];
  resolved: ResolvedResourceType[];
  geography: string;
  near: string | null;
  elapsedMs: number;
  cache: CacheSummary;
  policy: PolicySummary;
  suggestion: ResourceSuggestion | null;
}): SuggestResourcePayload {
  return {
    schemaVersion: 1,
    kind: "suggest",
    resourceKind: "resource",
    confidence: "availability",
    targets: input.targets,
    resolved: input.resolved,
    geography: input.geography,
    near: input.near,
    elapsedMs: input.elapsedMs,
    cache: input.cache,
    policy: input.policy,
    suggested: input.suggestion
      ? {
          region: input.suggestion.location.name,
          displayName: input.suggestion.location.displayName,
          reason: input.suggestion.reason,
          score: input.suggestion.score,
          factors: input.suggestion.factors,
        }
      : null,
  };
}

/**
 * `azw compare resource` matrix payload, mirroring the VM compare shape
 * (0.4.5) with `targets` instead of `skus` and `availability` confidence.
 * Every per-target row carries the pinned resource verdict rows; the VM
 * compare payload is untouched. Since 0.4.9.
 */
export interface CompareResourcePayload {
  schemaVersion: 1;
  kind: "compare";
  resourceKind: "resource";
  confidence: "availability";
  targets: string[];
  /** Region axis shared by every per-target result below, in the same order. */
  regions: string[];
  geography: string | null;
  region: string | null;
  scannedAt: string;
  elapsedMs: number;
  cache: CacheSummary;
  policy: PolicySummary;
  results: CompareResourceSummary[];
}

export function buildCompareResourcePayload(input: {
  targets: string[];
  regions: string[];
  geography: string | null;
  region: string | null;
  scannedAt: string;
  elapsedMs: number;
  cache: CacheSummary;
  policy: PolicySummary;
  results: CompareResourceSummary[];
}): CompareResourcePayload {
  return {
    schemaVersion: 1,
    kind: "compare",
    resourceKind: "resource",
    confidence: "availability",
    targets: input.targets,
    regions: input.regions,
    geography: input.geography,
    region: input.region,
    scannedAt: input.scannedAt,
    elapsedMs: input.elapsedMs,
    cache: input.cache,
    policy: input.policy,
    results: input.results,
  };
}

/**
 * Generic resource findings of a verify run, kept in their own namespace so
 * the VM `summary` / `results` / `skipped` fields keep their pinned meaning.
 * Every row carries `availability` confidence — never deployability.
 * Since 0.4.8.
 */
export interface VerifyResourceSection {
  /** Generic resources (mapped types) the parser saw across all files. */
  seen: number;
  /** Pairs that resolved statically and were checked. */
  checked: number;
  /** Resources reported in this section's `skipped`. */
  skipped: number;
  supportedCount: number;
  verdictCounts: Record<ResourceAvailabilityVerdict["verdict"], number>;
  results: VerifyResourceResultRow[];
  skippedFindings: IacSkippedResource[];
}

export interface VerifyStorageSection {
  seen: number;
  checked: number;
  skipped: number;
  advertisedCount: number;
  verdictCounts: Record<StorageVerdict, number>;
  results: VerifyStorageResultRow[];
  skippedFindings: IacSkippedStorageResource[];
}

export interface VerifyPayload {
  schemaVersion: 1;
  kind: "verify";
  resourceKind: "vm";
  /** Describes `results` (VM rows); generic resource and Storage checks use availability. */
  confidence: "deployability";
  files: string[];
  formats: IacFormat[];
  scannedAt: string;
  elapsedMs: number;
  summary: {
    /** VM + scale-set resources the parser saw across all files. */
    resources: number;
    /** Pairs that resolved statically and were checked. */
    checked: number;
    /** Resources reported in `skipped` (dynamic values, unknown regions). */
    skipped: number;
    deployableCount: number;
    verdictCounts: Record<RegionVerdict["verdict"], number>;
  };
  /** One row per checked pair, in source order. Since 0.4.7. */
  results: VerifyResultRow[];
  /** VM resources found but not checkable; findings, not verdicts. */
  skipped: IacSkippedResource[];
  /** Generic resource findings. Since 0.4.8. */
  genericResources: VerifyResourceSection;
  cache: CacheSummary;
  policy: PolicySummary;
  /** Subscription SKU findings when the input contains Storage accounts. Since 0.5.3. */
  storageAccounts?: VerifyStorageSection;
}

export function buildVerifyPayload(input: {
  files: string[];
  formats: IacFormat[];
  scannedAt: string;
  elapsedMs: number;
  rows: VerifyResultRow[];
  skipped: IacSkippedResource[];
  vmResourceCount: number;
  resourceRows?: VerifyResourceResultRow[];
  resourceSkipped?: IacSkippedResource[];
  genericResourceCount?: number;
  storage?: {
    seen: number;
    rows: VerifyStorageResultRow[];
    skippedFindings: IacSkippedStorageResource[];
  };
  cache: CacheSummary;
  policy: PolicySummary;
}): VerifyPayload {
  const verdictCounts = countVerdicts(input.rows);
  const resourceRows = input.resourceRows ?? [];
  const resourceSkipped = input.resourceSkipped ?? [];
  const resourceCounts = countResourceVerdicts(resourceRows);
  const storage = input.storage;
  const payload: VerifyPayload = {
    schemaVersion: 1,
    kind: "verify",
    resourceKind: "vm",
    confidence: "deployability",
    files: input.files,
    formats: input.formats,
    scannedAt: input.scannedAt,
    elapsedMs: input.elapsedMs,
    summary: {
      resources: input.vmResourceCount,
      checked: input.rows.length,
      skipped: input.skipped.length,
      deployableCount: verdictCounts.AVAILABLE,
      verdictCounts,
    },
    results: input.rows,
    skipped: input.skipped,
    genericResources: {
      seen: input.genericResourceCount ?? 0,
      checked: resourceRows.length,
      skipped: resourceSkipped.length,
      supportedCount: resourceCounts.RESOURCE_SUPPORTED,
      verdictCounts: resourceCounts,
      results: resourceRows,
      skippedFindings: resourceSkipped,
    },
    cache: input.cache,
    policy: input.policy,
  };
  if (storage) {
    const verdictCounts = countStorageVerdicts(storage.rows);
    payload.storageAccounts = {
      seen: storage.seen,
      checked: storage.rows.length,
      skipped: storage.skippedFindings.length,
      advertisedCount: verdictCounts.STORAGE_SKU_ADVERTISED,
      verdictCounts,
      results: storage.rows,
      skippedFindings: storage.skippedFindings,
    };
  }
  return payload;
}
