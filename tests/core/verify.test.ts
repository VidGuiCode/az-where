import { describe, expect, it } from "vitest";
import type { IacResourcePair, IacVmPair } from "../../src/core/iac.js";
import {
  buildVerifyResourceTable,
  buildVerifyTable,
  classifyVerifyRegion,
  classifyVerifyResourcePairs,
  countResourceVerdicts,
  countVerdicts,
  matchVerifyLocations,
  pairKey,
  toVerifyResourceRow,
  toVerifyRow,
  verifyBlockerSummary,
  verifyResourceBlockerSummary,
} from "../../src/core/verify.js";
import type {
  AzLocation,
  AzProvider,
  AzVmSku,
  AzVmUsage,
} from "../../src/core/types.js";

const loc = (name: string, displayName = name, geographyGroup = "Europe"): AzLocation => ({
  name,
  displayName,
  metadata: { geographyGroup, physicalLocation: displayName },
});

const vmSku = (
  name: string,
  family: string,
  opts: { vcpus?: number; restricted?: boolean } = {},
): AzVmSku => ({
  name,
  family,
  locations: [],
  resourceType: "virtualMachines",
  capabilities: [
    { name: "vCPUs", value: String(opts.vcpus ?? 2) },
    { name: "MemoryGB", value: "8" },
  ],
  restrictions: opts.restricted
    ? [{ type: "NotAvailable", reasonCode: "NotAvailableForSubscription" }]
    : [],
});

const usage = (family: string, free: number, limit = 10): AzVmUsage => ({
  name: { value: family, localizedValue: family },
  currentValue: limit - free,
  limit,
  unit: "Count",
});

const pair = (overrides: Partial<IacVmPair> = {}): IacVmPair => ({
  file: "main.tf",
  line: 5,
  format: "terraform",
  resourceType: "azurerm_linux_virtual_machine",
  resourceName: "vm",
  sku: "Standard_B1s",
  locationLiteral: "westeurope",
  capacity: 1,
  ...overrides,
});

const resourcePair = (overrides: Partial<IacResourcePair> = {}): IacResourcePair => ({
  file: "main.tf",
  line: 8,
  format: "terraform",
  resourceType: "azurerm_storage_account",
  armType: "Microsoft.Storage/storageAccounts",
  resourceName: "stg",
  locationLiteral: "westeurope",
  ...overrides,
});

const PROVIDERS: AzProvider[] = [
  {
    namespace: "Microsoft.Storage",
    registrationState: "Registered",
    resourceTypes: [
      { resourceType: "storageAccounts", locations: ["West Europe", "East US"] },
    ],
  },
  { namespace: "Microsoft.ContainerService", resourceTypes: [] },
];

function classify(
  pairs: IacVmPair[],
  catalog: AzVmSku[],
  usages: AzVmUsage[] | null,
  opts: { policyAllowed?: boolean | null; location?: AzLocation } = {},
) {
  return classifyVerifyRegion({
    location: opts.location ?? loc("westeurope"),
    pairs,
    skuCatalog: catalog,
    usages,
    policyAllowed: opts.policyAllowed ?? null,
    policyReason: opts.policyAllowed === false ? "policy says no" : null,
  });
}

describe("matchVerifyLocations", () => {
  const locations = [
    loc("westeurope", "West Europe"),
    loc("francecentral", "France Central"),
  ];

  it("matches ARM names case-insensitively", () => {
    const { matched, unmatched } = matchVerifyLocations(
      [pair({ locationLiteral: "WestEurope" })],
      locations,
    );
    expect(matched).toHaveLength(1);
    expect(matched[0]?.location.name).toBe("westeurope");
    expect(unmatched).toHaveLength(0);
  });

  it("matches display names like 'West Europe' to the ARM name", () => {
    const { matched } = matchVerifyLocations(
      [pair({ locationLiteral: "west europe" })],
      locations,
    );
    expect(matched[0]?.location.name).toBe("westeurope");
  });

  it("turns unmatched literals into unknown-region skips with the literal echoed", () => {
    const { matched, unmatched } = matchVerifyLocations(
      [pair({ resourceName: "vm", locationLiteral: "westeurop" })],
      locations,
    );
    expect(matched).toHaveLength(0);
    expect(unmatched[0]).toMatchObject({
      resourceName: "vm",
      reason: "unknown-region",
      detail: "westeurop",
    });
  });
});

describe("classifyVerifyRegion", () => {
  const B1S = "Standard_B1s";
  const B2S = "Standard_B2s";
  const FAMILY = "standardBSFamily";

  it("returns AVAILABLE when quota headroom covers the single-instance need", () => {
    const verdicts = classify([pair()], [vmSku(B1S, FAMILY, { vcpus: 1 })], [usage(FAMILY, 4)]);
    expect(verdicts.get(pairKey(pair()))?.verdict).toBe("AVAILABLE");
    expect(verdicts.get(pairKey(pair()))?.requiredVcpus).toBe(1);
  });

  it("multiplies required vCPUs by scale-set capacity", () => {
    const vmssPair = pair({ capacity: 3, sku: B2S });
    const verdicts = classify(
      [vmssPair],
      [vmSku(B2S, FAMILY, { vcpus: 2 })],
      [usage(FAMILY, 4)],
    );
    const row = verdicts.get(pairKey(vmssPair));
    // 2 vCPUs × capacity 3 = 6 needed vs 4 free → FULL.
    expect(row?.verdict).toBe("FULL");
    expect(row?.requiredVcpus).toBe(6);
  });

  it("treats a null (dynamic) capacity as a single instance", () => {
    const dyn = pair({ capacity: null, sku: B2S });
    const verdicts = classify(
      [dyn],
      [vmSku(B2S, FAMILY, { vcpus: 2 })],
      [usage(FAMILY, 4)],
    );
    expect(verdicts.get(pairKey(dyn))?.requiredVcpus).toBe(2);
  });

  it("keeps not-offered evidence (same-series sizes) on SKU_NOT_OFFERED", () => {
    const verdicts = classify([pair({ sku: B1S })], [vmSku(B2S, FAMILY)], null);
    const row = verdicts.get(pairKey(pair()));
    expect(row?.verdict).toBe("SKU_NOT_OFFERED");
    expect(row?.familySizesOffered).toContain(B2S);
  });

  it("keeps raw restrictions on BLOCKED_FOR_SUB", () => {
    const verdicts = classify(
      [pair()],
      [vmSku(B1S, FAMILY, { restricted: true })],
      [usage(FAMILY, 4)],
    );
    const row = verdicts.get(pairKey(pair()));
    expect(row?.verdict).toBe("BLOCKED_FOR_SUB");
    expect(row?.skuRestrictions?.[0]?.reasonCode).toBe("NotAvailableForSubscription");
  });

  it("denies every pair without ARM calls when policy blocks the region", () => {
    const verdicts = classify(
      [pair(), pair({ sku: B2S, resourceName: "vm2" })],
      [vmSku(B1S, FAMILY)],
      [usage(FAMILY, 4)],
      { policyAllowed: false },
    );
    expect(verdicts.size).toBe(2);
    for (const v of verdicts.values()) {
      expect(v.verdict).toBe("POLICY_DENIED");
      expect(v.policyAllowed).toBe(false);
      expect(v.policyReason).toBe("policy says no");
    }
  });

  it("returns QUOTA_UNKNOWN when the usage report has no family row", () => {
    const verdicts = classify([pair()], [vmSku(B1S, FAMILY)], []);
    const row = verdicts.get(pairKey(pair()));
    expect(row?.verdict).toBe("QUOTA_UNKNOWN");
    expect(row?.skuOffered).toBe(true);
    expect(row?.errorDetail).toBeNull();
  });

  it("deduplicates identical (sku, capacity) pairs within a region", () => {
    const twin = pair({ resourceName: "vm_copy", line: 9 });
    const verdicts = classify(
      [pair(), twin],
      [vmSku(B1S, FAMILY, { vcpus: 1 })],
      [usage(FAMILY, 4)],
    );
    expect(verdicts.size).toBe(1);
  });

  it("classifies the same SKU at different capacities separately", () => {
    const small = pair({ sku: B2S, capacity: 1 });
    const big = pair({ sku: B2S, capacity: 5, resourceName: "vm_big" });
    const verdicts = classify(
      [small, big],
      [vmSku(B2S, FAMILY, { vcpus: 2 })],
      [usage(FAMILY, 4)],
    );
    expect(verdicts.get(pairKey(small))?.verdict).toBe("AVAILABLE");
    expect(verdicts.get(pairKey(big))?.verdict).toBe("FULL");
  });
});

describe("toVerifyRow", () => {
  it("carries source metadata, the full verdict row, and an explanation", () => {
    const p = pair({ resourceName: "vm_linux", capacity: 2, sku: "Standard_B2s" });
    const verdict = classify([p], [vmSku("Standard_B2s", "standardBSFamily", { vcpus: 2 })], [
      usage("standardBSFamily", 8),
    ]).get(pairKey(p))!;
    const row = toVerifyRow(p, verdict);
    expect(row).toMatchObject({
      file: "main.tf",
      line: 5,
      resourceName: "vm_linux",
      sku: "Standard_B2s",
      region: "westeurope",
      capacity: 2,
    });
    expect(row.checks.verdict).toBe("AVAILABLE");
    expect(row.explanation.code).toBe("AVAILABLE");
    expect(row.explanation.hint).toBeNull();
  });
});

describe("summary helpers", () => {
  it("counts verdicts across rows", () => {
    const rows = [
      toVerifyRow(pair(), { ...baseRow(), verdict: "AVAILABLE" }),
      toVerifyRow(pair({ resourceName: "a" }), { ...baseRow(), verdict: "FULL" }),
      toVerifyRow(pair({ resourceName: "b" }), { ...baseRow(), verdict: "FULL" }),
    ];
    const counts = countVerdicts(rows);
    expect(counts.AVAILABLE).toBe(1);
    expect(counts.FULL).toBe(2);
  });

  it("summarizes blockers even when some rows deploy", () => {
    expect(verifyBlockerSummary({ ...emptyCounts(), FULL: 2, SKU_NOT_OFFERED: 1 })).toBe(
      "Blocked: 2 quota-full, 1 not offered.",
    );
    expect(verifyBlockerSummary(emptyCounts())).toBeNull();
  });

  it("builds the human table in source order", () => {
    const rows = [
      toVerifyRow(pair(), { ...baseRow(), verdict: "AVAILABLE", free: 4, limit: 10 }),
      toVerifyRow(pair({ resourceName: "vm_win" }), { ...baseRow(), verdict: "FULL" }),
    ];
    const { headers, body } = buildVerifyTable(rows);
    expect(headers).toEqual(["RESOURCE", "SKU", "REGION", "VERDICT", "QUOTA"]);
    expect(body[0]?.[0]).toBe("vm");
    expect(body[1]?.[0]).toBe("vm_win");
    expect(body[0]?.[1]).toBe("B1s");
  });
});

describe("matchVerifyLocations (generic resource pairs)", () => {
  const locations = [
    loc("westeurope", "West Europe"),
    loc("francecentral", "France Central"),
  ];

  it("matches resource pairs the same way as VM pairs", () => {
    const { matched, unmatched } = matchVerifyLocations(
      [resourcePair({ locationLiteral: "West Europe" })],
      locations,
    );
    expect(matched).toHaveLength(1);
    expect(matched[0]?.location.name).toBe("westeurope");
    expect(unmatched).toHaveLength(0);
  });

  it("turns unmatched resource literals into unknown-region skips with the IaC type echoed", () => {
    const { matched, unmatched } = matchVerifyLocations(
      [resourcePair({ resourceName: "stg", locationLiteral: "atlantic" })],
      locations,
    );
    expect(matched).toHaveLength(0);
    expect(unmatched[0]).toMatchObject({
      resourceName: "stg",
      resourceType: "azurerm_storage_account",
      reason: "unknown-region",
      detail: "atlantic",
    });
  });
});

describe("classifyVerifyResourcePairs", () => {
  it("returns RESOURCE_SUPPORTED when the catalog advertises the region", () => {
    const rows = classifyVerifyResourcePairs({
      pairs: [{ pair: resourcePair(), location: loc("westeurope") }],
      providers: PROVIDERS,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.checks.verdict).toBe("RESOURCE_SUPPORTED");
    expect(rows[0]?.checks.confidence).toBe("availability");
    expect(rows[0]?.checks.providerRegistered).toBe(true);
  });

  it("returns RESOURCE_NOT_SUPPORTED with the cause when the region is not advertised", () => {
    const rows = classifyVerifyResourcePairs({
      pairs: [{ pair: resourcePair({ locationLiteral: "eastasia" }), location: loc("eastasia") }],
      providers: PROVIDERS,
    });
    expect(rows[0]?.checks.verdict).toBe("RESOURCE_NOT_SUPPORTED");
    expect(rows[0]?.checks.notSupportedCause).toBe("region-not-advertised");
    expect(rows[0]?.explanation.code).toBe("RESOURCE_NOT_SUPPORTED");
    expect(rows[0]?.explanation.hint).toBeTruthy();
  });

  it("derives type-not-found when the provider lists no such type", () => {
    const rows = classifyVerifyResourcePairs({
      pairs: [
        {
          pair: resourcePair({
            resourceType: "azurerm_kubernetes_cluster",
            armType: "Microsoft.ContainerService/managedClusters",
            resourceName: "aks",
          }),
          location: loc("westeurope"),
        },
      ],
      providers: PROVIDERS,
    });
    expect(rows[0]?.checks.verdict).toBe("RESOURCE_NOT_SUPPORTED");
    expect(rows[0]?.checks.notSupportedCause).toBe("type-not-found");
  });

  it("denies policy-blocked regions for generic pairs too", () => {
    const policy = {
      summary: { checked: true, restricted: true, allowedLocations: ["westeurope"], assignments: [], error: null },
      isAllowed: (region: string) => region === "westeurope",
      reason: (region: string) => (region === "westeurope" ? null : "policy says no"),
    };
    const rows = classifyVerifyResourcePairs({
      pairs: [
        {
          pair: resourcePair({ resourceName: "stg", locationLiteral: "francecentral" }),
          location: loc("francecentral"),
        },
      ],
      // Even an empty catalog must not matter: policy runs first.
      providers: [],
      policy,
    });
    expect(rows[0]?.checks.verdict).toBe("POLICY_DENIED");
    expect(rows[0]?.checks.policyReason).toBe("policy says no");
  });

  it("shares one classification per type across pairs in source order", () => {
    const rows = classifyVerifyResourcePairs({
      pairs: [
        { pair: resourcePair({ resourceName: "stg1" }), location: loc("westeurope") },
        { pair: resourcePair({ resourceName: "stg2", line: 12 }), location: loc("westeurope") },
        {
          pair: resourcePair({ resourceName: "stg3", line: 15, locationLiteral: "francecentral" }),
          location: loc("francecentral"),
        },
      ],
      providers: PROVIDERS,
    });
    expect(rows.map((r) => r.resourceName)).toEqual(["stg1", "stg2", "stg3"]);
    expect(rows[2]?.checks.verdict).toBe("RESOURCE_NOT_SUPPORTED");
  });
});

describe("toVerifyResourceRow", () => {
  it("carries source metadata, the full resource row, and an availability explanation", () => {
    const p = resourcePair({ resourceName: "stg", line: 14 });
    const rows = classifyVerifyResourcePairs({
      pairs: [{ pair: p, location: loc("westeurope") }],
      providers: PROVIDERS,
    });
    const row = toVerifyResourceRow(p, rows[0]!.checks);
    expect(row).toMatchObject({
      file: "main.tf",
      line: 14,
      resourceType: "Microsoft.Storage/storageAccounts",
      sourceType: "azurerm_storage_account",
      resourceName: "stg",
      region: "westeurope",
    });
    expect(row.explanation.code).toBe("RESOURCE_SUPPORTED");
    // Availability explanations always say they are not deployability claims.
    expect(row.explanation.reason).toContain("not deployability");
  });
});

describe("generic resource summary helpers", () => {
  it("counts resource verdicts across rows", () => {
    const rows = [
      toVerifyResourceRow(resourcePair(), { ...resourceRow(), verdict: "RESOURCE_SUPPORTED" }),
      toVerifyResourceRow(resourcePair({ resourceName: "a", line: 2 }), {
        ...resourceRow(),
        verdict: "RESOURCE_NOT_SUPPORTED",
      }),
    ];
    const counts = countResourceVerdicts(rows);
    expect(counts.RESOURCE_SUPPORTED).toBe(1);
    expect(counts.RESOURCE_NOT_SUPPORTED).toBe(1);
    expect(counts.POLICY_DENIED).toBe(0);
  });

  it("summarizes resource blockers and stays null when everything is supported", () => {
    expect(
      verifyResourceBlockerSummary({ RESOURCE_SUPPORTED: 0, RESOURCE_NOT_SUPPORTED: 2, POLICY_DENIED: 1 }),
    ).toBe("Blocked: 1 policy-denied, 2 not advertised.");
    expect(
      verifyResourceBlockerSummary({ RESOURCE_SUPPORTED: 3, RESOURCE_NOT_SUPPORTED: 0, POLICY_DENIED: 0 }),
    ).toBeNull();
  });

  it("builds the human resource table with the alias and confidence", () => {
    const rows = [
      toVerifyResourceRow(resourcePair(), { ...resourceRow(), verdict: "RESOURCE_SUPPORTED" }),
    ];
    const { headers, body } = buildVerifyResourceTable(rows);
    expect(headers).toEqual(["RESOURCE", "TYPE", "REGION", "VERDICT", "CONFIDENCE"]);
    expect(body[0]?.[0]).toBe("stg");
    expect(body[0]?.[1]).toBe("storage-account");
    expect(body[0]?.[2]).toBe("westeurope");
    expect(body[0]?.[3]).toContain("SUPPORTED");
    expect(body[0]?.[4]).toBe("availability");
  });
});

function baseRow() {
  return {
    region: "westeurope",
    displayName: "West Europe",
    skuOffered: true,
    family: null,
    used: null,
    limit: null,
    free: null,
    policyAllowed: null,
    policyReason: null,
    verdict: "AVAILABLE" as const,
    requiredVcpus: null,
    skuRestrictions: null,
    familySizesOffered: null,
    errorDetail: null,
  };
}

function resourceRow() {
  return {
    kind: "resource" as const,
    target: "Microsoft.Storage/storageAccounts",
    resourceType: "Microsoft.Storage/storageAccounts",
    region: "westeurope",
    displayName: "West Europe",
    geographyGroup: "Europe",
    physicalLocation: "Netherlands",
    policyAllowed: null,
    policyReason: null,
    confidence: "availability" as const,
    verdict: "RESOURCE_SUPPORTED" as const,
    providerRegistered: true,
    typeLocationCount: 42,
    notSupportedCause: null,
  };
}

function emptyCounts() {
  return {
    AVAILABLE: 0,
    FULL: 0,
    SKU_NOT_OFFERED: 0,
    BLOCKED_FOR_SUB: 0,
    POLICY_DENIED: 0,
    QUOTA_UNKNOWN: 0,
  };
}
