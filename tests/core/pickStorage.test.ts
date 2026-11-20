import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPickCommand } from "../../src/commands/pick.js";
import { armList } from "../../src/core/arm.js";

vi.mock("../../src/core/arm.js", () => ({ armList: vi.fn() }));

const location = (name: string, geographyGroup = "Europe") => ({
  name,
  displayName: name.toUpperCase(),
  metadata: { geographyGroup },
});

const catalogPath = "/providers/Microsoft.Storage/skus?api-version=2026-09-01";
const arm = vi.mocked(armList);
const target = ["storage", "--kind", "StorageV2", "--sku", "Standard_ZRS", "--eu"];

describe("pick storage", () => {
  let allowed: string[];
  let policyError: boolean;
  let skuLocations: string[] | undefined;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    allowed = ["aaoutofscope", "abrestricted", "bfirst", "zlast"];
    policyError = false;
    skuLocations = ["aaoutofscope", "aadenied", "abrestricted", "bfirst", "zlast"];
    arm.mockReset().mockImplementation(async (path) => {
      if (path.startsWith("/locations?")) {
        return [
          location("zlast"),
          location("aaoutofscope", "US"),
          location("bfirst"),
          location("aadenied"),
          location("abrestricted"),
        ];
      }
      if (path.includes("policyAssignments")) {
        if (policyError) throw new Error("Policy is unavailable");
        return [{ properties: { parameters: { listOfAllowedLocations: { value: allowed } } } }];
      }
      if (path === catalogPath) {
        return [{
          resourceType: "storageAccounts",
          kind: "StorageV2",
          name: "Standard_ZRS",
          locations: skuLocations,
          restrictions: [{ type: "Location", values: ["abrestricted"] }],
        }];
      }
      throw new Error(`Unexpected ARM path ${path}`);
    });
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  async function pick(...args: string[]) {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const diagnostic = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const program = new Command().addCommand(createPickCommand());
    await program.parseAsync(["pick", ...target, ...args], { from: "user" });
    return { stdout, diagnostic, error, exit };
  }

  it("selects by ARM name after geography, policy and restrictions, with one catalog read", async () => {
    const { stdout, exit } = await pick("-o", "json");
    expect(exit).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({
      schemaVersion: 1,
      kind: "pick",
      resourceKind: "storage",
      accountKind: "StorageV2",
      sku: "Standard_ZRS",
      geography: "Europe",
      confidence: "availability",
      policy: { checked: true },
      picked: {
        region: "bfirst",
        displayName: "BFIRST",
        geographyGroup: "Europe",
        verdict: "STORAGE_SKU_ADVERTISED",
        evidence: { listed: true, restrictionReasons: [] },
        explanation: { code: "STORAGE_SKU_ADVERTISED", reason: expect.any(String), hint: null },
      },
    });
    expect(arm.mock.calls.filter(([path]) => path === catalogPath)).toHaveLength(1);
  });

  it("prints one region when the caller explicitly disables policy", async () => {
    const { stdout } = await pick("--no-policy", "-o", "value");
    expect(stdout.mock.calls).toEqual([["aadenied"]]);
    expect(arm.mock.calls.some(([path]) => path.includes("policyAssignments"))).toBe(false);
  });

  it("leaves scalar stdout empty when policy denies every region in scope", async () => {
    allowed = ["aaoutofscope"];
    const { stdout, diagnostic } = await pick("-o", "value");
    expect(stdout).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("No qualifying region"));
    expect(process.exitCode).toBe(1);
    expect(arm.mock.calls.some(([path]) => path === catalogPath)).toBe(false);
  });

  it.each([[[]], [undefined]])("returns null on absent or incomplete evidence (%s)", async (locations) => {
    skuLocations = locations;
    const { stdout } = await pick("-o", "compact");
    expect(JSON.parse(stdout.mock.calls[0][0]).picked).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  it("fails before the catalog read when policy could not be checked", async () => {
    policyError = true;
    const { stdout, error, exit } = await pick("-o", "json");
    expect(stdout).not.toHaveBeenCalled();
    expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({ code: "PolicyReadError" });
    expect(exit).toHaveBeenCalledWith(1);
    expect(arm.mock.calls.some(([path]) => path === catalogPath)).toBe(false);
  });
});
