export interface AzAccount {
  id: string;
  name: string;
  tenantId: string;
  user: { name: string; type: string };
  state: string;
  isDefault: boolean;
}

export interface AzLocation {
  name: string;
  displayName: string;
  regionalDisplayName?: string;
  metadata?: {
    regionType?: string;
    regionCategory?: string;
    geographyGroup?: string;
    geography?: string;
    physicalLocation?: string;
    pairedRegion?: Array<{ name: string; id: string }>;
  };
}

export interface AzVmSku {
  name: string;
  locations: string[];
  family?: string;
  resourceType: string;
  size?: string;
  tier?: string;
  capabilities?: Array<{ name: string; value: string }>;
  restrictions?: Array<{
    type: string;
    reasonCode?: string;
    values?: string[];
  }>;
}

export interface AzVmUsage {
  name: { value: string; localizedValue: string };
  currentValue: number;
  limit: number;
  unit: string;
}

export interface AzProvider {
  namespace: string;
  registrationState?: string;
  resourceTypes?: AzProviderResourceType[];
}

export interface AzProviderResourceType {
  resourceType: string;
  locations?: string[];
  apiVersions?: string[];
  capabilities?: string;
}

/** Why a generic resource check returned RESOURCE_NOT_SUPPORTED. Since 0.4.6. */
export type NotSupportedCause =
  | "provider-not-found"
  | "type-not-found"
  | "region-not-advertised";

export interface RegionVerdict {
  region: string;
  displayName: string;
  geographyGroup?: string;
  physicalLocation?: string;
  skuOffered: boolean;
  family: string | null;
  used: number | null;
  limit: number | null;
  free: number | null;
  policyAllowed: boolean | null;
  policyReason: string | null;
  verdict:
    | "AVAILABLE"
    | "FULL"
    | "SKU_NOT_OFFERED"
    | "BLOCKED_FOR_SUB"
    | "POLICY_DENIED"
    | "QUOTA_UNKNOWN";
  /** vCPUs the checked SKU needs for one instance. Since 0.4.6. */
  requiredVcpus: number | null;
  /** Raw SKU restrictions reported by ARM when blocked for the subscription. Since 0.4.6. */
  skuRestrictions: Array<{ type: string; reasonCode?: string; values?: string[] }> | null;
  /** Same-series sizes the region lists when the requested SKU is not offered. Since 0.4.6. */
  familySizesOffered: string[] | null;
  /** Concise ARM failure summary when the verdict comes from a failed call. Since 0.4.6. */
  errorDetail: string | null;
}

export interface ResourceAvailabilityVerdict {
  kind: "resource";
  target: string;
  resourceType: string;
  region: string;
  displayName: string;
  geographyGroup?: string;
  physicalLocation?: string;
  policyAllowed: boolean | null;
  policyReason: string | null;
  confidence: "availability";
  verdict: "RESOURCE_SUPPORTED" | "RESOURCE_NOT_SUPPORTED" | "POLICY_DENIED";
  /** Provider registrationState === "Registered"; null when the provider is absent. Since 0.4.6. */
  providerRegistered: boolean | null;
  /** How many regions the provider advertises for this type; null when the type is absent. Since 0.4.6. */
  typeLocationCount: number | null;
  /** Why RESOURCE_NOT_SUPPORTED; null for every other verdict. Since 0.4.6. */
  notSupportedCause: NotSupportedCause | null;
}
