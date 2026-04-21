import { describe, expect, it } from "vitest";
import { looksLikeSku, normalizeSku } from "../../src/core/sku.js";

describe("normalizeSku", () => {
  it("prepends Standard_ to bare sizes", () => {
    expect(normalizeSku("B1s")).toBe("Standard_B1s");
    expect(normalizeSku("D2s_v5")).toBe("Standard_D2s_v5");
    expect(normalizeSku("NC24ads_A100_v4")).toBe("Standard_NC24ads_A100_v4");
  });

  it("leaves canonical SKUs unchanged", () => {
    expect(normalizeSku("Standard_B1s")).toBe("Standard_B1s");
    expect(normalizeSku("Standard_D2s_v5")).toBe("Standard_D2s_v5");
  });

  it("canonicalises case of the Standard_ prefix", () => {
    expect(normalizeSku("standard_B1s")).toBe("Standard_B1s");
    expect(normalizeSku("STANDARD_B1s")).toBe("Standard_B1s");
  });

  it("trims whitespace", () => {
    expect(normalizeSku("  B1s  ")).toBe("Standard_B1s");
  });
});

describe("looksLikeSku", () => {
  it("accepts VM size shapes", () => {
    expect(looksLikeSku("B1s")).toBe(true);
    expect(looksLikeSku("D2s_v5")).toBe(true);
    expect(looksLikeSku("NC24ads_A100_v4")).toBe(true);
    expect(looksLikeSku("Standard_B1s")).toBe(true);
  });

  it("rejects verb-ish words", () => {
    expect(looksLikeSku("regions")).toBe(false);
    expect(looksLikeSku("where")).toBe(false);
    expect(looksLikeSku("pick")).toBe(false);
    expect(looksLikeSku("quota")).toBe(false);
    expect(looksLikeSku("geos")).toBe(false);
  });

  it("rejects flags and empties", () => {
    expect(looksLikeSku("--sku")).toBe(false);
    expect(looksLikeSku("-j")).toBe(false);
    expect(looksLikeSku("")).toBe(false);
  });
});
