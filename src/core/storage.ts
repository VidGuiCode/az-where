import { armList } from "./arm.js";
import { ValidationError } from "./errors.js";
import type { PolicyCheck } from "./policy.js";
import type { AzLocation } from "./types.js";

const STORAGE_SKUS_PATH = "/providers/Microsoft.Storage/skus?api-version=2026-09-01";

export interface StorageSku {
  resourceType: string;
  kind: string;
  name: string;
  locations?: string[];
  locationInfo?: Array<{ location: string }>;
  restrictions?: Array<{ type: string; values?: string[]; reasonCode?: string }>;
}

export async function listStorageSkus(): Promise<StorageSku[]> {
  const catalog = await armList<StorageSku>(STORAGE_SKUS_PATH, {
    cache: false,
    requireValueArray: true,
  });
  if (catalog.some((row) => typeof row?.resourceType !== "string")) {
    throw new Error("Azure Storage returned a SKU entry without a resource type.");
  }
  const accounts = catalog.filter(isAccountSku);
  if (accounts.length === 0) {
    throw new Error("Azure Storage returned no account SKU entries for this subscription.");
  }
  if (accounts.some(isMalformedAccountSku)) {
    throw new Error("Azure Storage returned an invalid account SKU entry.");
  }
  return accounts;
}

export type StorageVerdict =
  | "STORAGE_SKU_ADVERTISED"
  | "STORAGE_SKU_RESTRICTED"
  | "STORAGE_SKU_NOT_LISTED"
  | "STORAGE_SKU_UNKNOWN"
  | "POLICY_DENIED";

export interface StorageSkuResult {
  verdict: StorageVerdict;
  listed: boolean | null;
  restrictionReasons: string[];
  reason: string;
}

export function validateStorageTarget(kind: string, sku: string) {
  const accountKind = kind.trim();
  const skuName = sku.trim();
  if (!/^[a-z][a-z0-9]*$/i.test(accountKind)) {
    throw new ValidationError("Use a Storage account kind such as StorageV2.");
  }
  if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/i.test(skuName)) {
    throw new ValidationError("Use a full Storage SKU name such as Standard_ZRS.");
  }
  return { accountKind, sku: skuName };
}

export async function scanStorageAvailability(
  target: { accountKind: string; sku: string },
  locations: AzLocation[],
  policy?: PolicyCheck,
) {
  const hasAllowedRegion = locations.some((location) => policy?.isAllowed(location.name) !== false);
  const catalog = hasAllowedRegion ? await listStorageSkus() : [];
  return locations.map((location) => ({
    region: location.name,
    displayName: location.displayName,
    geographyGroup: location.metadata?.geographyGroup ?? null,
    ...classifyStorageSku(catalog, target.accountKind, target.sku, location, policy),
  }));
}

export function classifyStorageSku(
  catalog: StorageSku[],
  accountKind: string,
  sku: string,
  location: AzLocation,
  policy?: PolicyCheck,
): StorageSkuResult {
  if (policy && !policy.isAllowed(location.name)) {
    return {
      verdict: "POLICY_DENIED",
      listed: null,
      restrictionReasons: [],
      reason: policy.reason(location.name) ?? `Allowed-location policy excludes ${location.name}.`,
    };
  }

  const target = `${accountKind} / ${sku}`;
  const region = location.name;
  const regionNames = [normalize(region), normalize(location.displayName)];
  const matching = catalog.filter(
    (row) =>
      isAccountSku(row) &&
      normalize(row.kind ?? "") === normalize(accountKind) &&
      normalize(row.name ?? "") === normalize(sku),
  );
  const locationLists = matching.map(
    (row) => row.locations ?? row.locationInfo?.map(({ location: name }) => name),
  );
  const listed = locationLists.some((locations) =>
    locations?.some((name) => regionNames.includes(normalize(name))),
  );
  const locationEvidence = !listed && locationLists.includes(undefined) ? null : listed;
  const restrictions = matching
    .flatMap((row) => row.restrictions ?? [])
    .filter((restriction) => restriction.type?.toLowerCase() === "location");
  const relevantRestrictions = restrictions.filter((restriction) =>
    restriction.values?.some((name) => regionNames.includes(normalize(name))),
  );
  if (relevantRestrictions.length > 0) {
    const restrictionReasons = [
      ...new Set(
        relevantRestrictions.flatMap(({ reasonCode }) => (reasonCode ? [reasonCode] : [])),
      ),
    ];
    const detail = restrictionReasons.length > 0 ? ` (${restrictionReasons.join(", ")})` : "";
    return {
      verdict: "STORAGE_SKU_RESTRICTED",
      listed: locationEvidence,
      restrictionReasons,
      reason: `The subscription's Storage SKU catalog reports a location restriction for ${target} in ${region}${detail}.`,
    };
  }
  if (restrictions.some((restriction) => !restriction.values?.length)) {
    return {
      verdict: "STORAGE_SKU_UNKNOWN",
      listed: locationEvidence,
      restrictionReasons: [],
      reason: `The Storage SKU catalog reports a location restriction for ${target} without identifying the affected regions.`,
    };
  }
  if (locationEvidence === null) {
    return {
      verdict: "STORAGE_SKU_UNKNOWN",
      listed: null,
      restrictionReasons: [],
      reason: `The Storage SKU catalog omits locations for at least one entry for ${target}.`,
    };
  }
  return listed
    ? {
        verdict: "STORAGE_SKU_ADVERTISED",
        listed,
        restrictionReasons: [],
        reason: `The subscription's Storage SKU catalog lists ${target} in ${region}.`,
      }
    : {
        verdict: "STORAGE_SKU_NOT_LISTED",
        listed,
        restrictionReasons: [],
        reason: `The subscription's Storage SKU catalog has no entry for ${target} in ${region}.`,
      };
}

function isAccountSku(row: StorageSku): boolean {
  return row.resourceType.toLowerCase() === "storageaccounts";
}

function isMalformedAccountSku(row: StorageSku): boolean {
  return (
    typeof row.kind !== "string" ||
    typeof row.name !== "string" ||
    (row.locations != null && !isStringArray(row.locations)) ||
    (row.locationInfo != null &&
      (!Array.isArray(row.locationInfo) ||
        row.locationInfo.some((entry) => typeof entry?.location !== "string"))) ||
    (row.restrictions != null &&
      (!Array.isArray(row.restrictions) ||
        row.restrictions.some(
          (entry) =>
            typeof entry?.type !== "string" ||
            (entry.values != null && !isStringArray(entry.values)) ||
            (entry.reasonCode != null && typeof entry.reasonCode !== "string"),
        )))
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
