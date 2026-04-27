import { describe, expect, it } from "vitest";
import { chooseSuggestion, resolvePlace } from "../../src/core/suggest.js";
import type { RegionVerdict } from "../../src/core/types.js";

const row = (region: string, free: number, physicalLocation: string): RegionVerdict => ({
  region,
  displayName: region,
  geographyGroup: "Europe",
  physicalLocation,
  skuOffered: true,
  family: "standardBSFamily",
  used: 0,
  limit: 10,
  free,
  policyAllowed: null,
  policyReason: null,
  verdict: "AVAILABLE",
});

describe("suggestion scoring", () => {
  it("only considers available rows", () => {
    const blocked: RegionVerdict = { ...row("blocked", 99, "Paris"), verdict: "BLOCKED_FOR_SUB" };
    const policyDenied: RegionVerdict = {
      ...row("policy", 100, "Paris"),
      policyAllowed: false,
      policyReason: "policy denied",
      verdict: "POLICY_DENIED",
    };
    expect(chooseSuggestion([blocked, row("westeurope", 1, "Netherlands")])?.row.region).toBe(
      "westeurope",
    );
    expect(
      chooseSuggestion([policyDenied, row("swedencentral", 1, "Gavle")])?.row.region,
    ).toBe("swedencentral");
  });

  it("prefers higher free quota without a near city", () => {
    expect(
      chooseSuggestion([row("westeurope", 1, "Netherlands"), row("denmarkeast", 4, "Copenhagen")])
        ?.row.region,
    ).toBe("denmarkeast");
  });

  it("uses distance as a tie-breaker when near is provided", () => {
    const nearLuxembourg = resolvePlace("Luxembourg");
    expect(
      chooseSuggestion([row("denmarkeast", 4, "Copenhagen"), row("westeurope", 4, "Netherlands")], nearLuxembourg)
        ?.row.region,
    ).toBe("westeurope");
  });

  it("returns null for unknown cities", () => {
    expect(resolvePlace("Atlantis")).toBeNull();
  });
});
