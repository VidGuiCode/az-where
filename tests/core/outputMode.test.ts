import { afterEach, describe, expect, it } from "vitest";
import {
  isJsonOutput,
  isScriptOutput,
  resolveOutputMode,
  supportedOutputModes,
} from "../../src/core/outputMode.js";
import { isCompactMode, isMachineOutputMode } from "../../src/core/runtime.js";

const ORIGINAL_ARGV = [...process.argv];

afterEach(() => {
  process.argv = [...ORIGINAL_ARGV];
});

describe("resolveOutputMode", () => {
  it("defaults to table", () => {
    expect(resolveOutputMode({})).toBe("table");
  });

  it("maps compatibility JSON flags to standard modes", () => {
    expect(resolveOutputMode({ json: true })).toBe("json");
    expect(resolveOutputMode({ json: true, compact: true })).toBe("compact");
  });

  it("lets explicit --output override compatibility flags", () => {
    expect(resolveOutputMode({ json: true, output: "table" })).toBe("table");
    expect(resolveOutputMode({ name: true, output: "json" })).toBe("json");
  });

  it("accepts value and name only when the command opts in", () => {
    expect(resolveOutputMode({ output: "value" }, { allowValue: true })).toBe("value");
    expect(resolveOutputMode({ output: "name" }, { allowName: true })).toBe("name");
    expect(() => resolveOutputMode({ output: "value" }, { command: "geos" })).toThrow(
      "Supported modes: table, json, compact.",
    );
    expect(() => resolveOutputMode({ output: "name" }, { command: "check vm" })).toThrow(
      "--output name is not supported for check vm",
    );
  });

  it("rejects unknown output modes", () => {
    expect(() => resolveOutputMode({ output: "yaml" })).toThrow(
      "Invalid --output. Use table, json, compact, value, or name.",
    );
  });

  it("reports script and JSON modes", () => {
    expect(isJsonOutput("json")).toBe(true);
    expect(isJsonOutput("compact")).toBe(true);
    expect(isJsonOutput("value")).toBe(false);
    expect(isScriptOutput("table")).toBe(false);
    expect(isScriptOutput("name")).toBe(true);
  });

  it("lists supported modes in stable order", () => {
    expect(supportedOutputModes()).toEqual(["table", "json", "compact"]);
    expect(supportedOutputModes({ allowValue: true, allowName: true })).toEqual([
      "table",
      "json",
      "compact",
      "value",
      "name",
    ]);
  });
});

describe("runtime output mode detection", () => {
  it("treats -o compact shorthand as compact machine output", () => {
    process.argv = ["node", "azw", "availability", "vm", "B1s", "-ocompact"];
    expect(isCompactMode()).toBe(true);
    expect(isMachineOutputMode()).toBe(true);
  });

  it("treats -o value shorthand as machine output", () => {
    process.argv = ["node", "azw", "pick", "vm", "B1s", "-o", "value"];
    expect(isMachineOutputMode()).toBe(true);
  });
});
