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
import type { PolicySummary } from "./policy.js";
import type { ResolvedResourceType } from "./resources.js";
import type { Suggestion } from "./suggest.js";
import type { RegionVerdict, ResourceAvailabilityVerdict } from "./types.js";

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
