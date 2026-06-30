import { describe, expect, it } from "vitest";
import {
  filterResourceTypes,
  flattenResourceTypes,
  RESOURCE_ALIASES,
  resolveResourceType,
  sortResourceVerdicts,
} from "../../src/core/resources.js";
import type { AzProvider, ResourceAvailabilityVerdict } from "../../src/core/types.js";

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
