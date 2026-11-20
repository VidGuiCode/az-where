import { describe, expect, it, vi } from "vitest";
import { armList } from "../../src/core/arm.js";
import { compareStorageTargets, parseStorageTargets } from "../../src/core/compareStorage.js";
import { buildPolicyCheck } from "../../src/core/policy.js";

vi.mock("../../src/core/arm.js", () => ({ armList: vi.fn() }));

describe("parseStorageTargets", () => {
  it("keeps the first spelling and order of distinct kind and SKU pairs", () => {
    expect(
      parseStorageTargets(
        "StorageV2/Standard_ZRS, storagev2/standard_zrs, FileStorage/Premium_ZRS",
      ),
    ).toEqual([
      { accountKind: "StorageV2", sku: "Standard_ZRS" },
      { accountKind: "FileStorage", sku: "Premium_ZRS" },
    ]);
  });

  it.each(["", "StorageV2", "StorageV2/Standard_ZRS,", "StorageV2/Standard_ZRS/extra"])(
    "rejects an incomplete or malformed list %s",
    (value) => {
      expect(() => parseStorageTargets(value)).toThrow("kind/SKU pairs");
    },
  );

  it("caps the number of distinct columns", () => {
    const list = Array.from({ length: 31 }, (_, index) => `StorageV2/Standard_${index}`).join(",");
    expect(() => parseStorageTargets(list)).toThrow("up to 30 distinct Storage configurations");
  });
});

describe("compareStorageTargets", () => {
  it("loads one catalog and aligns evidence for each requested pair over the same region axis", async () => {
    const mockArmList = vi.mocked(armList);
    mockArmList.mockResolvedValue([
      {
        resourceType: "storageAccounts",
        kind: "StorageV2",
        name: "Standard_LRS",
        locations: ["West Europe"],
      },
      { resourceType: "storageAccounts", kind: "FileStorage", name: "Premium_ZRS" },
    ]);
    const locations = [
      { name: "westeurope", displayName: "West Europe" },
      { name: "northeurope", displayName: "North Europe" },
    ];
    const policy = buildPolicyCheck({
      checked: true,
      restricted: true,
      allowedLocations: ["westeurope"],
      assignments: [],
      error: null,
    });
    const targets = parseStorageTargets("FileStorage/Premium_ZRS,StorageV2/Standard_LRS");
    const results = await compareStorageTargets(targets, locations, policy);

    expect(mockArmList).toHaveBeenCalledTimes(1);
    expect(results).toMatchObject([
      {
        ...targets[0],
        regions: [
          { region: "westeurope", verdict: "STORAGE_SKU_UNKNOWN", listed: null },
          { region: "northeurope", verdict: "POLICY_DENIED", listed: null },
        ],
        advertisedRegions: [],
        advertisedCount: 0,
        verdictCounts: { STORAGE_SKU_UNKNOWN: 1, POLICY_DENIED: 1 },
      },
      {
        ...targets[1],
        regions: [
          { region: "westeurope", verdict: "STORAGE_SKU_ADVERTISED", listed: true },
          { region: "northeurope", verdict: "POLICY_DENIED", listed: null },
        ],
        advertisedRegions: ["westeurope"],
        advertisedCount: 1,
        verdictCounts: { STORAGE_SKU_ADVERTISED: 1, POLICY_DENIED: 1 },
      },
    ]);
  });
});
