import { afterEach, describe, expect, it, vi } from "vitest";
import { printErrorJson } from "../../src/core/output.js";
import {
  ArmHttpError,
  AzCliError,
  AzNotInstalledError,
  AzNotLoggedInError,
  getExitCode,
  ValidationError,
} from "../../src/core/errors.js";

/**
 * These are *contract* tests: scripts and agents parse `azw ... -o json` on
 * failure, so the error envelope shape and the process exit codes must not
 * drift casually. If one of these breaks, it is a breaking change for every
 * downstream consumer, not just a refactor.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function captureErrorJson(error: unknown): Record<string, unknown> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  printErrorJson(error);
  const out = spy.mock.calls.map((call) => String(call[0])).join("\n");
  return JSON.parse(out) as Record<string, unknown>;
}

describe("JSON error envelope contract", () => {
  it("AzCliError carries code AZ_CLI_ERROR and exit/stderr/command details", () => {
    const json = captureErrorJson(
      new AzCliError("boom", 127, "stderr text", "az account get-access-token"),
    );
    expect(json).toEqual({
      status: "error",
      code: "AZ_CLI_ERROR",
      message: "boom",
      details: {
        exitCode: 127,
        stderr: "stderr text",
        command: "az account get-access-token",
      },
    });
  });

  it("ArmHttpError carries code ARM_HTTP_ERROR and ARM diagnostics", () => {
    const json = captureErrorJson(
      new ArmHttpError(403, "Forbidden", "/subscriptions/x", "AuthorizationFailed", "no access", "{...}"),
    );
    expect(json).toEqual({
      status: "error",
      code: "ARM_HTTP_ERROR",
      message: "ARM 403 Forbidden: AuthorizationFailed - no access",
      details: {
        statusCode: 403,
        statusText: "Forbidden",
        endpoint: "/subscriptions/x",
        armCode: "AuthorizationFailed",
        armMessage: "no access",
        body: "{...}",
      },
    });
  });

  it("ValidationError surfaces its name as the code", () => {
    expect(captureErrorJson(new ValidationError("bad input"))).toEqual({
      status: "error",
      code: "ValidationError",
      message: "bad input",
    });
  });

  it("non-Error values fall back to UNKNOWN_ERROR", () => {
    expect(captureErrorJson("weird")).toEqual({
      status: "error",
      code: "UNKNOWN_ERROR",
      message: "weird",
    });
  });

  it("every envelope always has status=error plus string code and message", () => {
    const errors: unknown[] = [
      new AzCliError("m", 1, "", "az x"),
      new ArmHttpError(500, "err", "/e", null, null, ""),
      new ValidationError("v"),
      new Error("plain"),
      "str",
    ];
    for (const err of errors) {
      const json = captureErrorJson(err);
      expect(json.status).toBe("error");
      expect(typeof json.code).toBe("string");
      expect(typeof json.message).toBe("string");
    }
  });
});

describe("exit-code contract", () => {
  it("maps each error type to a stable exit code", () => {
    expect(getExitCode(new AzNotInstalledError("az x"))).toBe(127);
    expect(getExitCode(new AzNotLoggedInError("az x", ""))).toBe(2);
    expect(getExitCode(new ValidationError("v"))).toBe(3);
    expect(getExitCode(new AzCliError("m", 1, "", "az x"))).toBe(1);
    expect(getExitCode(new ArmHttpError(500, "err", "/e", null, null, ""))).toBe(1);
    expect(getExitCode("unknown")).toBe(1);
  });
});
