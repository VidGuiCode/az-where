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
  verdict: "AVAILABLE" | "FULL" | "SKU_NOT_OFFERED" | "BLOCKED_FOR_SUB" | "QUOTA_UNKNOWN";
}
