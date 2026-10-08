import { describe, expect, it } from "vitest";
import {
  explainResourceVerdict,
  explainVmVerdict,
  summarizeBlockers,
} from "../../src/core/explain.js";
import type {
  RegionVerdict,
  ResourceAvailabilityVerdict,
} from "../../src/core/types.js";

const SKU = "Standard_B1s";

const vmRow = (overrides: Partial<RegionVerdict> = {}): RegionVerdict => ({
  region: "westeurope",
  displayName: "West Europe",
  geographyGroup: "Europe",
  physicalLocation: "Netherlands",
  skuOffered: true,
  family: "standardBSFamily",
  used: 4,
  limit: 10,
  free: 6,
  policyAllowed: true,
  policyReason: null,
  verdict: "AVAILABLE",
  requiredVcpus: 1,
  skuRestrictions: null,
  familySizesOffered: null,
  errorDetail: null,
  ...overrides,
});

const resourceRow = (
  overrides: Partial<ResourceAvailabilityVerdict> = {},
): ResourceAvailabilityVerdict => ({
  kind: "resource",
  target: "storage-account",
  resourceType: "Microsoft.Storage/storageAccounts",
  region: "westeurope",
  displayName: "West Europe",
  geographyGroup: "Europe",
  physicalLocation: "Netherlands",
  policyAllowed: null,
  policyReason: null,
  confidence: "availability",
  verdict: "RESOURCE_SUPPORTED",
  providerRegistered: true,
  typeLocationCount: 42,
  notSupportedCause: null,
  ...overrides,
});

describe("explainVmVerdict", () => {
  it("explains AVAILABLE with quota evidence and no hint", () => {
    const e = explainVmVerdict(SKU, vmRow());
    expect(e.code).toBe("AVAILABLE");
    expect(e.reason).toBe(
      "Standard_B1s is offered in westeurope and family standardBSFamily has 6/10 vCPUs free (needs 1 vCPU).",
    );
    expect(e.hint).toBeNull();
  });

  it("explains FULL with the vCPU shortfall", () => {
    const e = explainVmVerdict(
      SKU,
      vmRow({ verdict: "FULL", free: 0, used: 4, limit: 4, requiredVcpus: 2 }),
    );
    expect(e.reason).toBe(
      "Standard_B1s needs 2 vCPUs but family standardBSFamily has only 0/4 free in westeurope — 2 vCPUs short.",
    );
    expect(e.hint).toContain("quota");
  });

  it("falls back to a family-less FULL sentence when quota numbers are missing", () => {
    const e = explainVmVerdict(
      SKU,
      vmRow({ verdict: "FULL", family: null, free: null, used: null, limit: null }),
    );
    expect(e.reason).toContain("no free vCPUs left");
  });

  it("explains SKU_NOT_OFFERED and surfaces same-series evidence", () => {
    const e = explainVmVerdict(
      SKU,
      vmRow({
        verdict: "SKU_NOT_OFFERED",
        skuOffered: false,
        family: null,
        used: null,
        limit: null,
        free: null,
        familySizesOffered: ["Standard_B2s", "Standard_B4ms"],
      }),
    );
    expect(e.reason).toContain("does not list Standard_B1s among the VM sizes offered in westeurope");
    expect(e.reason).toContain("Standard_B2s, Standard_B4ms");
    expect(e.hint).toContain("azw skus --region westeurope");
  });

  it("omits the series sentence when no same-series sizes are known", () => {
    const e = explainVmVerdict(
      SKU,
      vmRow({ verdict: "SKU_NOT_OFFERED", skuOffered: false, familySizesOffered: [] }),
    );
    expect(e.reason).not.toContain("Other sizes");
  });

  it("explains BLOCKED_FOR_SUB with the ARM restriction reason code", () => {
    const e = explainVmVerdict(
      SKU,
      vmRow({
        verdict: "BLOCKED_FOR_SUB",
        skuOffered: false,
        used: null,
        limit: null,
        free: null,
        skuRestrictions: [
          { type: "Location", reasonCode: "NotAvailableForSubscription", values: ["westeurope"] },
        ],
      }),
    );
    expect(e.reason).toBe(
      "Standard_B1s is listed in westeurope but restricted for this subscription (NotAvailableForSubscription).",
    );
    expect(e.hint).toBeTruthy();
  });

  it("explains POLICY_DENIED using the policy reason from the row", () => {
    const e = explainVmVerdict(
      SKU,
      vmRow({
        verdict: "POLICY_DENIED",
        policyAllowed: false,
        policyReason: "westeurope is not in the Azure Policy allowed-location list by policy p1.",
      }),
    );
    expect(e.reason).toBe(
      "westeurope is not in the Azure Policy allowed-location list by policy p1.",
    );
    expect(e.hint).toContain("allowed list");
  });

  it("explains QUOTA_UNKNOWN from an ARM failure with the error detail", () => {
    const e = explainVmVerdict(
      SKU,
      vmRow({
        verdict: "QUOTA_UNKNOWN",
        errorDetail: "ARM 429 Too Many Requests · /providers/Microsoft.Compute/locations/westeurope/usages",
      }),
    );
    expect(e.reason).toBe(
      "Could not read quota state in westeurope: ARM 429 Too Many Requests · /providers/Microsoft.Compute/locations/westeurope/usages",
    );
  });

  it("explains QUOTA_UNKNOWN from a missing usage row without inventing an error", () => {
    const e = explainVmVerdict(
      SKU,
      vmRow({ verdict: "QUOTA_UNKNOWN", used: null, limit: null, free: null }),
    );
    expect(e.reason).toBe(
      "The vCPU usage report has no row for family standardBSFamily in westeurope, so headroom is unknown.",
    );
    expect(e.hint).toContain("--refresh");
  });
});

describe("explainResourceVerdict", () => {
  it("explains RESOURCE_SUPPORTED without ever claiming deployability", () => {
    const e = explainResourceVerdict(resourceRow());
    expect(e.reason).toContain("advertised for westeurope");
    expect(e.reason).toContain("not deployability");
    expect(e.hint).toBeNull();
  });

  it("explains a missing provider namespace", () => {
    const e = explainResourceVerdict(
      resourceRow({
        resourceType: "Microsoft.Nonsense/doesNotExist",
        verdict: "RESOURCE_NOT_SUPPORTED",
        providerRegistered: null,
        typeLocationCount: null,
        notSupportedCause: "provider-not-found",
      }),
    );
    expect(e.reason).toContain("not in the subscription's provider catalog");
    expect(e.hint).toContain("azw resources --grep");
  });

  it("explains a missing resource type under a known provider", () => {
    const e = explainResourceVerdict(
      resourceRow({
        resourceType: "Microsoft.Storage/storageAccountss",
        verdict: "RESOURCE_NOT_SUPPORTED",
        typeLocationCount: null,
        notSupportedCause: "type-not-found",
      }),
    );
    expect(e.reason).toContain("does not list a 'storageAccountss' resource type");
    expect(e.hint).toContain("azw resources --namespace Microsoft.Storage");
  });

  it("explains a region that is not advertised for the type", () => {
    const e = explainResourceVerdict(
      resourceRow({ verdict: "RESOURCE_NOT_SUPPORTED", notSupportedCause: "region-not-advertised" }),
    );
    expect(e.reason).toBe(
      "Microsoft.Storage/storageAccounts advertises 42 regions; westeurope is not one of them.",
    );
    expect(e.hint).toContain("azw availability resource");
  });

  it("appends the registration hint when the provider is not registered", () => {
    const e = explainResourceVerdict(
      resourceRow({
        verdict: "RESOURCE_NOT_SUPPORTED",
        providerRegistered: false,
        notSupportedCause: "region-not-advertised",
      }),
    );
    expect(e.hint).toContain("az provider register --namespace Microsoft.Storage");
  });

  it("explains POLICY_DENIED identically to VM checks", () => {
    const e = explainResourceVerdict(
      resourceRow({
        verdict: "POLICY_DENIED",
        policyAllowed: false,
        policyReason: "westeurope is denied by policy.",
      }),
    );
    expect(e.reason).toBe("westeurope is denied by policy.");
  });
});

describe("summarizeBlockers", () => {
  it("returns null when nothing was scanned or something is deployable", () => {
    expect(summarizeBlockers([])).toBeNull();
    expect(summarizeBlockers([vmRow()])).toBeNull();
  });

  it("counts blockers in a stable order", () => {
    const summary = summarizeBlockers([
      vmRow({ verdict: "POLICY_DENIED", policyAllowed: false }),
      vmRow({ region: "eastus", verdict: "FULL", free: 0, limit: 4, requiredVcpus: 2 }),
      vmRow({ region: "eastus2", verdict: "SKU_NOT_OFFERED", skuOffered: false }),
      vmRow({ region: "westus", verdict: "QUOTA_UNKNOWN" }),
    ]);
    expect(summary).toBe(
      "Blocked: 1 policy-denied, 1 quota-full, 1 not offered, 1 quota unknown.",
    );
  });
});
