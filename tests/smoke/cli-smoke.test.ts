import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../../dist/cli.js");
// Read version from package.json so the smoke test tracks the published
// version automatically — previously hardcoded to "0.0.1", which broke CI
// on every release bump.
const PKG_VERSION = (
  JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf-8")) as {
    version: string;
  }
).version;

function run(args: string[]): string {
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1", CI: "1" },
  });
}

function runFail(args: string[]) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1", CI: "1" },
  });
}

describe("CLI smoke tests", () => {
  it("shows version", () => {
    const output = run(["--version"]);
    expect(output.trim()).toBe(PKG_VERSION);
  });

  it("shows help", () => {
    const output = run(["--help"]);
    expect(output).toContain("az-where");
    expect(output).toContain("Commands");
  });

  it("lists all top-level commands", () => {
    const output = run(["--help"]);
    for (const cmd of [
      "where",
      "regions",
      "pick",
      "quota",
      "geos",
      "skus",
      "resources",
      "suggest",
      "available",
      "availability",
      "check",
      "compare",
      "verify",
      "price",
      "update",
      "doctor",
    ]) {
      expect(output).toContain(cmd);
    }
  });

  it("update command has a help screen", () => {
    const output = run(["update", "--help"]);
    expect(output).toContain("update");
    expect(output).toContain("--json");
  });

  it("skus command has a help screen with filters", () => {
    const output = run(["skus", "--help"]);
    expect(output).toContain("--eu");
    expect(output).toContain("--family");
    expect(output).toContain("--json");
  });

  it("regions command has a --sku flag and geography shortcuts", () => {
    const output = run(["regions", "--help"]);
    expect(output).toContain("--sku");
    expect(output).toContain("--eu");
    expect(output).toContain("--us");
    expect(output).toContain("--asia");
    expect(output).toContain("--all");
    expect(output).toContain("--json");
    expect(output).toContain("--name");
    expect(output).toContain("--output");
    expect(output).toContain("--no-policy");
    expect(output).toContain("--refresh");
  });

  it("quota command accepts --all", () => {
    const output = run(["quota", "--help"]);
    expect(output).toContain("--all");
    expect(output).toContain("--no-policy");
    expect(output).toContain("--refresh");
  });

  it("pick command exists and has a help screen", () => {
    const output = run(["pick", "--help"]);
    expect(output).toContain("pick");
    expect(output).toContain("--eu");
    expect(output).toContain("--no-policy");
    expect(output).toContain("--refresh");
  });

  it("suggest command exists and has near/json flags", () => {
    const output = run(["suggest", "--help"]);
    expect(output).toContain("suggest");
    expect(output).toContain("--near");
    expect(output).toContain("--no-policy");
    expect(output).toContain("--json");
    expect(output).toContain("--output");
  });

  it("availability command exposes canonical vm and resource subcommands", () => {
    const output = run(["availability", "--help"]);
    expect(output).toContain("vm");
    expect(output).toContain("resource");
    expect(run(["availability", "vm", "--help"])).toContain("--output");
    expect(run(["availability", "resource", "--help"])).toContain("--name");
  });

  it("check command exposes vm and resource subcommands", () => {
    const output = run(["check", "--help"]);
    expect(output).toContain("vm");
    expect(output).toContain("resource");
    expect(run(["check", "vm", "--help"])).toContain("--region");
    expect(run(["check", "resource", "--help"])).toContain("--output");
  });

  it("compare command exposes the vm matrix subcommand", () => {
    const output = run(["compare", "--help"]);
    expect(output).toContain("vm");
    const vmHelp = run(["compare", "vm", "--help"]);
    expect(vmHelp).toContain("--region");
    expect(vmHelp).toContain("--eu");
    expect(vmHelp).toContain("--us");
    expect(vmHelp).toContain("--asia");
    expect(vmHelp).toContain("--geography");
    expect(vmHelp).toContain("--no-policy");
    expect(vmHelp).toContain("--refresh");
    expect(vmHelp).toContain("--output");
    expect(vmHelp).toContain("--json");
  });

  it("compare vm rejects value and name output modes before Azure calls", () => {
    const value = runFail(["compare", "vm", "B1s,B2s", "-o", "value"]);
    expect(value.status).toBe(3);
    expect(value.stderr).toContain("--output value is not supported for compare vm");

    const name = runFail(["compare", "vm", "B1s,B2s", "-o", "name"]);
    expect(name.status).toBe(3);
    expect(name.stderr).toContain("--output name is not supported for compare vm");
  });

  it("compare vm validates the SKU list before Azure calls", () => {
    const empty = runFail(["compare", "vm", ""]);
    expect(empty.status).toBe(3);
    expect(empty.stderr).toContain("Missing SKU list");

    const gap = runFail(["compare", "vm", "B1s,,B2s"]);
    expect(gap.status).toBe(3);
    expect(gap.stderr).toContain("empty entry");

    const tooMany = runFail([
      "compare",
      "vm",
      Array.from({ length: 31 }, (_, i) => `B${i}s`).join(","),
    ]);
    expect(tooMany.status).toBe(3);
    expect(tooMany.stderr).toContain("up to 30 SKUs");
  });

  it("compare vm rejects --region combined with geography flags before Azure calls", () => {
    const res = runFail(["compare", "vm", "B1s,B2s", "--region", "westeurope", "--eu"]);
    expect(res.status).toBe(3);
    expect(res.stderr).toContain("--region scopes to a single region");
  });

  it("verify command has a help screen with file arguments and no scope flags", () => {
    const output = run(["verify", "--help"]);
    expect(output).toContain("verify");
    expect(output).toContain(".tf");
    expect(output).toContain(".bicep");
    expect(output).toContain("--no-policy");
    expect(output).toContain("--refresh");
    expect(output).toContain("--output");
    expect(output).toContain("--json");
    // Regions come from the files — verify has no geography scope flags.
    expect(output).not.toContain("--eu");
  });

  it("verify rejects value and name output modes before Azure calls", () => {
    const value = runFail(["verify", "main.tf", "-o", "value"]);
    expect(value.status).toBe(3);
    expect(value.stderr).toContain("--output value is not supported for verify");

    const name = runFail(["verify", "main.tf", "-o", "name"]);
    expect(name.status).toBe(3);
    expect(name.stderr).toContain("--output name is not supported for verify");
  });

  it("verify validates files before Azure calls", () => {
    const missing = runFail(["verify", "does-not-exist.tf"]);
    expect(missing.status).toBe(3);
    expect(missing.stderr).toContain("Cannot read file");

    const badExt = runFail(["verify", "README.md"]);
    expect(badExt.status).toBe(3);
    expect(badExt.stderr).toContain(".tf (Terraform) or .bicep");

    const tfJson = runFail(["verify", "main.tf.json"]);
    expect(tfJson.status).toBe(3);
    expect(tfJson.stderr).toContain("JSON-syntax Terraform");
  });

  it("available command exists and has deployability filters", () => {
    const output = run(["available", "--help"]);
    expect(output).toContain("available");
    expect(output).toContain("--family");
    expect(output).toContain("--region");
    expect(output).toContain("--all");
    expect(output).toContain("--price");
    expect(output).toContain("--currency");
    expect(output).toContain("--sort");
    expect(output).toContain("--no-policy");
    expect(output).toContain("--refresh");
    expect(output).toContain("--json");
  });

  it("price command exists and has pricing flags", () => {
    const output = run(["price", "--help"]);
    expect(output).toContain("price");
    expect(output).toContain("--region");
    expect(output).toContain("--currency");
    expect(output).toContain("--os");
    expect(output).toContain("--hours");
    expect(output).toContain("--json");
  });

  it("resources command exposes discovery filters and output flags", () => {
    const output = run(["resources", "--help"]);
    expect(output).toContain("--namespace");
    expect(output).toContain("--grep");
    expect(output).toContain("--name");
    expect(output).toContain("--json");
    expect(output).toContain("--output");
    expect(output).toContain("--refresh");
  });

  it("skus and geos expose --refresh", () => {
    expect(run(["skus", "--help"])).toContain("--refresh");
    expect(run(["geos", "--help"])).toContain("--refresh");
  });

  it("rejects unsupported output modes before Azure calls", () => {
    const geos = runFail(["geos", "-o", "value"]);
    expect(geos.status).toBe(3);
    expect(geos.stderr).toContain("--output value is not supported for geos");

    const check = runFail(["check", "vm", "B1s", "--region", "westeurope", "-o", "name"]);
    expect(check.status).toBe(3);
    expect(check.stderr).toContain("--output name is not supported for check vm");
  });

  it("doctor command has a help screen with output flags", () => {
    const output = run(["doctor", "--help"]);
    expect(output).toContain("doctor");
    expect(output).toContain("prerequisites");
    expect(output).toContain("--output");
    expect(output).toContain("--json");
  });

  it("doctor rejects value and name modes before Azure calls", () => {
    const value = runFail(["doctor", "-o", "value"]);
    expect(value.status).toBe(3);
    expect(value.stderr).toContain("--output value is not supported for doctor");

    const name = runFail(["doctor", "-o", "name"]);
    expect(name.status).toBe(3);
    expect(name.stderr).toContain("--output name is not supported for doctor");
  });
});
