import { describe, expect, it } from "vitest";
import { parseArmErrorBody } from "../../src/core/arm.js";

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
