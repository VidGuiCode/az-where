import { describe, expect, it } from "vitest";
import {
  allDeployableRegions,
  buildCompareTable,
  classifyCompareLocation,
  collectSkuInfo,
  compareColumnLabel,
  compareLegendLine,
  MAX_COMPARE_SKUS,
  parseSkuList,
  sortCompareRowsForTable,
  summarizeCompare,
} from "../../src/core/compare.js";
import { ValidationError } from "../../src/core/errors.js";
import type { AzLocation, AzVmSku, AzVmUsage } from "../../src/core/types.js";

const loc = (name: string, geographyGroup = "Europe"): AzLocation => ({
  name,
  displayName: name,
  metadata: { geographyGroup, physicalLocation: name },
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
  restrictions: opts.restricted ? [{ type: "NotAvailable" , reasonCode: "NotAvailableForSubscription" }] : [],
});

const usage = (family: string, free: number, limit = 10): AzVmUsage => ({
  name: { value: family, localizedValue: family },
  currentValue: limit - free,
  limit,
  unit: "Count",
});

function classify(
  location: AzLocation,
  skus: string[],
  catalog: AzVmSku[],
  usages: AzVmUsage[] | null,
  policyAllowed: boolean | null = null,
) {
  return classifyCompareLocation({
    location,
    skus,
    skuCatalog: catalog,
    usages,
    policyAllowed,
    policyReason: policyAllowed === false ? `${location.name} denied` : null,
  });
}

describe("parseSkuList", () => {
  it("normalizes, trims, and deduplicates SKU tokens", () => {
    expect(parseSkuList("B1s, b2s ,Standard_D2s_v5,B1s")).toEqual([
      "Standard_B1s",
      "Standard_b2s",
      "Standard_D2s_v5",
    ]);
  });

  it("rejects an entirely empty list", () => {
    expect(() => parseSkuList("")).toThrow(ValidationError);
    expect(() => parseSkuList(" , ")).toThrow(ValidationError);
  });

  it("rejects an empty entry between commas", () => {
    expect(() => parseSkuList("B1s,,B2s")).toThrow(/empty entry/);
    expect(() => parseSkuList(",B2s")).toThrow(/empty entry/);
  });

  it("caps the list length to keep tables readable", () => {
    const many = Array.from({ length: MAX_COMPARE_SKUS + 1 }, (_, i) => `B${i}s`).join(",");
    expect(() => parseSkuList(many)).toThrow(RegExp(`${MAX_COMPARE_SKUS}`));
  });
});

describe("classifyCompareLocation", () => {
  const B1S = "Standard_B1s";
  const B2S = "Standard_B2s";
  const skus = [B1S, B2S];

  it("classifies each SKU independently from one shared catalog fetch", () => {
    const cells = classify(
      loc("westeurope"),
      skus,
      [vmSku(B1S, "standardBSFamily", { vcpus: 1 }), vmSku(B2S, "standardBSFamily", { vcpus: 2 })],
      [usage("standardBSFamily", 4)],
    );
    expect(cells.map((c) => [c.sku, c.verdict])).toEqual([
      [B1S, "AVAILABLE"],
      [B2S, "AVAILABLE"],
    ]);
    expect(cells[0].skuOffered).toBe(true);
  });

  it("marks quota-full only for the SKU whose vCPU need exceeds free quota", () => {
    const cells = classify(
      loc("francecentral"),
      skus,
      [vmSku(B1S, "smallFamily", { vcpus: 1 }), vmSku(B2S, "bigFamily", { vcpus: 8 })],
      [usage("smallFamily", 4), usage("bigFamily", 2)],
    );
    expect(cells.map((c) => c.verdict)).toEqual(["AVAILABLE", "FULL"]);
  });

  it("keeps not-offered and blocked SKUs side by side with deployable ones", () => {
    const cells = classify(
      loc("northeurope"),
      [B1S, B2S, "Standard_D2s_v5"],
      [vmSku(B1S, "standardBSFamily"), vmSku("Standard_D2s_v5", "standardDsv5Family", { restricted: true })],
      [usage("standardBSFamily", 10), usage("standardDsv5Family", 10)],
    );
    expect(cells.map((c) => [c.sku, c.verdict, c.skuOffered])).toEqual([
      [B1S, "AVAILABLE", true],
      [B2S, "SKU_NOT_OFFERED", false],
      ["Standard_D2s_v5", "BLOCKED_FOR_SUB", false],
    ]);
  });

  it("denies every SKU when policy blocks the region, without needing the catalog", () => {
    const cells = classify(loc("denmarkeast"), skus, [], null, false);
    expect(cells.every((c) => c.verdict === "POLICY_DENIED")).toBe(true);
    expect(cells[0].policyAllowed).toBe(false);
    expect(cells[0].policyReason).toContain("denmarkeast");
  });

  it("reports QUOTA_UNKNOWN when the usage endpoint yields no family match", () => {
    const cells = classify(loc("swedencentral"), [B1S], [vmSku(B1S, "standardBSFamily")], null);
    expect(cells[0].verdict).toBe("QUOTA_UNKNOWN");
    expect(cells[0].skuOffered).toBe(true);
  });
});

describe("collectSkuInfo", () => {
  it("records family/vCPU/memory per SKU, first catalog wins", () => {
    const info = new Map();
    collectSkuInfo(
      [
        vmSku("Standard_B1s", "standardBSFamily", { vcpus: 1 }),
        { name: "Microsoft.Compute/ disks", family: "other", resourceType: "disks", locations: [] },
      ],
      info,
    );
    collectSkuInfo([vmSku("Standard_B1s", "conflictingFamily", { vcpus: 99 })], info);

    expect(info.get("Standard_B1s")).toEqual({
      family: "standardBSFamily",
      vcpus: 1,
      memoryGiB: 8,
    });
    expect(info.has("Microsoft.Compute/ disks")).toBe(false);
  });
});

describe("summarizeCompare", () => {
  const B1S = "Standard_B1s";
  const B2S = "Standard_B2s";
  const skus = [B1S, B2S];

  function twoRegionRows() {
    const west = classify(
      loc("westeurope"),
      skus,
      [vmSku(B1S, "standardBSFamily", { vcpus: 1 }), vmSku(B2S, "standardBSFamily")],
      [usage("standardBSFamily", 4)],
    );
    const north = classify(
      loc("northeurope"),
      skus,
      [vmSku(B1S, "standardBSFamily", { vcpus: 1 }), vmSku(B2S, "standardBSFamily")],
      [usage("standardBSFamily", 1)],
    );
    return [
      { location: loc("westeurope"), cells: west },
      { location: loc("northeurope"), cells: north },
    ];
  }

  it("pivots region-major rows into per-SKU summaries in user order", () => {
    const rows = twoRegionRows();
    const summaries = summarizeCompare(rows, skus);
    expect(summaries.map((s) => s.sku)).toEqual([B1S, B2S]);
    expect(summaries[0].regions.map((r) => r.region)).toEqual(["westeurope", "northeurope"]);
    expect(summaries[0].deployableRegions).toEqual(["westeurope", "northeurope"]);
    expect(summaries[1].deployableRegions).toEqual(["westeurope"]);
    expect(summaries[1].verdictCounts).toMatchObject({ AVAILABLE: 1, FULL: 1 });
    expect(summaries[0].deployableCount).toBe(2);
  });

  it("attaches SKU facts from the info map when provided", () => {
    const summaries = summarizeCompare(twoRegionRows(), [B1S], new Map([[B1S, { family: "f", vcpus: 1, memoryGiB: 1 }]]));
    expect(summaries[0].family).toBe("f");
    expect(summaries[0].vcpus).toBe(1);
  });
});

describe("table rendering", () => {
  const B1S = "Standard_B1s";
  const B2S = "Standard_B2s";
  const skus = [B1S, B2S];

  it("builds REGION/GEO headers plus one column per SKU with verdict glyphs", () => {
    const rows = [
      {
        location: loc("westeurope"),
        cells: classify(loc("westeurope"), skus, [vmSku(B1S, "f"), vmSku(B2S, "f")], [usage("f", 4)]),
      },
      {
        location: loc("northeurope"),
        cells: classify(loc("northeurope"), skus, [vmSku(B1S, "f")], [usage("f", 4)]),
      },
    ];
    const { headers, body } = buildCompareTable(rows, skus);
    expect(headers).toEqual(["REGION", "GEO", "B1s", "B2s"]);
    expect(body[0]).toEqual(["westeurope", "EU", "✓", "✓"]);
    expect(body[1]).toEqual(["northeurope", "EU", "✓", "n/a"]);
    expect(compareLegendLine()).toContain("quota full");
    expect(compareLegendLine()).toContain("n/a not offered");
  });

  it("sorts regions where every SKU deploys to the top, then by coverage", () => {
    const onlyB1s = {
      location: loc("francecentral"),
      cells: classify(loc("francecentral"), skus, [vmSku(B1S, "f")], [usage("f", 4)]),
    };
    const both = {
      location: loc("westeurope"),
      cells: classify(loc("westeurope"), skus, [vmSku(B1S, "f"), vmSku(B2S, "f")], [usage("f", 4)]),
    };
    const none = {
      location: loc("denmarkeast"),
      cells: classify(loc("denmarkeast"), skus, [], null),
    };
    const sorted = sortCompareRowsForTable([onlyB1s, none, both]);
    expect(sorted.map((r) => r.location.name)).toEqual(["westeurope", "francecentral", "denmarkeast"]);
    expect(allDeployableRegions(sorted)).toEqual(["westeurope"]);
  });

  it("strips the Standard_ prefix for column labels", () => {
    expect(compareColumnLabel("Standard_B2ats_v2")).toBe("B2ats_v2");
    expect(compareColumnLabel("Other_Tier")).toBe("Other_Tier");
  });
});
