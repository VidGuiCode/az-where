import { describe, expect, it } from "vitest";
import {
  baseVerdict,
  buildBlockedForSubVerdict,
  buildErrorVerdict,
  buildNotOfferedVerdict,
  buildQuotaUnknownVerdict,
  buildQuotaVerdict,
  sortVerdicts,
} from "../../src/core/scan.js";
import { ArmHttpError } from "../../src/core/errors.js";
import type { AzLocation, AzVmSku, AzVmUsage, RegionVerdict } from "../../src/core/types.js";

const row = (region: string, verdict: RegionVerdict["verdict"]): RegionVerdict => ({
  region,
  displayName: region,
  geographyGroup: "Europe",
  physicalLocation: region,
  skuOffered: verdict === "AVAILABLE" || verdict === "FULL" || verdict === "QUOTA_UNKNOWN",
  family: "standardBSFamily",
  used: null,
  limit: null,
  free: null,
  policyAllowed: verdict === "POLICY_DENIED" ? false : true,
  policyReason: verdict === "POLICY_DENIED" ? `${region} denied` : null,
  verdict,
  requiredVcpus: null,
  skuRestrictions: null,
  familySizesOffered: null,
  errorDetail: null,
});

describe("scan verdict sorting", () => {
  it("sorts POLICY_DENIED below quota and subscription failures but above SKU_NOT_OFFERED", () => {
    const sorted = sortVerdicts([
      row("off", "SKU_NOT_OFFERED"),
      row("policy", "POLICY_DENIED"),
      row("full", "FULL"),
      row("sub", "BLOCKED_FOR_SUB"),
      row("unknown", "QUOTA_UNKNOWN"),
      row("ok", "AVAILABLE"),
    ]);

    expect(sorted.map((r) => r.verdict)).toEqual([
      "AVAILABLE",
      "QUOTA_UNKNOWN",
      "FULL",
      "BLOCKED_FOR_SUB",
      "POLICY_DENIED",
      "SKU_NOT_OFFERED",
    ]);
  });
});

describe("verdict builders (evidence capture, since 0.4.6)", () => {
  const location: AzLocation = {
    name: "westeurope",
    displayName: "West Europe",
    metadata: { geographyGroup: "Europe", physicalLocation: "Netherlands" },
  };

  const vmSku = (name: string, overrides: Partial<AzVmSku> = {}): AzVmSku => ({
    name,
    locations: ["westeurope"],
    resourceType: "virtualMachines",
    family: "standardBSFamily",
    ...overrides,
  });

  it("baseVerdict initialises every evidence field to null", () => {
    const base = baseVerdict(location);
    expect(base.verdict).toBe("SKU_NOT_OFFERED");
    expect(base.requiredVcpus).toBeNull();
    expect(base.skuRestrictions).toBeNull();
    expect(base.familySizesOffered).toBeNull();
    expect(base.errorDetail).toBeNull();
  });

  it("buildNotOfferedVerdict captures same-series sizes offered in the region", () => {
    const skus = [
      vmSku("Standard_B2s"),
      vmSku("Standard_B4ms"),
      vmSku("Standard_B12ms"),
      vmSku("Standard_D2s_v5"), // different series
      vmSku("Standard_B1s"), // the requested SKU itself
      { name: "Standard_BS_Family", locations: [], resourceType: "virtualMachines" },
    ];
    const verdict = buildNotOfferedVerdict(baseVerdict(location), skus, "Standard_B1s");
    expect(verdict.verdict).toBe("SKU_NOT_OFFERED");
    expect(verdict.familySizesOffered).toEqual(["Standard_B12ms", "Standard_B2s", "Standard_B4ms"]);
  });

  it("buildNotOfferedVerdict caps the same-series list at five sizes", () => {
    const skus = ["B2s", "B4ms", "B8ms", "B12ms", "B16ms", "B20ms"].map((size) =>
      vmSku(`Standard_${size}`),
    );
    const verdict = buildNotOfferedVerdict(baseVerdict(location), skus, "Standard_B1s");
    expect(verdict.familySizesOffered).toHaveLength(5);
  });

  it("buildBlockedForSubVerdict keeps the raw ARM restrictions", () => {
    const verdict = buildBlockedForSubVerdict(baseVerdict(location), {
      ...vmSku("Standard_B1s"),
      restrictions: [{ type: "Location", reasonCode: "NotAvailableForSubscription" }],
    });
    expect(verdict.verdict).toBe("BLOCKED_FOR_SUB");
    expect(verdict.skuRestrictions).toEqual([
      { type: "Location", reasonCode: "NotAvailableForSubscription" },
    ]);
  });

  it("buildQuotaUnknownVerdict records the required vCPUs", () => {
    const verdict = buildQuotaUnknownVerdict(baseVerdict(location), "standardBSFamily", 2);
    expect(verdict.verdict).toBe("QUOTA_UNKNOWN");
    expect(verdict.skuOffered).toBe(true);
    expect(verdict.requiredVcpus).toBe(2);
    expect(verdict.errorDetail).toBeNull();
  });

  it("buildQuotaVerdict marks AVAILABLE exactly when free covers the requirement", () => {
    const usage = (currentValue: number, limit: number): AzVmUsage => ({
      name: { value: "standardBSFamily", localizedValue: "Standard BS Family" },
      currentValue,
      limit,
      unit: "Count",
    });
    const tight = buildQuotaVerdict(baseVerdict(location), "standardBSFamily", 4, usage(6, 10));
    expect(tight.verdict).toBe("AVAILABLE");
    expect(tight.requiredVcpus).toBe(4);
    expect(tight.free).toBe(4);

    const over = buildQuotaVerdict(baseVerdict(location), "standardBSFamily", 4, usage(7, 10));
    expect(over.verdict).toBe("FULL");
    expect(over.free).toBe(3);
  });

  it("buildErrorVerdict summarises ArmHttpError without losing the endpoint", () => {
    const err = new ArmHttpError(
      429,
      "Too Many Requests",
      "/providers/Microsoft.Compute/locations/westeurope/usages",
      "TooManyRequests",
      "request throttled",
      "{}",
    );
    const verdict = buildErrorVerdict(baseVerdict(location), err);
    expect(verdict.verdict).toBe("QUOTA_UNKNOWN");
    expect(verdict.errorDetail).toBe(
      "ARM 429 Too Many Requests · TooManyRequests · /providers/Microsoft.Compute/locations/westeurope/usages",
    );
  });

  it("buildErrorVerdict truncates long generic error messages", () => {
    const verdict = buildErrorVerdict(
      baseVerdict(location),
      new Error("x".repeat(500)),
    );
    expect(verdict.errorDetail).toHaveLength(200);
    expect(verdict.errorDetail!.endsWith("...")).toBe(true);
  });
});
