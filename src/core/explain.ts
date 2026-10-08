/**
 * Shared, factual explanations for verdicts — one place that turns a verdict
 * row (plus the evidence captured on it since 0.4.6) into a human sentence
 * and an optional actionable hint.
 *
 * Rules:
 * - Reasons state evidence that was actually observed; they never speculate.
 * - Generic resource checks never claim deployability, only availability.
 * - Hints suggest the next concrete step; they may be null when there is
 *   nothing useful to add.
 */

import type { RegionVerdict, ResourceAvailabilityVerdict } from "./types.js";

export interface VerdictExplanation {
  code: string;
  reason: string;
  hint: string | null;
}

/** Explain one VM verdict row. `sku` is the normalized SKU name (Standard_B1s). */
export function explainVmVerdict(sku: string, row: RegionVerdict): VerdictExplanation {
  switch (row.verdict) {
    case "AVAILABLE":
      return { code: row.verdict, reason: availableReason(sku, row), hint: null };
    case "FULL":
      return { code: row.verdict, reason: fullReason(sku, row), hint: fullHint() };
    case "SKU_NOT_OFFERED":
      return {
        code: row.verdict,
        reason: notOfferedReason(sku, row),
        hint: `See what this region does offer: azw skus --region ${row.region}`,
      };
    case "BLOCKED_FOR_SUB":
      return {
        code: row.verdict,
        reason: blockedForSubReason(sku, row),
        hint: "Azure must enable this size for your subscription here; try another region or another size.",
      };
    case "POLICY_DENIED":
      return {
        code: row.verdict,
        reason:
          row.policyReason ??
          `${row.region} is not in the Azure Policy allowed-location list for this subscription.`,
        hint:
          "Only regions on the policy's allowed list can pass; pick one of those or ask your policy administrator.",
      };
    case "QUOTA_UNKNOWN":
      return quotaUnknownReason(row);
  }
}

/** Explain one generic-resource verdict row. Never claims deployability. */
export function explainResourceVerdict(row: ResourceAvailabilityVerdict): VerdictExplanation {
  switch (row.verdict) {
    case "RESOURCE_SUPPORTED":
      return {
        code: row.verdict,
        reason: `${row.resourceType} is advertised for ${row.region} in the ARM provider catalog. This is availability, not deployability: SKU, quota, and capacity are not checked for generic resources.`,
        hint: null,
      };
    case "POLICY_DENIED":
      return {
        code: row.verdict,
        reason:
          row.policyReason ??
          `${row.region} is not in the Azure Policy allowed-location list for this subscription.`,
        hint:
          "Only regions on the policy's allowed list can pass; pick one of those or ask your policy administrator.",
      };
    case "RESOURCE_NOT_SUPPORTED":
      return notSupportedExplanation(row);
  }
}

/**
 * One-line blocker summary for scan footers and failure messages.
 * Returns null when there is nothing to summarize (no rows, or something is
 * deployable).
 */
export function summarizeBlockers(rows: RegionVerdict[]): string | null {
  if (rows.length === 0 || rows.some((r) => r.verdict === "AVAILABLE")) return null;
  const counts = new Map<RegionVerdict["verdict"], number>();
  for (const row of rows) counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
  const order: Array<[RegionVerdict["verdict"], string]> = [
    ["POLICY_DENIED", "policy-denied"],
    ["FULL", "quota-full"],
    ["BLOCKED_FOR_SUB", "sub-blocked"],
    ["SKU_NOT_OFFERED", "not offered"],
    ["QUOTA_UNKNOWN", "quota unknown"],
  ];
  const parts = order
    .filter(([verdict]) => (counts.get(verdict) ?? 0) > 0)
    .map(([verdict, label]) => `${counts.get(verdict)} ${label}`);
  return parts.length > 0 ? `Blocked: ${parts.join(", ")}.` : null;
}

function availableReason(sku: string, row: RegionVerdict): string {
  const family = row.family ? `family ${row.family}` : "its VM family";
  if (row.free === null || row.limit === null) {
    return `${sku} is offered in ${row.region} and passed every check (quota headroom not reported).`;
  }
  const needs = row.requiredVcpus !== null ? ` (needs ${vcpus(row.requiredVcpus)})` : "";
  return `${sku} is offered in ${row.region} and ${family} has ${row.free}/${row.limit} vCPUs free${needs}.`;
}

function fullReason(sku: string, row: RegionVerdict): string {
  if (row.free === null || row.limit === null || row.requiredVcpus === null) {
    const family = row.family ? `family ${row.family}` : "its VM family";
    return `${sku} is offered in ${row.region} but ${family} has no free vCPUs left.`;
  }
  const family = row.family ? `family ${row.family}` : "its VM family";
  const short = row.requiredVcpus - row.free;
  return `${sku} needs ${vcpus(row.requiredVcpus)} but ${family} has only ${row.free}/${row.limit} free in ${row.region} — ${vcpus(short)} short.`;
}

function fullHint(): string {
  return "Request a quota increase (Azure Portal → Quotas) or free up vCPUs, then re-check.";
}

function notOfferedReason(sku: string, row: RegionVerdict): string {
  let reason = `Azure does not list ${sku} among the VM sizes offered in ${row.region}.`;
  const sizes = row.familySizesOffered;
  if (sizes && sizes.length > 0) {
    reason += ` Other sizes in the same series are listed there: ${sizes.join(", ")}.`;
  }
  return reason;
}

function blockedForSubReason(sku: string, row: RegionVerdict): string {
  const codes = [
    ...new Set((row.skuRestrictions ?? []).map((r) => r.reasonCode).filter(Boolean)),
  ] as string[];
  const detail = codes.length > 0 ? ` (${codes.join(", ")})` : "";
  return `${sku} is listed in ${row.region} but restricted for this subscription${detail}.`;
}

function quotaUnknownReason(row: RegionVerdict): VerdictExplanation {
  if (row.errorDetail) {
    return {
      code: "QUOTA_UNKNOWN",
      reason: `Could not read quota state in ${row.region}: ${row.errorDetail}`,
      hint: "Retry in a moment (add --refresh to bypass cached data); if it persists, check `az account show`.",
    };
  }
  const family = row.family ? `family ${row.family}` : "its VM family";
  return {
    code: "QUOTA_UNKNOWN",
    reason: `The vCPU usage report has no row for ${family} in ${row.region}, so headroom is unknown.`,
    hint: "Re-run with --refresh; usage rows for brand-new families can lag by a few minutes.",
  };
}

function notSupportedExplanation(row: ResourceAvailabilityVerdict): VerdictExplanation {
  const slash = row.resourceType.indexOf("/");
  const namespace = slash > 0 ? row.resourceType.slice(0, slash) : row.resourceType;
  const typePath = slash > 0 ? row.resourceType.slice(slash + 1) : row.resourceType;

  let reason: string;
  let hint: string;
  switch (row.notSupportedCause) {
    case "provider-not-found":
      reason = `The provider namespace ${namespace} is not in the subscription's provider catalog, so ${row.resourceType} availability in ${row.region} cannot be confirmed.`;
      hint = `Check the spelling: azw resources --grep ${typePath}`;
      break;
    case "type-not-found":
      reason = `${namespace} does not list a '${typePath}' resource type, so ${row.resourceType} availability in ${row.region} cannot be confirmed.`;
      hint = `List its types: azw resources --namespace ${namespace}`;
      break;
    default:
      reason =
        row.typeLocationCount !== null
          ? `${row.resourceType} advertises ${row.typeLocationCount} regions; ${row.region} is not one of them.`
          : `${row.resourceType} does not advertise ${row.region} in the provider catalog.`;
      hint = "See advertised regions: azw availability resource <target>";
      break;
  }
  if (row.providerRegistered === false) {
    hint += ` The provider is also not registered in this subscription (az provider register --namespace ${namespace}).`;
  }
  return { code: row.verdict, reason, hint };
}

function vcpus(n: number): string {
  return n === 1 ? "1 vCPU" : `${n} vCPUs`;
}
