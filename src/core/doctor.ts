import { az } from "./az.js";
import { AzCliError, AzNotInstalledError, AzNotLoggedInError } from "./errors.js";
import { compareVersions } from "./updateCheck.js";
import type { AzAccount } from "./types.js";
import { c, colorEnabled } from "./color.js";

/**
 * Oldest `az` version azw actively supports. `az version` landed in 2.11.0,
 * which is also the first release with the modern auth surface azw leans on
 * (`account get-access-token` with stable JSON output).
 */
export const MINIMUM_AZ_VERSION = "2.11.0";

/**
 * Exit code when one or more doctor checks fail. Distinct from validation (3)
 * and auth (2) so CI can gate on "environment broken" without parsing output.
 */
export const DOCTOR_FAILURE_EXIT_CODE = 4;

export type DoctorStatus = "pass" | "fail" | "skip";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string | null;
  hint: string | null;
  /** Optional structured fields for JSON consumers (never secrets). */
  fields?: Record<string, string | null>;
}

export interface DoctorReport {
  ok: boolean;
  passed: number;
  failed: number;
  skipped: number;
  checks: DoctorCheck[];
}

/** Injectable so tests can fake the CLI without spawning processes. */
export type AzRunner = typeof az;

const CHECK_IDS = {
  installed: "az-installed",
  version: "az-version",
  login: "logged-in",
  subscription: "default-subscription",
  token: "arm-token",
} as const;

/**
 * Run the prerequisite checks in dependency order: install → version → login →
 * subscription → ARM token. Each check that can't run because an earlier one
 * failed is reported as `skip` with the reason, so the checklist always shows
 * all five lines.
 */
export async function runDoctor(run: AzRunner = az): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // ── Azure CLI installed + version (one `az version` call) ──────────────
  let version: string | null = null;
  let installed = false;
  try {
    const v = await run<{ "azure-cli"?: unknown }>(["version"]);
    installed = true;
    version = typeof v?.["azure-cli"] === "string" ? v["azure-cli"] : null;
  } catch (err) {
    if (err instanceof AzNotInstalledError) {
      installed = false;
    } else if (err instanceof AzCliError) {
      // `az` exists but refused — most often an ancient CLI without the
      // `version` subcommand. It is installed; the version check reports
      // honestly that the version could not be determined.
      installed = true;
    } else {
      throw err;
    }
  }

  if (!installed) {
    checks.push(
      fail(
        CHECK_IDS.installed,
        "Azure CLI installed",
        "`az` not found on PATH",
        "Install the Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli",
      ),
      skip(CHECK_IDS.version, "Azure CLI version supported", "Azure CLI not installed"),
      skip(CHECK_IDS.login, "Logged in to Azure", "Azure CLI not installed"),
      skip(CHECK_IDS.subscription, "Default subscription set", "Azure CLI not installed"),
      skip(CHECK_IDS.token, "ARM token mintable", "Azure CLI not installed"),
    );
    return buildReport(checks);
  }

  checks.push(
    pass(
      CHECK_IDS.installed,
      "Azure CLI installed",
      version ? `azure-cli ${version}` : "`az` on PATH (version unknown)",
    ),
  );

  // ── Version supported ───────────────────────────────────────────────────
  if (version === null) {
    checks.push(
      fail(
        CHECK_IDS.version,
        "Azure CLI version supported",
        "could not determine the azure-cli version",
        "Upgrade the Azure CLI (`az upgrade`), then re-run azw doctor.",
      ),
    );
  } else if (compareVersions(version, MINIMUM_AZ_VERSION) >= 0) {
    checks.push(
      pass(
        CHECK_IDS.version,
        "Azure CLI version supported",
        `${version} (minimum ${MINIMUM_AZ_VERSION})`,
        {
          version,
          minimum: MINIMUM_AZ_VERSION,
        },
      ),
    );
  } else {
    checks.push(
      fail(
        CHECK_IDS.version,
        "Azure CLI version supported",
        `${version} is older than the minimum supported ${MINIMUM_AZ_VERSION}`,
        "Upgrade the Azure CLI (`az upgrade`), then re-run azw doctor.",
        { version, minimum: MINIMUM_AZ_VERSION },
      ),
    );
  }

  // ── Login + default subscription (one `az account show` call) ──────────
  let account: AzAccount | null = null;
  let accountError: "not-logged-in" | "no-subscription" | "other" | null = null;
  let accountErrorDetail = "";
  try {
    account = await run<AzAccount>(["account", "show"]);
  } catch (err) {
    if (err instanceof AzNotLoggedInError) {
      accountError = "not-logged-in";
    } else if (err instanceof AzCliError) {
      const msg = err.stderr || err.message;
      if (/no subscription/i.test(msg)) {
        accountError = "no-subscription";
      } else {
        accountError = "other";
        accountErrorDetail = firstLine(msg) || err.message;
      }
    } else {
      throw err;
    }
  }

  const loggedIn = account !== null || accountError === "no-subscription";
  if (loggedIn) {
    const who = account?.user?.name
      ? `${account.user.name} (${account.user.type ?? "user"})`
      : null;
    checks.push(pass(CHECK_IDS.login, "Logged in to Azure", who));
  } else if (accountError === "not-logged-in") {
    checks.push(
      fail(
        CHECK_IDS.login,
        "Logged in to Azure",
        "not logged in",
        "Run: az login  (then azw doctor again)",
      ),
    );
  } else {
    checks.push(
      fail(
        CHECK_IDS.login,
        "Logged in to Azure",
        `az account show failed: ${accountErrorDetail}`,
        "Run `az account show` manually to see the full error, then `az login` if needed.",
      ),
    );
  }

  if (account) {
    checks.push(
      pass(CHECK_IDS.subscription, "Default subscription set", `${account.name} (${account.id})`, {
        subscriptionId: account.id,
        subscriptionName: account.name,
        tenantId: account.tenantId,
      }),
    );
  } else if (accountError === "no-subscription") {
    checks.push(
      fail(
        CHECK_IDS.subscription,
        "Default subscription set",
        "logged in, but no default subscription is set",
        "Run: az account set --subscription <subscription id or name>",
      ),
    );
  } else {
    checks.push(skip(CHECK_IDS.subscription, "Default subscription set", "not logged in"));
  }

  // ── ARM token ───────────────────────────────────────────────────────────
  // The token itself is a credential: extract only non-secret metadata
  // (expiry, tenant) and never copy accessToken into any check output.
  if (!loggedIn) {
    checks.push(skip(CHECK_IDS.token, "ARM token mintable", "not logged in"));
  } else {
    try {
      const tok = await run<{
        expiresOn?: unknown;
        tenant?: unknown;
        tenantId?: unknown;
        accessToken?: unknown;
      }>(["account", "get-access-token"]);
      const expiresOn = typeof tok?.expiresOn === "string" ? tok.expiresOn : null;
      // CLI releases name the tenant field differently (`tenant` in current
      // versions, `tenantId` in some older ones); accept both.
      const tenantId =
        typeof tok?.tenant === "string"
          ? tok.tenant
          : typeof tok?.tenantId === "string"
            ? tok.tenantId
            : null;
      const detail = ["token minted", expiresOn ? `expires ${expiresOn}` : null]
        .filter(Boolean)
        .join(", ");
      checks.push(pass(CHECK_IDS.token, "ARM token mintable", detail, { tenantId }));
    } catch (err) {
      if (err instanceof AzCliError || err instanceof AzNotLoggedInError) {
        checks.push(
          fail(
            CHECK_IDS.token,
            "ARM token mintable",
            `az account get-access-token failed: ${firstLine(err.stderr || err.message) || err.message}`,
            "Run `az account get-access-token` manually to see the full error.",
          ),
        );
      } else {
        throw err;
      }
    }
  }

  return buildReport(checks);
}

function buildReport(checks: DoctorCheck[]): DoctorReport {
  return {
    ok: checks.every((c) => c.status !== "fail"),
    passed: checks.filter((c) => c.status === "pass").length,
    failed: checks.filter((c) => c.status === "fail").length,
    skipped: checks.filter((c) => c.status === "skip").length,
    checks,
  };
}

function pass(
  id: string,
  label: string,
  detail: string | null,
  fields?: Record<string, string | null>,
): DoctorCheck {
  return { id, label, status: "pass", detail, hint: null, ...(fields ? { fields } : {}) };
}

function fail(
  id: string,
  label: string,
  detail: string | null,
  hint: string,
  fields?: Record<string, string | null>,
): DoctorCheck {
  return { id, label, status: "fail", detail, hint, ...(fields ? { fields } : {}) };
}

function skip(id: string, label: string, reason: string): DoctorCheck {
  return { id, label, status: "skip", detail: `skipped (${reason})`, hint: null };
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
}

/** ── Human rendering ─────────────────────────────────────────────────────── */

export function renderDoctorReport(report: DoctorReport): string[] {
  const lines: string[] = [];
  const labelWidth = Math.max(...report.checks.map((c) => c.label.length));
  for (const check of report.checks) {
    lines.push(renderCheckLine(check, labelWidth));
    if (check.status === "fail" && check.hint) {
      const hint = `    → ${check.hint}`;
      lines.push(colorEnabled() ? c.dim(hint) : hint);
    }
  }
  lines.push("");
  if (report.ok) {
    const msg = `All ${report.checks.length} checks passed — ready to scan.`;
    lines.push(colorEnabled() ? c.green(c.bold(msg)) : msg);
  } else {
    const msg = `${report.failed} of ${report.checks.length} checks failed. Fix the issues above and re-run azw doctor.`;
    lines.push(colorEnabled() ? c.red(msg) : msg);
  }
  return lines;
}

function renderCheckLine(check: DoctorCheck, labelWidth: number): string {
  const label = check.label.padEnd(labelWidth + 2);
  const detail = check.detail ? (colorEnabled() ? c.dim(check.detail) : check.detail) : "";
  if (!colorEnabled()) {
    return ` ${marker(check)} ${label}${detail}`;
  }
  switch (check.status) {
    case "pass":
      return ` ${c.green("✓")} ${label}${detail}`;
    case "fail":
      return ` ${c.red("✗")} ${label}${detail}`;
    case "skip":
      return ` ${c.dim("·")} ${c.dim(label)}${detail}`;
  }
}

function marker(check: DoctorCheck): string {
  switch (check.status) {
    case "pass":
      return "✓";
    case "fail":
      return "✗";
    case "skip":
      return "·";
  }
}
