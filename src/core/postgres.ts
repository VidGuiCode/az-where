import { armList } from "./arm.js";
import { ValidationError } from "./errors.js";
import type { PolicyCheck } from "./policy.js";

interface CapabilityStatus {
  status?: string | null;
  reason?: string | null;
}

interface PostgresSku extends CapabilityStatus {
  name?: string;
  vCores?: number;
}

interface PostgresEdition extends CapabilityStatus {
  name?: string;
  supportedServerSkus?: PostgresSku[] | null;
}

export interface PostgresCapability extends CapabilityStatus {
  restricted?: string | null;
  supportedFeatures?: Array<{ name?: string; status?: string | null }> | null;
  supportedServerEditions?: PostgresEdition[] | null;
}

export type PostgresVerdict =
  | "POSTGRES_SKU_ADVERTISED"
  | "POSTGRES_SKU_RESTRICTED"
  | "POSTGRES_SKU_NOT_LISTED"
  | "POSTGRES_SKU_UNKNOWN"
  | "POLICY_DENIED";

type RestrictionScope = "offer" | "region" | "tier" | "sku";

interface PostgresTarget {
  tier: string;
  sku: string;
}

interface PostgresSkuResult {
  verdict: PostgresVerdict;
  evidence: {
    listed: boolean | null;
    offerRestricted: boolean | null;
    restrictionScope: RestrictionScope | null;
    vCores: number | null;
  };
  reason: string;
}

export function validatePostgresTarget(tier: string, sku: string): PostgresTarget {
  const target = { tier: tier.trim(), sku: sku.trim() };
  if (!/^[a-z][a-z0-9]*$/i.test(target.tier)) {
    throw new ValidationError("Use a PostgreSQL compute tier such as GeneralPurpose.");
  }
  if (!/^standard_[a-z0-9]+(?:_[a-z0-9]+)*$/i.test(target.sku)) {
    throw new ValidationError("Use a full PostgreSQL compute SKU name such as Standard_D2ds_v5.");
  }
  return target;
}

export async function checkPostgresSku(
  target: PostgresTarget,
  region: string,
  policy?: PolicyCheck,
): Promise<PostgresSkuResult> {
  if (policy?.isAllowed(region) === false) {
    return {
      verdict: "POLICY_DENIED",
      evidence: { listed: null, offerRestricted: null, restrictionScope: null, vCores: null },
      reason: policy.reason(region) ?? `Allowed-location policy excludes ${region}.`,
    };
  }

  const path = `/providers/Microsoft.DBforPostgreSQL/locations/${encodeURIComponent(region)}/capabilities?api-version=2026-10-01`;
  const capabilities = await armList<PostgresCapability>(path, {
    cache: false,
    requireValueArray: true,
  });
  return classifyPostgresSku(capabilities, target, region);
}

export function classifyPostgresSku(
  capabilities: PostgresCapability[],
  target: PostgresTarget,
  region: string,
): PostgresSkuResult {
  const records = capabilities.filter(
    (row) => row != null && typeof row === "object" && !Array.isArray(row),
  );
  const features = records.flatMap((row) => arrayEntries(row.supportedFeatures));
  const offerFlags = features.filter((feature) => normalize(feature?.name) === "offerrestricted");
  const offerStatuses = offerFlags.map((feature) => normalize(feature.status));
  const regionFlags = features.filter((feature) => normalize(feature?.name) === "restricted");
  const regionStatuses = [
    ...regionFlags.map((feature) => normalize(feature.status)),
    ...records.filter((row) => row.restricted != null).map((row) => normalize(row.restricted)),
  ];
  const tiers = records
    .flatMap((row) => arrayEntries(row.supportedServerEditions))
    .filter((tier) => normalize(tier?.name) === normalize(target.tier));
  const matches = tiers
    .flatMap((tier) => arrayEntries(tier.supportedServerSkus))
    .filter((sku) => normalize(sku?.name) === normalize(target.sku));

  const offerRestricted = offerStatuses.includes("enabled")
    ? true
    : offerStatuses.length > 0 && offerStatuses.every((status) => status === "disabled")
      ? false
      : null;
  const restrictions: Array<[boolean, RestrictionScope, string]> = [
    [offerRestricted === true, "offer", "Azure reports a subscription offer restriction"],
    [
      regionStatuses.includes("enabled") || records.some(isDisabled),
      "region",
      "Azure reports a regional restriction",
    ],
    [tiers.some(isDisabled), "tier", "Azure marks the requested compute tier as disabled"],
    [matches.some(isDisabled), "sku", "Azure marks the requested compute SKU as disabled"],
  ];
  const restriction = restrictions.find(([blocked]) => blocked);
  const complete =
    offerRestricted === false &&
    records.length === capabilities.length &&
    records.every(
      (row) =>
        hasNamedEntries(row.supportedServerEditions) &&
        (row.supportedFeatures == null || hasNamedEntries(row.supportedFeatures, 0)) &&
        hasUsableStatus(row),
    ) &&
    regionStatuses.every((status) => status === "disabled") &&
    tiers.length > 0 &&
    tiers.every((tier) => hasNamedEntries(tier.supportedServerSkus) && hasUsableStatus(tier)) &&
    matches.every(hasUsableStatus);
  const coreCounts = [
    ...new Set(
      matches
        .map((sku) => sku.vCores)
        .filter(
          (count): count is number =>
            typeof count === "number" && Number.isInteger(count) && count > 0,
        ),
    ),
  ];
  const evidence = {
    listed: matches.length > 0 ? true : complete && !restriction ? false : null,
    offerRestricted,
    restrictionScope: restriction?.[1] ?? null,
    vCores: coreCounts.length === 1 ? coreCounts[0] : null,
  };
  const configuration = `${target.tier} / ${target.sku} in ${region}`;
  if (restriction) {
    return {
      verdict: "POSTGRES_SKU_RESTRICTED",
      evidence,
      reason: `${restriction[2]} for ${configuration}.`,
    };
  }
  if (!complete) {
    return {
      verdict: "POSTGRES_SKU_UNKNOWN",
      evidence,
      reason: `Azure returned incomplete or inconclusive capability evidence for ${configuration}.`,
    };
  }
  return evidence.listed
    ? {
        verdict: "POSTGRES_SKU_ADVERTISED",
        evidence,
        reason: `Azure lists ${configuration} for this subscription.`,
      }
    : {
        verdict: "POSTGRES_SKU_NOT_LISTED",
        evidence,
        reason: `Azure lists other compute SKUs in the requested tier, but does not list ${configuration}.`,
      };
}

function arrayEntries<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function hasNamedEntries(value: Array<{ name?: string }> | undefined | null, minimum = 1): boolean {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.every((item) => normalize(item?.name) !== "")
  );
}

function isDisabled(capability: CapabilityStatus): boolean {
  return normalize(capability.status) === "disabled";
}

function hasUsableStatus(capability: CapabilityStatus): boolean {
  const status = normalize(capability.status);
  return (
    (capability.status == null || status === "available" || status === "default") &&
    (capability.reason == null ||
      (typeof capability.reason === "string" && !capability.reason.trim()))
  );
}

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
