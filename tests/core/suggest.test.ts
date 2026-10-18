import { describe, expect, it } from "vitest";
import {
  chooseResourceSuggestion,
  chooseSuggestion,
  resolvePlace,
} from "../../src/core/suggest.js";
import type { AzLocation, RegionVerdict } from "../../src/core/types.js";

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

const loc = (name: string, physicalLocation: string, geographyGroup = "Europe"): AzLocation => ({
  name,
  displayName: name,
  metadata: { geographyGroup, physicalLocation },
});

describe("resource suggestion scoring (0.4.10)", () => {
  // Candidates as pick/suggest resource feed them: stable geography-group-
  // then-name axis order, every type supported.
  const candidates = [
    loc("denmarkeast", "Copenhagen"),
    loc("northeurope", "Ireland"),
    loc("westeurope", "Netherlands"),
  ];

  it("returns null when no region advertises every requested type", () => {
    expect(chooseResourceSuggestion([], 2)).toBeNull();
  });

  it("ties every candidate at 0 without --near so axis order wins", () => {
    const suggestion = chooseResourceSuggestion(candidates, 2);
    expect(suggestion?.location.name).toBe("denmarkeast");
    expect(suggestion?.score).toBe(0);
    expect(suggestion?.factors.distanceKm).toBeUndefined();
    expect(suggestion?.factors.geographyGroup).toBe("Europe");
    expect("free" in (suggestion?.factors ?? {})).toBe(false);
    expect("limit" in (suggestion?.factors ?? {})).toBe(false);
  });

  it("ranks by haversine distance to the --near city", () => {
    const nearLuxembourg = resolvePlace("Luxembourg");
    // Amsterdam (westeurope) is much closer to Luxembourg than Copenhagen or
    // Dublin, so distance scoring must beat the axis-order tie.
    const suggestion = chooseResourceSuggestion(candidates, 1, nearLuxembourg);
    expect(suggestion?.location.name).toBe("westeurope");
    expect(suggestion?.score).toBe(-(suggestion?.factors.distanceKm ?? 0));
    expect(suggestion?.factors.distanceKm).toBeGreaterThan(0);
  });

  it("states the all-N-types reason with the availability caveat", () => {
    const plural = chooseResourceSuggestion([loc("westeurope", "Netherlands")], 2);
    expect(plural?.reason).toBe(
      "westeurope advertises all 2 requested resource types — availability, not deployability.",
    );
    const single = chooseResourceSuggestion([loc("northeurope", "Ireland")], 1);
    expect(single?.reason).toContain("all 1 requested resource type");
    expect(single?.reason).toContain("availability, not deployability");
  });

  it("mentions the distance in the reason when --near is set", () => {
    const nearLuxembourg = resolvePlace("Luxembourg");
    const suggestion = chooseResourceSuggestion([loc("westeurope", "Netherlands")], 2, nearLuxembourg);
    expect(suggestion?.reason).toContain(
      `and is about ${suggestion?.factors.distanceKm} km from the requested location`,
    );
  });
});
