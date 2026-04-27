import { describe, expect, it } from "vitest";
import { sortVerdicts } from "../../src/core/scan.js";
import type { RegionVerdict } from "../../src/core/types.js";

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
