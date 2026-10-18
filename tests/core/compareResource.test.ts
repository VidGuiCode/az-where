import { describe, expect, it } from "vitest";
import {
  allSupportedRegions,
  buildCompareResourceTable,
  classifyCompareResources,
  compareResourceCellLabel,
  compareResourceColumnLabel,
  compareResourceLegendLine,
  MAX_COMPARE_TARGETS,
  parseResourceTargetList,
  sortCompareResourceRowsForTable,
} from "../../src/core/compareResource.js";
import { ValidationError } from "../../src/core/errors.js";
import { buildPolicyCheck } from "../../src/core/policy.js";
import type { AzLocation, AzProvider } from "../../src/core/types.js";

const loc = (name: string, geographyGroup = "Europe"): AzLocation => ({
  name,
  displayName: name,
  metadata: { geographyGroup, physicalLocation: name },
});

const providers: AzProvider[] = [
  {
    namespace: "Microsoft.Storage",
    registrationState: "Registered",
    resourceTypes: [{ resourceType: "storageAccounts", locations: ["West Europe"] }],
  },
  {
    namespace: "Microsoft.KeyVault",
    registrationState: "Registered",
    resourceTypes: [{ resourceType: "vaults", locations: ["West Europe", "North Europe"] }],
  },
];

const restrictingPolicy = (allowed: string[]) =>
  buildPolicyCheck({
    checked: true,
    restricted: true,
    allowedLocations: allowed,
    assignments: [{ name: "allowed-locations", displayName: "Allowed locations" }],
    error: null,
  });

describe("parseResourceTargetList", () => {
  it("keeps aliases and raw Azure types, trimmed, in request order", () => {
    expect(parseResourceTargetList(" storage-account , Microsoft.KeyVault/vaults")).toEqual([
      "storage-account",
      "Microsoft.KeyVault/vaults",
    ]);
  });

  it("deduplicates case-insensitively across alias and raw forms, keeping the first", () => {
    expect(
      parseResourceTargetList(
        "storage-account,Microsoft.Storage/storageAccounts,STORAGE-ACCOUNT, microsoft.storage/storageaccounts",
      ),
    ).toEqual(["storage-account"]);
    expect(parseResourceTargetList("aks,AKS")).toEqual(["aks"]);
  });

  it("rejects an entirely empty list", () => {
    expect(() => parseResourceTargetList("")).toThrow(ValidationError);
    expect(() => parseResourceTargetList(" , ")).toThrow(/Missing resource list/);
  });

  it("rejects an empty entry between commas", () => {
    expect(() => parseResourceTargetList("storage-account,,aks")).toThrow(/empty entry/);
    expect(() => parseResourceTargetList(",aks")).toThrow(/empty entry/);
  });

  it("rejects a token that is neither an alias nor a raw type", () => {
    expect(() => parseResourceTargetList("storage-account,made-up-resource")).toThrow(
      /Unknown resource alias or invalid Azure resource type 'made-up-resource'/,
    );
  });

  it("caps the list length to keep tables readable", () => {
    const many = Array.from(
      { length: MAX_COMPARE_TARGETS + 1 },
      (_, i) => `Microsoft.Nonsense/type${i}`,
    ).join(",");
    expect(() => parseResourceTargetList(many)).toThrow(RegExp(`${MAX_COMPARE_TARGETS}`));
  });
});

describe("classifyCompareResources", () => {
  const locations = [loc("northeurope"), loc("westeurope"), loc("eastus", "US")];
  const targets = ["storage-account", "key-vault"];

  it("builds per-target summaries in request order on a sorted shared region axis", () => {
    const { regionRows, summaries } = classifyCompareResources({
      targets,
      locations,
      providers,
    });
    // Region axis sorts by geography group then name, independent of input order.
    expect(regionRows.map((row) => row.location.name)).toEqual([
      "northeurope",
      "westeurope",
      "eastus",
    ]);
    expect(summaries.map((s) => s.target)).toEqual(targets);

    const storage = summaries[0]!;
    expect(storage.resolved.resourceType).toBe("Microsoft.Storage/storageAccounts");
    expect(storage.regions.map((r) => r.region)).toEqual(["northeurope", "westeurope", "eastus"]);
    expect(storage.supportedRegions).toEqual(["westeurope"]);
    expect(storage.supportedCount).toBe(1);
    expect(storage.verdictCounts).toEqual({
      RESOURCE_SUPPORTED: 1,
      RESOURCE_NOT_SUPPORTED: 2,
      POLICY_DENIED: 0,
    });

    const vaults = summaries[1]!;
    expect(vaults.supportedRegions).toEqual(["northeurope", "westeurope"]);
    expect(vaults.verdictCounts.RESOURCE_SUPPORTED).toBe(2);
  });

  it("aligns matrix cells with the region axis and keeps the target on each cell", () => {
    const { regionRows, summaries } = classifyCompareResources({
      targets,
      locations,
      providers,
    });
    for (const row of regionRows) {
      expect(row.cells.map((cell) => cell.target)).toEqual(targets);
      expect(row.cells.every((cell) => cell.region === row.location.name)).toBe(true);
    }
    // Cells are the same rows the summaries expose, in the same order.
    const west = regionRows.find((r) => r.location.name === "westeurope")!;
    expect(west.cells[0]!.verdict).toBe(summaries[0]!.regions[1]!.verdict);
    expect(west.cells[0]!.confidence).toBe("availability");
  });

  it("denies policy-blocked regions for every target before catalog classification", () => {
    const { summaries } = classifyCompareResources({
      targets,
      locations,
      providers,
      policy: restrictingPolicy(["westeurope"]),
    });
    for (const summary of summaries) {
      const west = summary.regions.find((r) => r.region === "westeurope")!;
      expect(west.verdict).toBe("RESOURCE_SUPPORTED");
      const north = summary.regions.find((r) => r.region === "northeurope")!;
      expect(north.verdict).toBe("POLICY_DENIED");
      expect(north.policyAllowed).toBe(false);
      expect(north.policyReason).toContain("northeurope");
      expect(summary.verdictCounts.POLICY_DENIED).toBe(2); // northeurope + eastus
    }
  });

  it("reports unknown providers as RESOURCE_NOT_SUPPORTED with the provider-not-found cause", () => {
    const { summaries } = classifyCompareResources({
      targets: ["Microsoft.Nonsense/doesNotExist"],
      locations: [loc("westeurope")],
      providers,
    });
    const row = summaries[0]!.regions[0]!;
    expect(row.verdict).toBe("RESOURCE_NOT_SUPPORTED");
    expect(row.notSupportedCause).toBe("provider-not-found");
    expect(row.providerRegistered).toBeNull();
  });
});

describe("table rendering", () => {
  const locations = [loc("westeurope"), loc("northeurope"), loc("eastus", "US")];
  const targets = ["storage-account", "Microsoft.KeyVault/vaults"];

  function rows(policy?: ReturnType<typeof restrictingPolicy>) {
    return classifyCompareResources({ targets, locations, providers, policy }).regionRows;
  }

  it("uses aliases for alias columns and the type path for raw types", () => {
    expect(compareResourceColumnLabel("storage-account")).toBe("storage-account");
    expect(compareResourceColumnLabel("Microsoft.Web/sites")).toBe("sites");
    expect(compareResourceColumnLabel("aks")).toBe("aks");
  });

  it("builds REGION/GEO headers plus one column per target with verdict glyphs", () => {
    const { headers, body } = buildCompareResourceTable(rows(), targets);
    expect(headers).toEqual(["REGION", "GEO", "storage-account", "vaults"]);
    // northeurope: storage not advertised, vaults supported; westeurope: both.
    expect(body.map((r) => [r[0], ...r.slice(2)])).toEqual([
      ["northeurope", "n/a", "✓"],
      ["westeurope", "✓", "✓"],
      ["eastus", "n/a", "n/a"],
    ]);
    expect(compareResourceLegendLine()).toContain("✓ supported");
    expect(compareResourceLegendLine()).toContain("n/a not advertised");
    expect(compareResourceLegendLine()).toContain("not deployability");
  });

  it("renders policy-denied cells with the policy glyph", () => {
    const policyRows = rows(restrictingPolicy(["westeurope"]));
    const { body } = buildCompareResourceTable(policyRows, targets);
    const north = body.find((r) => r[0] === "northeurope")!;
    expect(north.slice(2)).toEqual(["policy", "policy"]);
    expect(compareResourceCellLabel("POLICY_DENIED")).toBe("policy");
  });

  it("sorts regions where every target is supported to the top, then by coverage", () => {
    const sorted = sortCompareResourceRowsForTable(rows());
    expect(sorted.map((r) => r.location.name)).toEqual(["westeurope", "northeurope", "eastus"]);
    expect(allSupportedRegions(sorted)).toEqual(["westeurope"]);
  });
});
