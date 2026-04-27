import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
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
    for (const cmd of ["where", "regions", "pick", "quota", "geos", "skus", "suggest", "update"]) {
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
  });

  it("skus and geos expose --refresh", () => {
    expect(run(["skus", "--help"])).toContain("--refresh");
    expect(run(["geos", "--help"])).toContain("--refresh");
  });
});
