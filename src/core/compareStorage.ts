import { MAX_COMPARE_TARGETS } from "./compareResource.js";
import { ValidationError } from "./errors.js";
import type { PolicyCheck } from "./policy.js";
import { scanStorageTargets, validateStorageTarget } from "./storage.js";
import type { StorageTarget, StorageVerdict } from "./storage.js";
import type { AzLocation } from "./types.js";

export function parseStorageTargets(raw: string): StorageTarget[] {
  const targets = new Map<string, StorageTarget>();
  for (const entry of raw.split(",")) {
    const pair = entry.split("/");
    if (pair.length !== 2 || pair.some((part) => !part.trim())) {
      throw new ValidationError(
        "Use a comma-separated list of Storage kind/SKU pairs, such as StorageV2/Standard_LRS,StorageV2/Standard_ZRS.",
      );
    }
    const target = validateStorageTarget(pair[0], pair[1]);
    const key = `${target.accountKind}/${target.sku}`.toLowerCase();
    if (!targets.has(key)) targets.set(key, target);
    if (targets.size > MAX_COMPARE_TARGETS) {
      throw new ValidationError(
        `Compare up to ${MAX_COMPARE_TARGETS} distinct Storage configurations.`,
      );
    }
  }
  return [...targets.values()];
}

export async function compareStorageTargets(
  targets: StorageTarget[],
  locations: AzLocation[],
  policy?: PolicyCheck,
) {
  const results = await scanStorageTargets(targets, locations, policy);
  return results.map((result) => {
    const verdictCounts: Record<StorageVerdict, number> = {
      STORAGE_SKU_ADVERTISED: 0,
      STORAGE_SKU_RESTRICTED: 0,
      STORAGE_SKU_NOT_LISTED: 0,
      STORAGE_SKU_UNKNOWN: 0,
      POLICY_DENIED: 0,
    };
    const advertisedRegions: string[] = [];
    for (const row of result.regions) {
      verdictCounts[row.verdict]++;
      if (row.verdict === "STORAGE_SKU_ADVERTISED") advertisedRegions.push(row.region);
    }
    return {
      ...result,
      advertisedRegions,
      advertisedCount: advertisedRegions.length,
      verdictCounts,
    };
  });
}

export const STORAGE_COMPARE_MARK: Record<StorageVerdict, string> = {
  STORAGE_SKU_ADVERTISED: "A",
  STORAGE_SKU_RESTRICTED: "R",
  STORAGE_SKU_NOT_LISTED: "-",
  STORAGE_SKU_UNKNOWN: "?",
  POLICY_DENIED: "P",
};
