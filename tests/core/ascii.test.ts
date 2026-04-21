import { describe, expect, it } from "vitest";
import { asciiSafe } from "../../src/core/ascii.js";

describe("asciiSafe", () => {
  it("folds Latin diacritics to their base letters", () => {
    expect(asciiSafe("Gävle")).toBe("Gavle");
    expect(asciiSafe("Querétaro State")).toBe("Queretaro State");
    expect(asciiSafe("São Paulo State")).toBe("Sao Paulo State");
  });

  it("leaves plain ASCII untouched", () => {
    expect(asciiSafe("Copenhagen")).toBe("Copenhagen");
    expect(asciiSafe("Dubai")).toBe("Dubai");
  });

  it("replaces non-foldable characters with `?`", () => {
    expect(asciiSafe("東京")).toBe("??");
  });

  it("handles undefined and empty input", () => {
    expect(asciiSafe(undefined)).toBe("");
    expect(asciiSafe("")).toBe("");
  });
});
