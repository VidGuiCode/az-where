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
import { explainResourceVerdict, explainVmVerdict } from "./explain.js";
import type { IacFormat, IacSkippedResource } from "./iac.js";
import type { PolicySummary } from "./policy.js";
import type { ResolvedResourceType } from "./resources.js";
import type { Suggestion } from "./suggest.js";
import type { RegionVerdict, ResourceAvailabilityVerdict } from "./types.js";
import {
  countResourceVerdicts,
  countVerdicts,
  type VerifyResourceResultRow,
  type VerifyResultRow,
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
  picked:
    | {
        region: string;
        displayName: string;
        geographyGroup: string | null;
        free: number | null;
        limit: number | null;
      }
    | null;
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
  suggested:
    | {
        region: string;
        displayName: string;
        reason: string;
        score: number;
        factors: Suggestion["factors"];
      }
    | null;
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

export interface VerifyPayload {
  schemaVersion: 1;
  kind: "verify";
  resourceKind: "vm";
  /** Describes `results` (VM rows); generic rows carry availability on each row. */
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
  cache: CacheSummary;
  policy: PolicySummary;
}): VerifyPayload {
  const verdictCounts = countVerdicts(input.rows);
  const resourceRows = input.resourceRows ?? [];
  const resourceSkipped = input.resourceSkipped ?? [];
  const resourceCounts = countResourceVerdicts(resourceRows);
  return {
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
}
