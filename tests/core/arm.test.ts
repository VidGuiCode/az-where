import { describe, expect, it, vi } from "vitest";
import { armList, parseArmErrorBody } from "../../src/core/arm.js";

vi.mock("../../src/core/az.js", () => ({
  az: vi.fn().mockResolvedValue({ accessToken: "test-token", subscription: "test-subscription" }),
}));

describe("parseArmErrorBody", () => {
  it("extracts nested ARM error code and message", () => {
    expect(
      parseArmErrorBody(
        JSON.stringify({
          error: {
            code: "AuthorizationFailed",
            message: "The client does not have authorization.",
          },
        }),
      ),
    ).toEqual({
      code: "AuthorizationFailed",
      message: "The client does not have authorization.",
    });
  });

  it("extracts flat ARM error shapes", () => {
    expect(
      parseArmErrorBody(JSON.stringify({ code: "TooManyRequests", message: "Slow down." })),
    ).toEqual({
      code: "TooManyRequests",
      message: "Slow down.",
    });
  });

  it("tolerates non-json bodies", () => {
    expect(parseArmErrorBody("not json")).toEqual({ code: null, message: null });
  });
});

describe("armList", () => {
  it("rejects an incomplete second page when callers require complete list evidence", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ value: [{ name: "first" }], nextLink: "https://management.azure.com/next" }),
      )
      .mockResolvedValueOnce(Response.json({ properties: {} }));
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(
        armList("/providers/Microsoft.Storage/skus", { cache: false, requireValueArray: true }),
      ).rejects.toThrow("Azure returned an invalid list response.");
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
