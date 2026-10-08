import { armList, getToken } from "./arm.js";
import { compareColumnLabel } from "./compare.js";
import { c, colorEnabled } from "./color.js";
import { explainResourceVerdict, explainVmVerdict, type VerdictExplanation } from "./explain.js";
import type { IacResourcePair, IacSkippedResource, IacVmPair } from "./iac.js";
import type { PolicyCheck } from "./policy.js";
import { Progress } from "./progress.js";
import {
  classifyResourceType,
  listProviderCatalog,
  resourceAlias,
} from "./resources.js";
import {
  baseVerdict,
  buildBlockedForSubVerdict,
  buildErrorVerdict,
  buildNotOfferedVerdict,
  buildQuotaUnknownVerdict,
  buildQuotaVerdict,
} from "./scan.js";
import { isSkuBlockedForSubscription, skuVcpus } from "./sku.js";
import type {
  AzLocation,
  AzProvider,
  AzVmSku,
  AzVmUsage,
  RegionVerdict,
  ResourceAvailabilityVerdict,
} from "./types.js";

/**
 * IaC preflight engine for `azw verify`: take the statically-known
 * `location + sku` pairs parsed from Terraform/Bicep files (see iac.ts) and
 * run each one through the same deployability evidence chain as
 * `azw check vm` — policy → offered → subscription restriction → quota.
 * Generic `type + location` pairs (since 0.4.8) run through the same
 * provider-catalog availability engine as `azw check resource`, with
 * availability confidence — never deployability.
 *
 * Cost mirrors `compare vm`: VM pairs are grouped by region, so a run makes
 * one cached SKU-catalog call per region plus one live usage call per region
 * that offers at least one requested SKU — O(regions), never O(pairs).
 * Generic pairs share one cached provider-catalog call for the whole run.
 */

/** A parsed pair bound to the ARM location its literal resolved to. */
export interface VerifyPair {
  pair: IacVmPair;
  location: AzLocation;
}

/** One checked pair: where it came from, what the scan said, and why. */
export interface VerifyResultRow {
  file: string;
  line: number;
  format: IacVmPair["format"];
  resourceType: string;
  resourceName: string;
  sku: string;
  region: string;
  capacity: number | null;
  /** The pinned 16-field verdict row, identical in shape to `azw check vm`. */
  checks: RegionVerdict;
  explanation: VerdictExplanation;
}

export function toVerifyRow(pair: IacVmPair, verdict: RegionVerdict): VerifyResultRow {
  return {
    file: pair.file,
    line: pair.line,
    format: pair.format,
    resourceType: pair.resourceType,
    resourceName: pair.resourceName,
    sku: pair.sku,
    region: verdict.region,
    capacity: pair.capacity,
    checks: verdict,
    explanation: explainVmVerdict(pair.sku, verdict),
  };
}

/** Dedup key: same region-agnostic (sku, effective capacity) shares a scan. */
export function pairKey(pair: IacVmPair): string {
  return `${pair.sku}|${pair.capacity ?? 1}`;
}

/**
 * Bind each parsed location literal to an ARM location: exact name first
 * (`westeurope`), then display name ignoring case/spaces/punctuation
 * (`West Europe`). Literals that match neither become `unknown-region` skips.
 * Works for both VM pairs and generic resource pairs — they share the
 * location metadata the matcher needs.
 */
export function matchVerifyLocations<T extends {
  file: string;
  line: number;
  format: IacVmPair["format"];
  resourceType: string;
  resourceName: string;
  locationLiteral: string;
}>(
  pairs: T[],
  locations: AzLocation[],
): { matched: Array<{ pair: T; location: AzLocation }>; unmatched: IacSkippedResource[] } {
  const byName = new Map<string, AzLocation>();
  const byDisplay = new Map<string, AzLocation>();
  for (const l of locations) {
    byName.set(l.name.toLowerCase(), l);
    const key = normalizeLocationKey(l.displayName);
    if (!byDisplay.has(key)) byDisplay.set(key, l);
  }

  const matched: Array<{ pair: T; location: AzLocation }> = [];
  const unmatched: IacSkippedResource[] = [];
  for (const pair of pairs) {
    const literal = pair.locationLiteral.trim();
    const hit =
      byName.get(literal.toLowerCase()) ?? byDisplay.get(normalizeLocationKey(literal));
    if (hit) {
      matched.push({ pair, location: hit });
    } else {
      unmatched.push({
        file: pair.file,
        line: pair.line,
        format: pair.format,
        resourceType: pair.resourceType,
        resourceName: pair.resourceName,
        reason: "unknown-region",
        detail: literal,
      });
    }
  }
  return { matched, unmatched };
}

function normalizeLocationKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Classify every pair for one region, given the region's SKU catalog and
 * usage rows. Pure — no ARM calls — so tests feed fakes directly. Verdict
 * precedence and evidence match `azw check vm` exactly; scale-set capacity
 * multiplies the vCPU requirement.
 */
export function classifyVerifyRegion(input: {
  location: AzLocation;
  pairs: IacVmPair[];
  skuCatalog: AzVmSku[];
  usages: AzVmUsage[] | null;
  policyAllowed: boolean | null;
  policyReason: string | null;
}): Map<string, RegionVerdict> {
  const out = new Map<string, RegionVerdict>();
  const raw = baseVerdict(input.location);
  // Same convention as scanOne: policy-checked rows carry policyAllowed
  // (true here, false on the deny rows below); unchecked rows carry null.
  const base: RegionVerdict = input.policyAllowed === null ? raw : { ...raw, policyAllowed: true };

  if (input.policyAllowed === false) {
    for (const pair of input.pairs) {
      out.set(pairKey(pair), {
        ...base,
        policyAllowed: false,
        policyReason: input.policyReason,
        verdict: "POLICY_DENIED",
      });
    }
    return out;
  }

  for (const pair of input.pairs) {
    const key = pairKey(pair);
    if (out.has(key)) continue;
    const vmSku = input.skuCatalog.find(
      (s) => s.resourceType === "virtualMachines" && s.name === pair.sku,
    );
    if (!vmSku) {
      out.set(key, buildNotOfferedVerdict(base, input.skuCatalog, pair.sku));
      continue;
    }
    if (isSkuBlockedForSubscription(vmSku)) {
      out.set(key, buildBlockedForSubVerdict(base, vmSku));
      continue;
    }
    const family = vmSku.family ?? null;
    const requiredVcpus = (skuVcpus(vmSku) ?? 1) * (pair.capacity ?? 1);
    const usage = family
      ? input.usages?.find((u) => u.name?.value === family)
      : undefined;
    out.set(
      key,
      usage
        ? buildQuotaVerdict(base, family, requiredVcpus, usage)
        : buildQuotaUnknownVerdict(base, family, requiredVcpus),
    );
  }
  return out;
}

export interface VerifyScanOptions {
  pairs: VerifyPair[];
  concurrency?: number;
  refresh?: boolean;
  policy?: PolicyCheck;
}

export interface VerifyScanResult {
  /** One row per input pair, in input (source) order. */
  rows: VerifyResultRow[];
  elapsedMs: number;
}

/** Parallel per-region scan, mirroring scanCompare: shared token, worker pool. */
export async function scanVerifyPairs(opts: VerifyScanOptions): Promise<VerifyScanResult> {
  const regions = new Map<string, { location: AzLocation; pairs: IacVmPair[] }>();
  for (const { pair, location } of opts.pairs) {
    const entry = regions.get(location.name) ?? { location, pairs: [] };
    if (entry.pairs.length === 0) entry.location = location;
    entry.pairs.push(pair);
    regions.set(location.name, entry);
  }
  const names = [...regions.keys()];
  const progress = new Progress(
    names.length,
    `Verifying ${opts.pairs.length} VM resource${opts.pairs.length === 1 ? "" : "s"}`,
  );

  // Mint the token once up-front so the first worker doesn't block on it.
  await getToken();

  const classified = new Map<string, Map<string, RegionVerdict>>();
  let cursor = 0;
  const concurrency = Math.min(opts.concurrency ?? 16, names.length);

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= names.length) return;
      const name = names[i];
      const { location, pairs } = regions.get(name)!;
      let status: "ok" | "sub" | "off" | "err";
      try {
        const policyAllowed = opts.policy ? opts.policy.isAllowed(name) : null;
        const policyReason = opts.policy?.reason(name) ?? null;

        let verdicts: Map<string, RegionVerdict>;
        if (policyAllowed === false) {
          // Policy-denied regions need no ARM calls — every pair is denied.
          verdicts = classifyVerifyRegion({
            location,
            pairs,
            skuCatalog: [],
            usages: null,
            policyAllowed,
            policyReason,
          });
          status = "sub";
        } else {
          const catalog = await armList<AzVmSku>(
            `/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=location eq '${encodeURIComponent(
              name,
            )}'`,
            { refresh: Boolean(opts.refresh) },
          );
          const offered = new Set(
            pairs
              .map((p) => p.sku)
              .filter((sku) =>
                catalog.some((s) => s.resourceType === "virtualMachines" && s.name === sku),
              ),
          );
          const usages =
            offered.size > 0
              ? await armList<AzVmUsage>(
                  `/providers/Microsoft.Compute/locations/${encodeURIComponent(
                    name,
                  )}/usages?api-version=2021-07-01`,
                  { cache: false },
                ).catch(() => null)
              : null;
          verdicts = classifyVerifyRegion({
            location,
            pairs,
            skuCatalog: catalog,
            usages,
            policyAllowed,
            policyReason,
          });
          status = regionStatus(verdicts);
        }
        classified.set(name, verdicts);
      } catch (err) {
        // One failed region must not kill the batch: every pair in it gets a
        // QUOTA_UNKNOWN row carrying the ARM failure summary.
        const verdicts = new Map<string, RegionVerdict>();
        for (const pair of pairs) {
          verdicts.set(pairKey(pair), buildErrorVerdict(baseVerdict(location), err));
        }
        classified.set(name, verdicts);
        status = "err";
      }
      progress.tick(name, status);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  progress.done();

  const rows = opts.pairs.map(({ pair, location }) => {
    const verdict =
      classified.get(location.name)?.get(pairKey(pair)) ??
      buildErrorVerdict(baseVerdict(location), new Error("missing verification result"));
    return toVerifyRow(pair, verdict);
  });
  return { rows, elapsedMs: progress.elapsedMs() };
}

function regionStatus(verdicts: Map<string, RegionVerdict>): "ok" | "sub" | "off" | "err" {
  const all = [...verdicts.values()];
  if (all.some((v) => v.verdict === "AVAILABLE")) return "ok";
  if (all.some((v) => v.verdict === "BLOCKED_FOR_SUB" || v.verdict === "POLICY_DENIED")) {
    return "sub";
  }
  if (all.every((v) => v.verdict === "SKU_NOT_OFFERED")) return "off";
  return "ok";
}

/* ── Generic resource pairs (since 0.4.8) ──────────────────────────────── */

/** A parsed generic resource pair bound to its resolved ARM location. */
export interface VerifyResourcePair {
  pair: IacResourcePair;
  location: AzLocation;
}

/** One checked generic resource pair: source, the availability row, and why. */
export interface VerifyResourceResultRow {
  file: string;
  line: number;
  format: IacResourcePair["format"];
  /** The Azure resource type the pair was checked against. */
  resourceType: string;
  /** The resource type as written in the file. */
  sourceType: string;
  resourceName: string;
  region: string;
  /** The pinned resource verdict row, identical in shape to `azw check resource`. */
  checks: ResourceAvailabilityVerdict;
  explanation: VerdictExplanation;
}

export function toVerifyResourceRow(
  pair: IacResourcePair,
  verdict: ResourceAvailabilityVerdict,
): VerifyResourceResultRow {
  return {
    file: pair.file,
    line: pair.line,
    format: pair.format,
    resourceType: pair.armType,
    sourceType: pair.resourceType,
    resourceName: pair.resourceName,
    region: verdict.region,
    checks: verdict,
    explanation: explainResourceVerdict(verdict),
  };
}

/**
 * Classify generic pairs against an already-fetched provider catalog.
 * Pure — no ARM calls — so tests feed fake catalogs directly. Verdicts and
 * evidence match `azw check resource` exactly; pairs of the same type share
 * one provider lookup.
 */
export function classifyVerifyResourcePairs(input: {
  pairs: VerifyResourcePair[];
  providers: AzProvider[];
  policy?: PolicyCheck;
}): VerifyResourceResultRow[] {
  const byType = new Map<string, VerifyResourcePair[]>();
  for (const entry of input.pairs) {
    const group = byType.get(entry.pair.armType) ?? [];
    group.push(entry);
    byType.set(entry.pair.armType, group);
  }

  const out: VerifyResourceResultRow[] = [];
  for (const [armType, group] of byType) {
    const classified = classifyResourceType({
      target: armType,
      locations: group.map((e) => e.location),
      providers: input.providers,
      policy: input.policy,
    });
    // Mapped targets are always syntactically valid resource types, so this
    // cannot happen with parser-produced pairs; drop defensively rather than
    // invent a verdict the vocabulary has no row for.
    if (!classified) continue;
    group.forEach((entry, i) => out.push(toVerifyResourceRow(entry.pair, classified.rows[i]!)));
  }
  return out;
}

/**
 * Fetch the provider catalog once and classify every generic pair against
 * it — one cached ARM call per run (plus one live call with --refresh),
 * independent of how many pairs or types the files contain.
 */
export async function scanVerifyResourcePairs(opts: {
  pairs: VerifyResourcePair[];
  refresh?: boolean;
  policy?: PolicyCheck;
}): Promise<{ rows: VerifyResourceResultRow[]; elapsedMs: number }> {
  const started = Date.now();
  if (opts.pairs.length === 0) return { rows: [], elapsedMs: 0 };
  const providers = await listProviderCatalog(Boolean(opts.refresh));
  const rows = classifyVerifyResourcePairs({
    pairs: opts.pairs,
    providers,
    policy: opts.policy,
  });
  return { rows, elapsedMs: Date.now() - started };
}

/* ── Human output helpers ──────────────────────────────────────────────── */

export function countVerdicts(
  rows: VerifyResultRow[],
): Record<RegionVerdict["verdict"], number> {
  const counts = {
    AVAILABLE: 0,
    FULL: 0,
    SKU_NOT_OFFERED: 0,
    BLOCKED_FOR_SUB: 0,
    POLICY_DENIED: 0,
    QUOTA_UNKNOWN: 0,
  };
  for (const row of rows) counts[row.checks.verdict]++;
  return counts;
}

const BLOCKER_LABELS: Array<[RegionVerdict["verdict"], string]> = [
  ["POLICY_DENIED", "policy-denied"],
  ["FULL", "quota-full"],
  ["BLOCKED_FOR_SUB", "sub-blocked"],
  ["SKU_NOT_OFFERED", "not offered"],
  ["QUOTA_UNKNOWN", "quota unknown"],
];

/** `Blocked: 1 quota-full, 2 not offered.` — null when nothing is blocked. */
export function verifyBlockerSummary(counts: Record<RegionVerdict["verdict"], number>): string | null {
  const parts = BLOCKER_LABELS.filter(([verdict]) => counts[verdict] > 0).map(
    ([verdict, label]) => `${counts[verdict]} ${label}`,
  );
  return parts.length > 0 ? `Blocked: ${parts.join(", ")}.` : null;
}

export function countResourceVerdicts(
  rows: VerifyResourceResultRow[],
): Record<ResourceAvailabilityVerdict["verdict"], number> {
  const counts = { RESOURCE_SUPPORTED: 0, RESOURCE_NOT_SUPPORTED: 0, POLICY_DENIED: 0 };
  for (const row of rows) counts[row.checks.verdict]++;
  return counts;
}

const RESOURCE_BLOCKER_LABELS: Array<[ResourceAvailabilityVerdict["verdict"], string]> = [
  ["POLICY_DENIED", "policy-denied"],
  ["RESOURCE_NOT_SUPPORTED", "not advertised"],
];

/** `Blocked: 1 policy-denied, 2 not advertised.` — null when nothing is blocked. */
export function verifyResourceBlockerSummary(
  counts: Record<ResourceAvailabilityVerdict["verdict"], number>,
): string | null {
  const parts = RESOURCE_BLOCKER_LABELS.filter(([verdict]) => counts[verdict] > 0).map(
    ([verdict, label]) => `${counts[verdict]} ${label}`,
  );
  return parts.length > 0 ? `Blocked: ${parts.join(", ")}.` : null;
}

const VERIFY_VERDICT_LABEL: Record<RegionVerdict["verdict"], string> = {
  AVAILABLE: "✓ DEPLOY",
  FULL: "✗ QUOTA FULL",
  BLOCKED_FOR_SUB: "✗ SUB BLOCKED",
  POLICY_DENIED: "✗ POLICY DENIED",
  SKU_NOT_OFFERED: "✗ SKU NOT OFFERED",
  QUOTA_UNKNOWN: "! QUOTA UNKNOWN",
};

function verifyVerdictCell(v: RegionVerdict["verdict"]): string {
  const label = VERIFY_VERDICT_LABEL[v];
  if (!colorEnabled()) return label;
  switch (v) {
    case "AVAILABLE":
      return c.green(c.bold(label));
    case "FULL":
    case "BLOCKED_FOR_SUB":
    case "POLICY_DENIED":
    case "SKU_NOT_OFFERED":
      return c.red(label);
    case "QUOTA_UNKNOWN":
      return c.yellow(label);
  }
}

function verifyQuotaCell(row: RegionVerdict): string {
  if (row.free === null || row.limit === null) {
    if (row.verdict === "QUOTA_UNKNOWN") return colorEnabled() ? c.yellow("?") : "?";
    return colorEnabled() ? c.dim("—") : "—";
  }
  const label = `${row.free}/${row.limit} free`;
  if (!colorEnabled()) return label;
  return row.verdict === "AVAILABLE" ? c.green(label) : c.red(label);
}

/** Human table for verify: one row per checked pair, in source order. */
export function buildVerifyTable(rows: VerifyResultRow[]): {
  headers: string[];
  body: string[][];
} {
  const headers = ["RESOURCE", "SKU", "REGION", "VERDICT", "QUOTA"];
  const body = rows.map((r) => [
    r.resourceName,
    compareColumnLabel(r.sku),
    r.region,
    verifyVerdictCell(r.checks.verdict),
    verifyQuotaCell(r.checks),
  ]);
  return { headers, body };
}

const VERIFY_RESOURCE_VERDICT_LABEL: Record<ResourceAvailabilityVerdict["verdict"], string> = {
  RESOURCE_SUPPORTED: "✓ SUPPORTED",
  RESOURCE_NOT_SUPPORTED: "✗ NOT ADVERTISED",
  POLICY_DENIED: "✗ POLICY DENIED",
};

function verifyResourceVerdictCell(v: ResourceAvailabilityVerdict["verdict"]): string {
  const label = VERIFY_RESOURCE_VERDICT_LABEL[v];
  if (!colorEnabled()) return label;
  return v === "RESOURCE_SUPPORTED" ? c.green(c.bold(label)) : c.red(label);
}

/** Human table for generic resource pairs: one row per pair, in source order. */
export function buildVerifyResourceTable(rows: VerifyResourceResultRow[]): {
  headers: string[];
  body: string[][];
} {
  const headers = ["RESOURCE", "TYPE", "REGION", "VERDICT", "CONFIDENCE"];
  const body = rows.map((r) => [
    r.resourceName,
    resourceAlias(r.resourceType) ?? r.resourceType,
    r.region,
    verifyResourceVerdictCell(r.checks.verdict),
    r.checks.confidence,
  ]);
  return { headers, body };
}
