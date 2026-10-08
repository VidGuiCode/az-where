import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Live smoke tests — they hit real Azure ARM through the logged-in `az` CLI,
 * so they are OFF by default and only run when AZW_LIVE=1 is set with an
 * authenticated `az` session. This satisfies the 0.4.2 roadmap item:
 * "Live-smoke canonical generic resource checks against ARM provider metadata
 * and policy-restricted subscriptions."
 *
 * They assert the JSON *contract* (shape + verdict vocabulary), never exact
 * regions or counts, so they stay stable as Azure's catalog changes.
 *
 * Run with:  AZW_LIVE=1 npx vitest run tests/live
 */

const LIVE = Boolean(process.env.AZW_LIVE);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../../dist/cli.js");

const RESOURCE_VERDICTS = new Set(["RESOURCE_SUPPORTED", "RESOURCE_NOT_SUPPORTED", "POLICY_DENIED"]);
const VM_VERDICTS = new Set([
  "AVAILABLE",
  "FULL",
  "SKU_NOT_OFFERED",
  "BLOCKED_FOR_SUB",
  "POLICY_DENIED",
  "QUOTA_UNKNOWN",
]);

function runJson(args: string[]) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1", CI: "1" },
  });
  return res;
}

describe.runIf(LIVE)("live ARM resource availability", () => {
  it("availability resource storage-account --eu -o json returns the documented shape", () => {
    const res = runJson(["availability", "resource", "storage-account", "--eu", "-o", "json"]);
    // Exit 0 (some region supports it) or 1 (none) are both valid outcomes;
    // anything else (2/3/127) means auth/usage/install failure.
    expect([0, 1]).toContain(res.status);

    const payload = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.kind).toBe("availability");
    expect(payload.resourceKind).toBe("resource");
    expect(payload.confidence).toBe("availability");
    expect(typeof payload.scannedAt).toBe("string");
    expect(Array.isArray(payload.regions)).toBe(true);

    const regions = payload.regions as Array<Record<string, unknown>>;
    expect(regions.length).toBeGreaterThan(0);
    for (const row of regions) {
      expect(typeof row.region).toBe("string");
      expect(RESOURCE_VERDICTS.has(String(row.verdict))).toBe(true);
      expect(row.confidence).toBe("availability");
    }
  });

  it("accepts a raw Azure resource type against a single region", () => {
    const res = runJson([
      "availability",
      "resource",
      "Microsoft.Storage/storageAccounts",
      "--region",
      "westeurope",
      "-o",
      "json",
    ]);
    expect([0, 1]).toContain(res.status);

    const payload = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(payload.resourceKind).toBe("resource");
    const regions = payload.regions as Array<Record<string, unknown>>;
    expect(regions).toHaveLength(1);
    expect(regions[0].region).toBe("westeurope");
  });

  it("rejects a syntactically invalid resource type with a JSON ValidationError envelope (exit 3)", () => {
    const res = runJson([
      "availability",
      "resource",
      "made-up-resource",
      "--region",
      "westeurope",
      "-o",
      "json",
    ]);
    // No slash and no matching alias cannot be a raw resource type at all.
    expect(res.status).toBe(3);
    const err = JSON.parse(res.stderr) as Record<string, unknown>;
    expect(err.status).toBe("error");
    expect(err.code).toBe("ValidationError");
  });

  it("reports a nonsense provider namespace as provider-not-supported with cause evidence", () => {
    const res = runJson([
      "availability",
      "resource",
      "Microsoft.Nonsense/doesNotExist",
      "--region",
      "westeurope",
      "-o",
      "json",
    ]);
    // A syntactically valid but nonexistent type is a scan outcome (exit 1),
    // not a validation error: every row is RESOURCE_NOT_SUPPORTED with the
    // provider-not-found cause and an explanation (since 0.4.6).
    expect(res.status).toBe(1);

    const payload = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(payload.resourceKind).toBe("resource");
    const regions = payload.regions as Array<Record<string, unknown>>;
    expect(regions).toHaveLength(1);
    // Policy-restricted subscriptions deny the region before the catalog
    // classification runs; both outcomes are valid, never exit 3.
    expect(["RESOURCE_NOT_SUPPORTED", "POLICY_DENIED"]).toContain(regions[0].verdict);
    if (regions[0].verdict === "RESOURCE_NOT_SUPPORTED") {
      expect(regions[0].notSupportedCause).toBe("provider-not-found");
      expect(regions[0].providerRegistered).toBeNull();
    }
  });
});

describe.runIf(LIVE)("live compare vm", () => {
  it("compare vm across EU returns the documented matrix contract", () => {
    const res = runJson([
      "compare",
      "vm",
      "Standard_B1s,Standard_B2s,Standard_D2s_v5",
      "--eu",
      "-o",
      "json",
    ]);
    // Exit 0 (something deploys) or 1 (nothing deploys for any SKU) are both
    // valid outcomes; anything else means auth/usage/install failure.
    expect([0, 1]).toContain(res.status);

    const payload = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.kind).toBe("compare");
    expect(payload.resourceKind).toBe("vm");
    expect(payload.confidence).toBe("deployability");
    expect(payload.skus).toEqual(["Standard_B1s", "Standard_B2s", "Standard_D2s_v5"]);

    const regions = payload.regions as string[];
    expect(Array.isArray(regions)).toBe(true);
    expect(regions.length).toBeGreaterThan(0);

    const results = payload.results as Array<Record<string, unknown>>;
    expect(results.map((r) => r.sku)).toEqual(payload.skus);
    for (const result of results) {
      const cells = result.regions as Array<Record<string, unknown>>;
      // Every per-SKU row aligns with the shared region axis.
      expect(cells.map((cell) => cell.region)).toEqual(regions);
      for (const cell of cells) {
        expect(VM_VERDICTS.has(String(cell.verdict))).toBe(true);
      }
      const deployable = result.deployableRegions as string[];
      expect((result.deployableCount as number)).toBe(deployable.length);
      for (const name of deployable) expect(regions).toContain(name);
    }

    // Exit code contract: 0 iff at least one SKU deploys somewhere.
    const anyDeployable = results.some((r) => (r.deployableCount as number) > 0);
    expect(res.status).toBe(anyDeployable ? 0 : 1);
  });

  it("compare vm in a single region collapses the matrix to one row", () => {
    const res = runJson(["compare", "vm", "Standard_B1s,Standard_B2s", "--region", "westeurope", "-o", "json"]);
    expect([0, 1]).toContain(res.status);

    const payload = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(payload.region).toBe("westeurope");
    expect(payload.regions).toEqual(["westeurope"]);
    const results = payload.results as Array<Record<string, unknown>>;
    expect(results.every((r) => (r.regions as unknown[]).length === 1)).toBe(true);
  });
});

describe.runIf(LIVE)("live check contracts (0.4.6)", () => {
  it("check vm -o json returns the documented payload with an explanation", () => {
    const res = runJson(["check", "vm", "B1s", "--region", "westeurope", "-o", "json"]);
    expect([0, 1]).toContain(res.status);

    const payload = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.kind).toBe("check");
    expect(payload.resourceKind).toBe("vm");
    expect(payload.target).toBe("Standard_B1s");
    expect(payload.region).toBe("westeurope");
    expect(payload.confidence).toBe("deployability");
    expect(VM_VERDICTS.has(String(payload.verdict))).toBe(true);

    // `checks` is a single row object, never an array.
    const checks = payload.checks as Record<string, unknown>;
    expect(Array.isArray(checks)).toBe(false);
    expect(checks.region).toBe("westeurope");
    expect(VM_VERDICTS.has(String(checks.verdict))).toBe(true);

    // Evidence fields (since 0.4.6) are always present, null when unused.
    expect(["number", "object"]).toContain(typeof checks.requiredVcpus);
    expect(["object", "boolean"]).toContain(typeof checks.skuRestrictions);
    expect(["object", "boolean"]).toContain(typeof checks.familySizesOffered);
    expect(["string", "object"]).toContain(typeof checks.errorDetail);

    // Explanation mirrors the verdict.
    const explanation = payload.explanation as Record<string, unknown>;
    expect(explanation.code).toBe(payload.verdict);
    expect(typeof explanation.reason).toBe("string");
    expect(explanation.reason.length).toBeGreaterThan(0);
    expect(["string", "object"]).toContain(typeof explanation.hint);
  });

  it("check resource -o json returns the documented payload with cause evidence", () => {
    const res = runJson(["check", "resource", "storage-account", "--region", "westeurope", "-o", "json"]);
    expect([0, 1]).toContain(res.status);

    const payload = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.kind).toBe("check");
    expect(payload.resourceKind).toBe("resource");
    expect(payload.confidence).toBe("availability");
    expect(RESOURCE_VERDICTS.has(String(payload.verdict))).toBe(true);

    const checks = payload.checks as Record<string, unknown>;
    expect(Array.isArray(checks)).toBe(false);
    expect(["boolean", "object"]).toContain(typeof checks.providerRegistered);
    expect(["number", "object"]).toContain(typeof checks.typeLocationCount);
    if (checks.verdict === "RESOURCE_NOT_SUPPORTED") {
      expect(["provider-not-found", "type-not-found", "region-not-advertised"]).toContain(
        checks.notSupportedCause,
      );
    } else {
      expect(checks.notSupportedCause).toBeNull();
    }

    const explanation = payload.explanation as Record<string, unknown>;
    expect(explanation.code).toBe(payload.verdict);
    expect(typeof explanation.reason).toBe("string");
  });

  it("availability vm single region -o json carries evidence fields on every row", () => {
    const res = runJson(["availability", "vm", "B1s", "--region", "westeurope", "-o", "json"]);
    expect([0, 1]).toContain(res.status);

    const payload = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(payload.kind).toBe("availability");
    expect(payload.resourceKind).toBe("vm");
    expect(payload.sku).toBe("Standard_B1s");
    expect(typeof payload.scannedAt).toBe("string");

    const regions = payload.regions as Array<Record<string, unknown>>;
    expect(regions).toHaveLength(1);
    const row = regions[0];
    expect(VM_VERDICTS.has(String(row.verdict))).toBe(true);
    expect("requiredVcpus" in row).toBe(true);
    expect("skuRestrictions" in row).toBe(true);
    expect("familySizesOffered" in row).toBe(true);
    expect("errorDetail" in row).toBe(true);
  });

  it("check vm human table prints a Reason line under the verdict", () => {
    const res = runJson(["check", "vm", "B1s", "--region", "westeurope"]);
    expect([0, 1]).toContain(res.status);
    expect(res.stdout).toContain("VERDICT");
    expect(res.stdout).toContain("Reason: ");
  });
});

describe.runIf(LIVE)("live doctor", () => {
  it("doctor -o json reports the documented checklist shape", () => {
    const res = runJson(["doctor", "-o", "json"]);
    // Exit 0 (healthy environment) or 4 (a prerequisite failed) are both
    // valid doctor outcomes; anything else is an unexpected crash.
    expect([0, 4]).toContain(res.status);

    const payload = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.kind).toBe("doctor");
    expect(typeof payload.ok).toBe("boolean");
    expect(typeof payload.passed).toBe("number");
    expect(typeof payload.failed).toBe("number");
    expect(typeof payload.skipped).toBe("number");

    const checks = payload.checks as Array<Record<string, unknown>>;
    expect(checks.map((c) => c.id)).toEqual([
      "az-installed",
      "az-version",
      "logged-in",
      "default-subscription",
      "arm-token",
    ]);
    for (const c of checks) {
      expect(["pass", "fail", "skip"]).toContain(c.status);
      expect(typeof c.label).toBe("string");
    }
    expect(payload.ok).toBe(payload.failed === 0);
    // The bearer token must never appear in doctor output.
    expect(res.stdout).not.toMatch(/accessToken/i);
  });
});

describe.runIf(LIVE)("live verify", () => {
  it("verify -o json returns the documented shape with checked pairs and skips", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "azw-verify-"));
    try {
      const tfFile = path.join(dir, "main.tf");
      writeFileSync(
        tfFile,
        [
          'resource "azurerm_linux_virtual_machine" "vm" {',
          '  name     = "vm"',
          '  location = "westeurope"',
          '  size     = "Standard_B1s"',
          "}",
          "",
          'resource "azurerm_windows_virtual_machine" "vm_win" {',
          '  name     = "vm-win"',
          "  location = var.location",
          '  size     = "Standard_D2s_v5"',
          "}",
          "",
        ].join("\n"),
      );

      const res = runJson(["verify", tfFile, "-o", "json"]);
      // Exit 0 (everything deploys) or 1 (a checked pair is blocked) are both
      // valid outcomes; anything else means auth/usage/install failure.
      expect([0, 1]).toContain(res.status);

      const payload = JSON.parse(res.stdout) as Record<string, unknown>;
      expect(payload.schemaVersion).toBe(1);
      expect(payload.kind).toBe("verify");
      expect(payload.resourceKind).toBe("vm");
      expect(payload.confidence).toBe("deployability");
      expect(payload.files).toEqual([tfFile]);
      expect(payload.formats).toEqual(["terraform"]);

      const results = payload.results as Array<Record<string, unknown>>;
      expect(results).toHaveLength(1);
      const row = results[0]!;
      expect(row.resourceName).toBe("vm");
      expect(row.sku).toBe("Standard_B1s");
      expect(row.region).toBe("westeurope");
      expect(VM_VERDICTS.has(row.checks?.verdict as string)).toBe(true);
      expect(row.explanation?.code).toBe((row.checks as Record<string, unknown>).verdict);

      const summary = payload.summary as Record<string, number>;
      expect(summary.resources).toBe(2);
      expect(summary.checked).toBe(1);
      expect(summary.skipped).toBe(1);

      const skipped = payload.skipped as Array<Record<string, unknown>>;
      expect(skipped[0]?.resourceName).toBe("vm_win");
      expect(skipped[0]?.reason).toBe("dynamic-location");

      // Exit code matches the blocked-pair rule, not the skip.
      expect(res.status).toBe(summary.deployableCount === 0 ? 1 : 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verify parses Bicep files against live ARM", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "azw-verify-"));
    try {
      const bicepFile = path.join(dir, "main.bicep");
      writeFileSync(
        bicepFile,
        [
          "resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {",
          "  name: 'vm'",
          "  location: 'westeurope'",
          "  properties: {",
          "    hardwareProfile: {",
          "      vmSize: 'Standard_B1s'",
          "    }",
          "  }",
          "}",
          "",
        ].join("\n"),
      );

      const res = runJson(["verify", bicepFile, "-o", "json"]);
      expect([0, 1]).toContain(res.status);
      const payload = JSON.parse(res.stdout) as Record<string, unknown>;
      expect(payload.formats).toEqual(["bicep"]);
      const results = payload.results as Array<Record<string, unknown>>;
      expect(results).toHaveLength(1);
      expect(VM_VERDICTS.has(results[0]!.checks?.verdict as string)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verify human table prints verdicts, reasons, and the skip summary", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "azw-verify-"));
    try {
      const tfFile = path.join(dir, "main.tf");
      writeFileSync(
        tfFile,
        [
          'resource "azurerm_linux_virtual_machine" "vm" {',
          '  name     = "vm"',
          '  location = "westeurope"',
          '  size     = "Standard_B1s"',
          "}",
          "",
        ].join("\n"),
      );

      const res = runJson(["verify", tfFile]);
      expect([0, 1]).toContain(res.status);
      expect(res.stdout).toContain("RESOURCE");
      expect(res.stdout).toContain("VERDICT");
      // Blocked or not, the footer always states what was verified.
      expect(res.stdout).toMatch(/Verified 1 of 1 VM resources/);
      // The Reason line appears only when the checked pair is blocked.
      if (res.status === 1) {
        expect(res.stdout).toContain("Reason: ");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
