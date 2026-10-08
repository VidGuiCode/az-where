import { describe, expect, it } from "vitest";
import {
  buildClassificationContext,
  classifyResourceLocation,
  filterResourceTypes,
  flattenResourceTypes,
  RESOURCE_ALIASES,
  resolveResourceType,
  sortResourceVerdicts,
} from "../../src/core/resources.js";
import type {
  AzLocation,
  AzProvider,
  ResourceAvailabilityVerdict,
} from "../../src/core/types.js";

describe("resource aliases", () => {
  it("maps friendly aliases to Azure resource types", () => {
    expect(RESOURCE_ALIASES["storage-account"]).toBe("Microsoft.Storage/storageAccounts");
    expect(resolveResourceType("storage-account")).toMatchObject({
      alias: "storage-account",
      namespace: "Microsoft.Storage",
      typePath: "storageAccounts",
      resourceType: "Microsoft.Storage/storageAccounts",
    });
  });

  it("accepts raw Azure resource type strings", () => {
    expect(resolveResourceType("Microsoft.Web/sites")).toMatchObject({
      alias: null,
      namespace: "Microsoft.Web",
      typePath: "sites",
      resourceType: "Microsoft.Web/sites",
    });
  });

  it("rejects unknown aliases that are not raw resource types", () => {
    expect(resolveResourceType("made-up-resource")).toBeNull();
  });
});

describe("resource type discovery", () => {
  const providers: AzProvider[] = [
    {
      namespace: "Microsoft.Storage",
      resourceTypes: [
        { resourceType: "storageAccounts", locations: ["West Europe", "East US"] },
        { resourceType: "storageAccounts/blobServices", locations: ["West Europe"] },
      ],
    },
    {
      namespace: "Microsoft.DBforPostgreSQL",
      resourceTypes: [{ resourceType: "flexibleServers", locations: ["West Europe"] }],
    },
  ];

  it("flattens providers into one row per type with reverse-mapped aliases", () => {
    const flat = flattenResourceTypes(providers);
    expect(flat).toContainEqual({
      namespace: "Microsoft.Storage",
      resourceType: "Microsoft.Storage/storageAccounts",
      typePath: "storageAccounts",
      alias: "storage-account",
      locationCount: 2,
    });
    // Sub-resource with no alias keeps alias null.
    const blob = flat.find((e) => e.typePath === "storageAccounts/blobServices");
    expect(blob?.alias).toBeNull();
    expect(blob?.locationCount).toBe(1);
  });

  it("filters by exact namespace (case-insensitive)", () => {
    const flat = flattenResourceTypes(providers);
    const result = filterResourceTypes(flat, { namespace: "microsoft.storage" });
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.namespace === "Microsoft.Storage")).toBe(true);
  });

  it("filters by substring grep against the full resource type and sorts stably", () => {
    const flat = flattenResourceTypes(providers);
    const result = filterResourceTypes(flat, { grep: "postgres" });
    expect(result.map((e) => e.resourceType)).toEqual([
      "Microsoft.DBforPostgreSQL/flexibleServers",
    ]);
  });

  it("returns everything sorted when no filter is given", () => {
    const result = filterResourceTypes(flattenResourceTypes(providers));
    expect(result.map((e) => e.resourceType)).toEqual([
      "Microsoft.DBforPostgreSQL/flexibleServers",
      "Microsoft.Storage/storageAccounts",
      "Microsoft.Storage/storageAccounts/blobServices",
    ]);
  });
});

describe("resource availability sorting", () => {
  const row = (
    region: string,
    verdict: ResourceAvailabilityVerdict["verdict"],
  ): ResourceAvailabilityVerdict => ({
    kind: "resource",
    target: "storage-account",
    resourceType: "Microsoft.Storage/storageAccounts",
    region,
    displayName: region,
    policyAllowed: null,
    policyReason: null,
    confidence: "availability",
    verdict,
    providerRegistered: null,
    typeLocationCount: null,
    notSupportedCause: null,
  });

  it("sorts supported resources before denied and unsupported rows", () => {
    expect(
      sortResourceVerdicts([
        row("c", "RESOURCE_NOT_SUPPORTED"),
        row("b", "POLICY_DENIED"),
        row("a", "RESOURCE_SUPPORTED"),
      ]).map((r) => r.verdict),
    ).toEqual(["RESOURCE_SUPPORTED", "POLICY_DENIED", "RESOURCE_NOT_SUPPORTED"]);
  });
});

describe("classification context (since 0.4.6)", () => {
  const provider = (overrides: Partial<AzProvider> = {}): AzProvider => ({
    namespace: "Microsoft.Storage",
    registrationState: "Registered",
    resourceTypes: [{ resourceType: "storageAccounts", locations: ["West Europe", "East US"] }],
    ...overrides,
  });

  it("derives provider-not-found when the namespace is absent from the catalog", () => {
    const context = buildClassificationContext(null, null);
    expect(context.cause).toBe("provider-not-found");
    expect(context.providerRegistered).toBeNull();
    expect(context.typeLocationCount).toBeNull();
  });

  it("derives type-not-found when the provider exists without the type", () => {
    const context = buildClassificationContext(provider(), null);
    expect(context.cause).toBe("type-not-found");
    expect(context.providerRegistered).toBe(true);
    expect(context.typeLocationCount).toBeNull();
  });

  it("derives region-not-advertised and the advertised location count", () => {
    const context = buildClassificationContext(
      provider(),
      provider().resourceTypes![0],
    );
    expect(context.cause).toBe("region-not-advertised");
    expect(context.typeLocationCount).toBe(2);
  });

  it("maps registrationState to a boolean and unknown states to null", () => {
    expect(buildClassificationContext(provider(), null).providerRegistered).toBe(true);
    expect(
      buildClassificationContext(provider({ registrationState: "NotRegistered" }), null)
        .providerRegistered,
    ).toBe(false);
    expect(buildClassificationContext(provider({ registrationState: undefined }), null).providerRegistered).toBeNull();
  });
});

describe("classifyResourceLocation evidence fields (since 0.4.6)", () => {
  const location: AzLocation = {
    name: "westeurope",
    displayName: "West Europe",
    regionalDisplayName: "(Europe) West Europe",
    metadata: { geographyGroup: "Europe", physicalLocation: "Netherlands" },
  };
  const resolved = resolveResourceType("storage-account")!;

  const classify = (supported: Set<string>, cause: "region-not-advertised" | "type-not-found") =>
    classifyResourceLocation({
      target: "storage-account",
      resolved,
      location,
      supported,
      context: { cause, providerRegistered: true, typeLocationCount: 42 },
    });

  it("supported rows carry the provider context and no not-supported cause", () => {
    const row = classify(new Set(["westeurope"]), "region-not-advertised");
    expect(row.verdict).toBe("RESOURCE_SUPPORTED");
    expect(row.providerRegistered).toBe(true);
    expect(row.typeLocationCount).toBe(42);
    expect(row.notSupportedCause).toBeNull();
  });

  it("not-advertised rows record the region-not-advertised cause", () => {
    const row = classify(new Set(["eastus"]), "region-not-advertised");
    expect(row.verdict).toBe("RESOURCE_NOT_SUPPORTED");
    expect(row.notSupportedCause).toBe("region-not-advertised");
  });

  it("unknown-type rows record the type-not-found cause even though the set is empty", () => {
    const row = classify(new Set(), "type-not-found");
    expect(row.verdict).toBe("RESOURCE_NOT_SUPPORTED");
    expect(row.notSupportedCause).toBe("type-not-found");
    expect(row.typeLocationCount).toBe(42);
  });
});
