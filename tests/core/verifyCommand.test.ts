import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVerifyCommand } from "../../src/commands/verify.js";
import { armList } from "../../src/core/arm.js";
import { ArmHttpError } from "../../src/core/errors.js";

vi.mock("../../src/core/arm.js", () => ({
  armList: vi.fn(),
  getToken: vi.fn(),
}));

const storagePath = "/providers/Microsoft.Storage/skus?api-version=2026-09-01";
const arm = vi.mocked(armList);
const terraform = `resource "azurerm_storage_account" "primary" {
  location = "West Europe"
  account_kind = "StorageV2"
  account_tier = "Standard"
  account_replication_type = "ZRS"
}`;
const bicep = `resource archive 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  location: 'eastus'
  kind: 'StorageV2'
  sku: {
    name: 'Standard_ZRS'
  }
}`;

describe("verify Storage command", () => {
  let directory: string;
  let allowedLocations: string[] | undefined;
  let storageError: Error | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "azw-verify-storage-"));
    allowedLocations = undefined;
    storageError = undefined;
    arm.mockReset();
    arm.mockImplementation(async (path) => {
      if (path.startsWith("/locations?")) {
        return [
          { name: "westeurope", displayName: "West Europe" },
          { name: "eastus", displayName: "East US" },
        ];
      }
      if (path.startsWith("/providers?")) {
        return [
          {
            namespace: "Microsoft.Storage",
            registrationState: "Registered",
            resourceTypes: [
              { resourceType: "storageAccounts", locations: ["West Europe", "East US"] },
            ],
          },
        ];
      }
      if (path.startsWith("/providers/Microsoft.Authorization/policyAssignments?")) {
        return allowedLocations
          ? [
              {
                properties: { parameters: { listOfAllowedLocations: { value: allowedLocations } } },
              },
            ]
          : [];
      }
      if (path === storagePath) {
        if (storageError) throw storageError;
        return [
          {
            resourceType: "storageAccounts",
            kind: "StorageV2",
            name: "Standard_ZRS",
            locations: ["westeurope", "eastus"],
            restrictions: [
              { type: "Location", values: ["eastus"], reasonCode: "NotAvailableForSubscription" },
            ],
          },
        ];
      }
      if (path.startsWith("/providers/Microsoft.Compute/skus?")) {
        return [
          {
            name: "Standard_B1s",
            resourceType: "virtualMachines",
            family: "standardBSFamily",
            locations: ["westeurope"],
            capabilities: [{ name: "vCPUs", value: "1" }],
            restrictions: [],
          },
        ];
      }
      if (path.startsWith("/providers/Microsoft.Compute/locations/westeurope/usages?")) {
        return [{ name: { value: "standardBSFamily" }, currentValue: 0, limit: 10 }];
      }
      throw new Error(`Unexpected ARM request ${path}`);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true });
  });

  async function run(inputs: Record<string, string>, flags = ["-o", "json"]) {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const paths = await Promise.all(
      Object.entries(inputs).map(async ([name, source]) => {
        const path = join(directory, name);
        await writeFile(path, source);
        return path;
      }),
    );
    await createVerifyCommand().parseAsync([...paths, ...flags], { from: "user" });
    return { log, error, exit };
  }

  function catalogRequests() {
    return arm.mock.calls.filter(([path]) => path === storagePath);
  }

  it("keeps Storage SKU verdicts additive to existing VM and generic rows for both formats", async () => {
    const vm = `resource "azurerm_linux_virtual_machine" "vm" {
  location = "westeurope"
  size = "Standard_B1s"
}`;
    const { log, error, exit } = await run({
      "main.tf": `${terraform}\n${vm}`,
      "archive.bicep": bicep,
    });
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(catalogRequests()).toEqual([[storagePath, { cache: false, requireValueArray: true }]]);
    const payload = JSON.parse(log.mock.calls[0]![0]);
    expect(Object.keys(payload.storageAccounts)).toEqual([
      "seen",
      "checked",
      "skipped",
      "advertisedCount",
      "verdictCounts",
      "results",
      "skippedFindings",
    ]);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      kind: "verify",
      resourceKind: "vm",
      confidence: "deployability",
      formats: ["terraform", "bicep"],
      summary: { resources: 1, checked: 1, skipped: 0, deployableCount: 1 },
      results: [{ resourceName: "vm", checks: { verdict: "AVAILABLE" } }],
      skipped: [],
      genericResources: { seen: 2, checked: 2, supportedCount: 2, skipped: 0 },
      storageAccounts: {
        seen: 2,
        checked: 2,
        advertisedCount: 1,
        skipped: 0,
        verdictCounts: {
          STORAGE_SKU_ADVERTISED: 1,
          STORAGE_SKU_RESTRICTED: 1,
          STORAGE_SKU_NOT_LISTED: 0,
          STORAGE_SKU_UNKNOWN: 0,
          POLICY_DENIED: 0,
        },
        results: [
          {
            file: join(directory, "main.tf"),
            line: 1,
            format: "terraform",
            resourceType: "azurerm_storage_account",
            resourceName: "primary",
            accountKind: "StorageV2",
            sku: "Standard_ZRS",
            region: "westeurope",
            verdict: "STORAGE_SKU_ADVERTISED",
            confidence: "availability",
            evidence: { listed: true, restrictionReasons: [] },
            explanation: {
              code: "STORAGE_SKU_ADVERTISED",
              reason: expect.stringContaining("lists StorageV2"),
              hint: null,
            },
          },
          {
            file: join(directory, "archive.bicep"),
            line: 1,
            format: "bicep",
            resourceType: "Microsoft.Storage/storageAccounts",
            resourceName: "archive",
            accountKind: "StorageV2",
            sku: "Standard_ZRS",
            region: "eastus",
            verdict: "STORAGE_SKU_RESTRICTED",
            confidence: "availability",
            evidence: { listed: true, restrictionReasons: ["NotAvailableForSubscription"] },
            explanation: {
              code: "STORAGE_SKU_RESTRICTED",
              reason: expect.stringContaining("location restriction"),
              hint: null,
            },
          },
        ],
        skippedFindings: [],
      },
    });
  });

  it("reports incomplete Storage values without requiring SKU evidence or failing the run", async () => {
    const { log, error, exit } = await run({
      "main.tf": terraform.replace('"StorageV2"', "var.account_kind"),
      "archive.bicep": bicep.replace(/  sku: \{[^}]+\}\n/s, ""),
      "unknown.tf": terraform.replace('"West Europe"', '"unknownregion"'),
    });
    expect(exit).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(catalogRequests()).toEqual([]);
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
      genericResources: { seen: 3, checked: 2, supportedCount: 2, skipped: 1 },
      storageAccounts: {
        seen: 3,
        checked: 0,
        skipped: 3,
        results: [],
        skippedFindings: [
          { resourceName: "primary", reason: "dynamic-kind", detail: "var.account_kind" },
          { resourceName: "archive", reason: "dynamic-sku" },
          { resourceName: "primary", reason: "unknown-region", detail: "unknownregion" },
        ],
      },
    });
  });

  it("reuses the allowed-location policy verdict without loading the SKU catalog", async () => {
    allowedLocations = ["eastus"];
    const { log, exit } = await run({ "main.tf": terraform });
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(catalogRequests()).toEqual([]);
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
      policy: { checked: true, restricted: true, allowedLocations: ["eastus"] },
      genericResources: { verdictCounts: { POLICY_DENIED: 1 } },
      storageAccounts: {
        verdictCounts: { POLICY_DENIED: 1 },
        results: [{ verdict: "POLICY_DENIED", evidence: { listed: null, restrictionReasons: [] } }],
      },
    });
  });

  it("prints Storage availability and skips in table output and honors --no-policy", async () => {
    allowedLocations = ["eastus"];
    const { log, exit } = await run(
      {
        "main.tf": terraform,
        "archive.bicep": bicep.replace("'Standard_ZRS'", "skuName"),
      },
      ["--no-policy"],
    );
    const output = log.mock.calls.map(([message]) => message).join("\n");
    expect(exit).not.toHaveBeenCalled();
    expect(output).toContain("All 2 checked generic resources advertised");
    expect(output).toContain("Storage account SKUs (availability)");
    expect(output).toContain("STORAGE_SKU_ADVERTISED");
    expect(output).toContain("Policy: unchecked");
    expect(output).toContain("skuName (dynamic-sku)");
    expect(catalogRequests()).toHaveLength(1);
    expect(arm.mock.calls.some(([path]) => path.includes("policyAssignments"))).toBe(false);
  });

  it("uses the existing error envelope for a failed Storage catalog request", async () => {
    storageError = new ArmHttpError(403, "Forbidden", storagePath, null, null, "");
    const { log, error, exit } = await run({ "main.tf": terraform });
    expect(log).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(JSON.parse(error.mock.calls[0]![0])).toMatchObject({
      status: "error",
      code: "ARM_HTTP_ERROR",
      details: { statusCode: 403, endpoint: storagePath },
    });
  });
});
