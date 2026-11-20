import { beforeEach, describe, expect, it, vi } from "vitest";
import { armList } from "../../src/core/arm.js";
import { buildPolicyCheck } from "../../src/core/policy.js";
import { classifyStorageSku, listStorageSkus, type StorageSku } from "../../src/core/storage.js";
import type { AzLocation } from "../../src/core/types.js";

vi.mock("../../src/core/arm.js", () => ({
  armList: vi.fn(),
}));

const westEurope: AzLocation = { name: "westeurope", displayName: "West Europe" };
const storageSku: StorageSku = {
  resourceType: "storageAccounts",
  kind: "StorageV2",
  name: "Standard_ZRS",
  locations: ["West Europe"],
};

describe("classifyStorageSku", () => {
  it.each(["westeurope", " West Europe "])(
    "recognizes advertised locations in %s form",
    (location) => {
      const result = classifyStorageSku(
        [{ ...storageSku, locations: [location] }],
        "storagev2",
        "standard_zrs",
        westEurope,
      );

      expect(result).toMatchObject({
        verdict: "STORAGE_SKU_ADVERTISED",
        listed: true,
        restrictionReasons: [],
      });
    },
  );

  it("uses locationInfo when locations is absent", () => {
    const row = {
      ...storageSku,
      locations: undefined,
      locationInfo: [{ location: "West Europe" }],
    };

    expect(classifyStorageSku([row], "StorageV2", "Standard_ZRS", westEurope)).toMatchObject({
      verdict: "STORAGE_SKU_ADVERTISED",
      listed: true,
    });
  });

  it("reports unknown when a matching SKU has no location evidence", () => {
    const row = { ...storageSku, locations: undefined };

    expect(classifyStorageSku([row], "StorageV2", "Standard_ZRS", westEurope)).toMatchObject({
      verdict: "STORAGE_SKU_UNKNOWN",
    });
  });

  it.each([
    { ...storageSku, locations: ["North Europe"] },
    { ...storageSku, name: "Standard_LRS" },
    { ...storageSku, kind: "FileStorage" },
    { ...storageSku, resourceType: "storageAccounts/fileServices" },
  ])("reports no matching listing when the catalog contains %o", (row) => {
    expect(classifyStorageSku([row], "StorageV2", "Standard_ZRS", westEurope)).toMatchObject({
      verdict: "STORAGE_SKU_NOT_LISTED",
      listed: false,
      restrictionReasons: [],
    });
  });

  it("prefers a matching location restriction across duplicate rows and deduplicates reason codes", () => {
    const restriction = {
      type: "Location",
      values: ["westeurope"],
      reasonCode: "NotAvailableForSubscription",
    };
    const catalog = [
      storageSku,
      { ...storageSku, locations: [], restrictions: [restriction, restriction] },
    ];

    expect(classifyStorageSku(catalog, "StorageV2", "Standard_ZRS", westEurope)).toMatchObject({
      verdict: "STORAGE_SKU_RESTRICTED",
      listed: true,
      restrictionReasons: ["NotAvailableForSubscription"],
    });
  });

  it("ignores restrictions scoped to another region or a different SKU", () => {
    const catalog = [
      {
        ...storageSku,
        restrictions: [{ type: "Location", values: ["North Europe"] }],
      },
      {
        ...storageSku,
        name: "Standard_LRS",
        restrictions: [{ type: "Location", values: ["West Europe"] }],
      },
    ];

    expect(classifyStorageSku(catalog, "StorageV2", "Standard_ZRS", westEurope)).toMatchObject({
      verdict: "STORAGE_SKU_ADVERTISED",
      listed: true,
      restrictionReasons: [],
    });
  });

  it("retains explicit location restrictions even when the SKU is not listed in the region", () => {
    const row = {
      ...storageSku,
      locations: ["North Europe"],
      restrictions: [{ type: "Location", values: ["West Europe"] }],
    };

    expect(classifyStorageSku([row], "StorageV2", "Standard_ZRS", westEurope)).toMatchObject({
      verdict: "STORAGE_SKU_RESTRICTED",
      listed: false,
      restrictionReasons: [],
    });
  });

  it.each([{ values: undefined }, { values: [] }])(
    "reports unknown for a location restriction with values $values",
    ({ values }) => {
      const row = { ...storageSku, restrictions: [{ type: "Location", values }] };

      expect(classifyStorageSku([row], "StorageV2", "Standard_ZRS", westEurope)).toMatchObject({
        verdict: "STORAGE_SKU_UNKNOWN",
        listed: true,
        restrictionReasons: [],
      });
    },
  );

  it("uses the Azure Policy denial ahead of SKU evidence", () => {
    const policy = buildPolicyCheck({
      checked: true,
      restricted: true,
      allowedLocations: ["northeurope"],
      assignments: [{ name: "allowed-regions", displayName: "Allowed locations" }],
      error: null,
    });

    expect(
      classifyStorageSku([storageSku], "StorageV2", "Standard_ZRS", westEurope, policy),
    ).toMatchObject({
      verdict: "POLICY_DENIED",
      listed: null,
      restrictionReasons: [],
      reason: expect.stringContaining("allowed-regions"),
    });
  });
});

describe("listStorageSkus", () => {
  const mockArmList = vi.mocked(armList);

  beforeEach(() => {
    mockArmList.mockReset();
  });

  it("requires ARM list responses and bypasses the cache", async () => {
    mockArmList.mockResolvedValue([storageSku]);

    await expect(listStorageSkus()).resolves.toEqual([storageSku]);
    expect(mockArmList).toHaveBeenCalledWith(
      "/providers/Microsoft.Storage/skus?api-version=2026-09-01",
      { cache: false, requireValueArray: true },
    );
  });

  it("rejects a catalog with no account SKU rows", async () => {
    mockArmList.mockResolvedValue([
      { ...storageSku, resourceType: "storageAccounts/fileServices" },
    ]);

    await expect(listStorageSkus()).rejects.toThrow("no account SKU entries");
  });

  it.each([
    { field: "locations", row: { ...storageSku, locations: "West Europe" } },
    {
      field: "restrictions",
      row: { ...storageSku, restrictions: [{ type: "Location", values: [null] }] },
    },
  ])("rejects malformed $field even with another well-formed account row", async ({ row }) => {
    mockArmList.mockResolvedValue([storageSku, row]);

    await expect(listStorageSkus()).rejects.toThrow(/storage/i);
  });

  it("preserves ARM request failures", async () => {
    const failure = new Error("ARM request failed");
    mockArmList.mockRejectedValue(failure);

    await expect(listStorageSkus()).rejects.toBe(failure);
  });
});
