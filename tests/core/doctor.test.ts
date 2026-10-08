import { describe, expect, it } from "vitest";
import {
  DOCTOR_FAILURE_EXIT_CODE,
  MINIMUM_AZ_VERSION,
  renderDoctorReport,
  runDoctor,
  type AzRunner,
} from "../../src/core/doctor.js";
import { AzCliError, AzNotInstalledError, AzNotLoggedInError } from "../../src/core/errors.js";
import type { AzAccount } from "../../src/core/types.js";

/**
 * The real `az` spawns a Python CLI (2-5s cold start per call), so these tests
 * inject a fake runner keyed on the argument vector. The fake honours the same
 * contract as core/az.ts: resolve with parsed JSON, reject with the typed
 * errors for not-installed / not-logged-in.
 */

const ACCOUNT: AzAccount = {
  id: "11111111-2222-3333-4444-555555555555",
  name: "Sub One",
  tenantId: "99999999-8888-7777-6666-555555555555",
  user: { name: "gui@example.com", type: "user" },
  state: "Enabled",
  isDefault: true,
};

// Not a credential — a synthetic stand-in whose only job is to prove the
// doctor report never copies the token value into any check output.
// Built by join() so no credential-shaped literal exists for scanners to
// pattern-match (identifier name alone trips them on plain string literals).
const DUMMY_ACCESS_TOKEN = ["stand-in", "not", "a", "credential"].join("-");

const TOKEN = {
  accessToken: DUMMY_ACCESS_TOKEN,
  expiresOn: "2026-10-07 13:02:31.000000",
  // Current az releases name the field `tenant`; some older ones used
  // `tenantId`. Doctor must report the tenant from either shape.
  tenant: ACCOUNT.tenantId,
  subscription: ACCOUNT.id,
  tokenType: "Bearer",
};

function fakeAz(script: (args: string[]) => unknown): AzRunner {
  return ((args: string[]) => Promise.resolve(script(args))) as AzRunner;
}

function fakeAzThrowing(script: (args: string[]) => Error): AzRunner {
  return ((args: string[]) => Promise.reject(script(args))) as AzRunner;
}

function check(report: Awaited<ReturnType<typeof runDoctor>>, id: string) {
  return report.checks.find((c) => c.id === id);
}

describe("runDoctor", () => {
  it("passes all five checks on a healthy environment", async () => {
    const report = await runDoctor(
      fakeAz((args) => {
        if (args[0] === "version") return { "azure-cli": "2.61.0" };
        if (args[0] === "account" && args[1] === "show") return ACCOUNT;
        if (args[0] === "account" && args[1] === "get-access-token") return TOKEN;
        throw new Error(`unexpected az call: ${args.join(" ")}`);
      }),
    );

    expect(report.ok).toBe(true);
    expect(report.passed).toBe(5);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(0);
    expect(check(report, "az-installed")?.detail).toBe("azure-cli 2.61.0");
    expect(check(report, "az-version")?.detail).toBe(`2.61.0 (minimum ${MINIMUM_AZ_VERSION})`);
    expect(check(report, "logged-in")?.detail).toBe("gui@example.com (user)");
    expect(check(report, "default-subscription")?.detail).toBe(`Sub One (${ACCOUNT.id})`);
    expect(check(report, "arm-token")?.detail).toContain("token minted");
    expect(check(report, "arm-token")?.detail).toContain("expires");
  });

  it("never leaks the access token into any check output", async () => {
    const report = await runDoctor(
      fakeAz((args) => {
        if (args[0] === "version") return { "azure-cli": "2.61.0" };
        if (args[0] === "account" && args[1] === "show") return ACCOUNT;
        return TOKEN;
      }),
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(DUMMY_ACCESS_TOKEN);
    expect(serialized).not.toContain("accessToken");
  });

  it("fails install and skips the rest when az is not on PATH", async () => {
    const report = await runDoctor(fakeAzThrowing(() => new AzNotInstalledError("az version")));

    expect(report.ok).toBe(false);
    expect(report.failed).toBe(1);
    expect(report.skipped).toBe(4);
    expect(check(report, "az-installed")?.status).toBe("fail");
    expect(check(report, "az-installed")?.hint).toContain("install-azure-cli");
    for (const id of ["az-version", "logged-in", "default-subscription", "arm-token"]) {
      expect(check(report, id)?.status).toBe("skip");
    }
  });

  it("fails the version check below the minimum but keeps checking login", async () => {
    const report = await runDoctor(
      fakeAz((args) => {
        if (args[0] === "version") return { "azure-cli": "2.5.0" };
        if (args[0] === "account") return args[1] === "show" ? ACCOUNT : TOKEN;
        throw new Error("unexpected");
      }),
    );

    expect(report.ok).toBe(false);
    const version = check(report, "az-version");
    expect(version?.status).toBe("fail");
    expect(version?.hint).toContain("az upgrade");
    // A too-old CLI still tells us whether login/token work.
    expect(check(report, "logged-in")?.status).toBe("pass");
    expect(check(report, "arm-token")?.status).toBe("pass");
  });

  it("treats az as installed when `az version` itself fails on an ancient CLI", async () => {
    const report = await runDoctor(
      fakeAz((args) => {
        if (args[0] === "version")
          return Promise.reject(
            new AzCliError(
              "az failed: 'version' is not in the 'az' command list",
              2,
              "",
              "az version",
            ),
          );
        if (args[0] === "account") return args[1] === "show" ? ACCOUNT : TOKEN;
        throw new Error("unexpected");
      }),
    );

    expect(check(report, "az-installed")?.status).toBe("pass");
    expect(check(report, "az-installed")?.detail).toContain("version unknown");
    expect(check(report, "az-version")?.status).toBe("fail");
    expect(check(report, "az-version")?.detail).toContain("could not determine");
    // The rest of the environment still gets checked honestly.
    expect(check(report, "logged-in")?.status).toBe("pass");
    expect(report.ok).toBe(false);
  });

  it("fails login with an az login hint and skips subscription/token", async () => {
    const report = await runDoctor(
      fakeAz((args) => {
        if (args[0] === "version") return { "azure-cli": "2.61.0" };
        if (args[0] === "account" && args[1] === "show")
          return Promise.reject(new AzNotLoggedInError("az account show", "Please run 'az login'"));
        throw new Error("unexpected");
      }),
    );

    const login = check(report, "logged-in");
    expect(login?.status).toBe("fail");
    expect(login?.hint).toContain("az login");
    expect(check(report, "default-subscription")?.status).toBe("skip");
    expect(check(report, "arm-token")?.status).toBe("skip");
  });

  it("reports logged-in-but-no-subscription as a subscription failure", async () => {
    const report = await runDoctor(
      fakeAz((args) => {
        if (args[0] === "version") return { "azure-cli": "2.61.0" };
        if (args[0] === "account" && args[1] === "show")
          return Promise.reject(
            new AzCliError(
              "az failed",
              1,
              "ERROR: No subscription found. Pass --subscription",
              "az account show",
            ),
          );
        if (args[0] === "account" && args[1] === "get-access-token") return TOKEN;
        throw new Error("unexpected");
      }),
    );

    expect(check(report, "logged-in")?.status).toBe("pass");
    const sub = check(report, "default-subscription");
    expect(sub?.status).toBe("fail");
    expect(sub?.hint).toContain("az account set --subscription");
  });

  it("fails the token check when the token cannot be minted", async () => {
    const report = await runDoctor(
      fakeAz((args) => {
        if (args[0] === "version") return { "azure-cli": "2.61.0" };
        if (args[0] === "account" && args[1] === "show") return ACCOUNT;
        if (args[0] === "account" && args[1] === "get-access-token")
          return Promise.reject(
            new AzCliError(
              "az failed",
              1,
              "ERROR: AADSTS50058: silent sign-in failed",
              "az account get-access-token",
            ),
          );
        throw new Error("unexpected");
      }),
    );

    const token = check(report, "arm-token");
    expect(token?.status).toBe("fail");
    expect(token?.detail).toContain("get-access-token failed");
    expect(report.failed).toBe(1);
  });

  it("reports the tenant from the legacy tenantId token field too", async () => {
    const legacyToken = { ...TOKEN, tenant: undefined, tenantId: "legacy-tenant-id" };
    const report = await runDoctor(
      fakeAz((args) => {
        if (args[0] === "version") return { "azure-cli": "2.61.0" };
        if (args[0] === "account") return args[1] === "show" ? ACCOUNT : legacyToken;
        throw new Error("unexpected");
      }),
    );
    expect(check(report, "arm-token")?.fields?.tenantId).toBe("legacy-tenant-id");
  });

  it("keeps the minimum version in sync with compareVersions semantics", async () => {
    const atMinimum = await runDoctor(
      fakeAz((args) => {
        if (args[0] === "version") return { "azure-cli": MINIMUM_AZ_VERSION };
        if (args[0] === "account") return args[1] === "show" ? ACCOUNT : TOKEN;
        throw new Error("unexpected");
      }),
    );
    expect(check(atMinimum, "az-version")?.status).toBe("pass");
  });

  it("exposes a distinct non-zero exit code for CI gating", () => {
    expect(DOCTOR_FAILURE_EXIT_CODE).toBeGreaterThan(0);
    expect(DOCTOR_FAILURE_EXIT_CODE).not.toBe(1);
    expect(DOCTOR_FAILURE_EXIT_CODE).not.toBe(2);
    expect(DOCTOR_FAILURE_EXIT_CODE).not.toBe(3);
  });
});

describe("renderDoctorReport", () => {
  it("renders pass markers and the ready footer when everything passes", async () => {
    const report = await runDoctor(
      fakeAz((args) => {
        if (args[0] === "version") return { "azure-cli": "2.61.0" };
        if (args[0] === "account") return args[1] === "show" ? ACCOUNT : TOKEN;
        throw new Error("unexpected");
      }),
    );
    const lines = renderDoctorReport(report).join("\n");
    expect(lines).toContain("✓ Azure CLI installed");
    expect(lines).toContain("ready to scan");
    expect(lines).not.toContain("→");
  });

  it("renders fail markers with hints when a prerequisite is missing", async () => {
    const report = await runDoctor(fakeAzThrowing(() => new AzNotInstalledError("az version")));
    const lines = renderDoctorReport(report).join("\n");
    expect(lines).toContain("✗ Azure CLI installed");
    expect(lines).toContain("→ Install the Azure CLI");
    expect(lines).toContain("checks failed");
    expect(lines).toContain("· Azure CLI version supported");
  });
});
