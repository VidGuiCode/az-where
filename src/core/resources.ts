import { armList } from "./arm.js";
import type { PolicyCheck } from "./policy.js";
import type {
  AzLocation,
  AzProvider,
  AzProviderResourceType,
  ResourceAvailabilityVerdict,
} from "./types.js";

export const RESOURCE_ALIASES: Record<string, string> = {
  "storage-account": "Microsoft.Storage/storageAccounts",
  "key-vault": "Microsoft.KeyVault/vaults",
  "web-app": "Microsoft.Web/sites",
  "app-service-plan": "Microsoft.Web/serverfarms",
  aks: "Microsoft.ContainerService/managedClusters",
  "postgres-flexible-server": "Microsoft.DBforPostgreSQL/flexibleServers",
};

export interface ResolvedResourceType {
  input: string;
  resourceType: string;
  alias: string | null;
  namespace: string;
  typePath: string;
}

export interface ResourceAvailabilityResult {
  resolved: ResolvedResourceType;
  rows: ResourceAvailabilityVerdict[];
  elapsedMs: number;
}

export function resolveResourceType(input: string): ResolvedResourceType | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const aliasKey = trimmed.toLowerCase();
  const resourceType = RESOURCE_ALIASES[aliasKey] ?? trimmed;
  const slash = resourceType.indexOf("/");
  if (slash <= 0 || slash === resourceType.length - 1) return null;
  return {
    input: trimmed,
    resourceType,
    alias: RESOURCE_ALIASES[aliasKey] ? aliasKey : null,
    namespace: resourceType.slice(0, slash),
    typePath: resourceType.slice(slash + 1),
  };
}

export async function scanResourceAvailability(opts: {
  target: string;
  locations: AzLocation[];
  refresh?: boolean;
  policy?: PolicyCheck;
}): Promise<ResourceAvailabilityResult> {
  const started = Date.now();
  const resolved = resolveResourceType(opts.target);
  if (!resolved) {
    return {
      resolved: {
        input: opts.target,
        resourceType: opts.target,
        alias: null,
        namespace: "",
        typePath: "",
      },
      rows: [],
      elapsedMs: Date.now() - started,
    };
  }

  const provider = await getProvider(resolved.namespace, Boolean(opts.refresh));
  const resource = findProviderResource(provider, resolved.typePath);
  const supported = new Set((resource?.locations ?? []).map(normalizeLocationLabel));

  const rows = opts.locations.map((location) =>
    classifyResourceLocation({
      target: opts.target,
      resolved,
      location,
      supported,
      policy: opts.policy,
    }),
  );

  return { resolved, rows: sortResourceVerdicts(rows), elapsedMs: Date.now() - started };
}

export function sortResourceVerdicts(
  rows: ResourceAvailabilityVerdict[],
): ResourceAvailabilityVerdict[] {
  const rank: Record<ResourceAvailabilityVerdict["verdict"], number> = {
    RESOURCE_SUPPORTED: 0,
    POLICY_DENIED: 1,
    RESOURCE_NOT_SUPPORTED: 2,
  };
  return [...rows].sort((a, b) => {
    const r = rank[a.verdict] - rank[b.verdict];
    if (r !== 0) return r;
    const g = (a.geographyGroup ?? "").localeCompare(b.geographyGroup ?? "");
    if (g !== 0) return g;
    return a.region.localeCompare(b.region);
  });
}

async function getProvider(namespace: string, refresh: boolean): Promise<AzProvider | null> {
  const providers = await armList<AzProvider>("/providers?api-version=2021-04-01", { refresh });
  return providers.find((p) => p.namespace.toLowerCase() === namespace.toLowerCase()) ?? null;
}

function findProviderResource(
  provider: AzProvider | null,
  typePath: string,
): AzProviderResourceType | null {
  const normalized = typePath.toLowerCase();
  return provider?.resourceTypes?.find((r) => r.resourceType.toLowerCase() === normalized) ?? null;
}

function classifyResourceLocation(opts: {
  target: string;
  resolved: ResolvedResourceType;
  location: AzLocation;
  supported: Set<string>;
  policy?: PolicyCheck;
}): ResourceAvailabilityVerdict {
  const base = {
    kind: "resource" as const,
    target: opts.target,
    resourceType: opts.resolved.resourceType,
    region: opts.location.name,
    displayName: opts.location.displayName,
    geographyGroup: opts.location.metadata?.geographyGroup,
    physicalLocation: opts.location.metadata?.physicalLocation,
    policyAllowed: opts.policy ? true : null,
    policyReason: null,
    confidence: "availability" as const,
  };

  if (opts.policy && !opts.policy.isAllowed(opts.location.name)) {
    return {
      ...base,
      policyAllowed: false,
      policyReason: opts.policy.reason(opts.location.name),
      verdict: "POLICY_DENIED",
    };
  }

  const labels = [
    opts.location.name,
    opts.location.displayName,
    opts.location.regionalDisplayName,
    opts.location.metadata?.physicalLocation,
  ]
    .filter((v): v is string => Boolean(v))
    .map(normalizeLocationLabel);
  const isSupported = labels.some((label) => opts.supported.has(label));
  return {
    ...base,
    verdict: isSupported ? "RESOURCE_SUPPORTED" : "RESOURCE_NOT_SUPPORTED",
  };
}

function normalizeLocationLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
