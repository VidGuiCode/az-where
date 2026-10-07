import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
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

  it("rejects an unknown resource type with a JSON ValidationError envelope (exit 3)", () => {
    const res = runJson([
      "availability",
      "resource",
      "Microsoft.Nonsense/doesNotExist",
      "--region",
      "westeurope",
      "-o",
      "json",
    ]);
    expect(res.status).toBe(3);
    const err = JSON.parse(res.stderr) as Record<string, unknown>;
    expect(err.status).toBe("error");
    expect(err.code).toBe("ValidationError");
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
