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
      "price",
      "update",
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
});
