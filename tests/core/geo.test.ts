import { describe, expect, it } from "vitest";
import { filterByGeography, resolveGeography, shortGeo } from "../../src/core/geo.js";
import type { AzLocation } from "../../src/core/types.js";

// `listLocations` itself hits `az`, so we test the pure helpers directly —
// and the staging/euap exclusion regex is covered by exercising a copy of
// the same predicate over a hand-built fixture.
const STG_EUAP = /(stg|euap)$/i;
const customerRegions = (locs: AzLocation[]): AzLocation[] =>
  locs
    .filter((l) => l.metadata?.regionType === "Physical" || !l.metadata?.regionType)
    .filter((l) => !STG_EUAP.test(l.name));

const phys = (name: string, group = "Europe"): AzLocation => ({
  name,
  displayName: name,
  metadata: { regionType: "Physical", geographyGroup: group },
});

describe("listLocations filter (customer-deployable regions only)", () => {
  it("excludes *stg staging regions", () => {
    const all = [phys("eastus", "US"), phys("eastusstg", "US"), phys("southcentralusstg", "US")];
    expect(customerRegions(all).map((l) => l.name)).toEqual(["eastus"]);
  });

  it("excludes *euap preview regions", () => {
    const all = [phys("eastus2", "US"), phys("eastus2euap", "US"), phys("centraluseuap", "US")];
    expect(customerRegions(all).map((l) => l.name)).toEqual(["eastus2"]);
  });

  it("keeps regular physical regions", () => {
    const all = [phys("westeurope", "Europe"), phys("denmarkeast", "Europe")];
    expect(customerRegions(all).map((l) => l.name)).toEqual(["westeurope", "denmarkeast"]);
  });

  it("drops regions without Physical regionType set explicitly to Logical", () => {
    const all = [
      phys("eastus", "US"),
      { name: "logical", displayName: "logical", metadata: { regionType: "Logical" } },
    ];
    expect(customerRegions(all).map((l) => l.name)).toEqual(["eastus"]);
  });
});

describe("resolveGeography", () => {
  it("maps eu/us/asia to Azure geographyGroup values", () => {
    expect(resolveGeography("eu")).toBe("Europe");
    expect(resolveGeography("us")).toBe("US");
    expect(resolveGeography("asia")).toBe("Asia Pacific");
  });
  it("treats `all` and empty as no filter", () => {
    expect(resolveGeography("all")).toBeNull();
    expect(resolveGeography("")).toBeNull();
  });
  it("passes unknown groups through verbatim", () => {
    expect(resolveGeography("Middle East")).toBe("Middle East");
  });
});

describe("filterByGeography", () => {
  it("returns all when group is null", () => {
    const locs = [phys("a", "US"), phys("b", "Europe")];
    expect(filterByGeography(locs, null).length).toBe(2);
  });
  it("filters by exact geographyGroup match", () => {
    const locs = [phys("a", "US"), phys("b", "Europe"), phys("c", "US")];
    expect(filterByGeography(locs, "US").map((l) => l.name)).toEqual(["a", "c"]);
  });
});

describe("shortGeo", () => {
  it("abbreviates known groups", () => {
    expect(shortGeo("Europe")).toBe("EU");
    expect(shortGeo("Asia Pacific")).toBe("APAC");
    expect(shortGeo("Middle East")).toBe("ME");
  });
  it("falls back to a 4-letter slice", () => {
    expect(shortGeo("Mexico")).toBe("MEXI");
  });
});
