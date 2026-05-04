import { describe, expect, it } from "vitest";
import { RESOURCE_ALIASES, resolveResourceType, sortResourceVerdicts } from "../../src/core/resources.js";
import type { ResourceAvailabilityVerdict } from "../../src/core/types.js";

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
