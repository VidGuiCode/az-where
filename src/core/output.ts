import { ArmHttpError, AzCliError } from "./errors.js";
import { isCompactMode } from "./runtime.js";
import { c, colorEnabled, padVisible, visibleLength } from "./color.js";
import { shortGeo } from "./geo.js";
import { asciiSafe } from "./ascii.js";
import type { RegionVerdict } from "./types.js";

// Windows consoles (especially PS 5.1) mangle UTF-8. Fold to ASCII in the
// table only — JSON output keeps the true value.
const FOLD_UNICODE = process.platform === "win32";
const displayCell = (s: string | undefined): string => (FOLD_UNICODE ? asciiSafe(s) : (s ?? ""));

export function printInfo(message: string): void {
  console.log(message);
}

export function printError(message: string): void {
  console.error(`${colorEnabled() ? c.red("✗") : "✗"}  ${message}`);
}

export function printErrorJson(error: unknown): void {
  const errorObj =
    error instanceof AzCliError
      ? {
          status: "error",
          code: "AZ_CLI_ERROR",
          message: error.message,
          details: {
            exitCode: error.exitCode,
            stderr: error.stderr,
            command: error.command,
          },
        }
      : error instanceof ArmHttpError
        ? {
            status: "error",
            code: "ARM_HTTP_ERROR",
            message: error.message,
            details: {
              statusCode: error.statusCode,
              statusText: error.statusText,
              endpoint: error.endpoint,
              armCode: error.armCode,
              armMessage: error.armMessage,
              body: error.bodySnippet,
            },
          }
      : error instanceof Error
        ? {
            status: "error",
            code: error.name,
            message: error.message,
          }
        : {
            status: "error",
            code: "UNKNOWN_ERROR",
            message: String(error),
          };
  console.error(JSON.stringify(errorObj, null, 2));
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, isCompactMode() ? undefined : 2));
}

export function printTable(rows: string[][], headers?: string[]): void {
  if (rows.length === 0 && !headers) return;
  const allRows = headers ? [headers, ...rows] : rows;
  const widths = allRows[0].map((_, i) =>
    Math.max(...allRows.map((r) => visibleLength(r[i] ?? ""))),
  );
  if (headers) {
    console.log(headers.map((h, i) => padVisible(h, widths[i])).join("   "));
    console.log(widths.map((w) => "─".repeat(w)).join("   "));
  }
  for (const row of rows) {
    console.log(row.map((cell, i) => padVisible(cell ?? "", widths[i])).join("   "));
  }
}

const VERDICT_LABEL: Record<RegionVerdict["verdict"], string> = {
  AVAILABLE: "✓ DEPLOY",
  FULL: "✗ QUOTA FULL",
  BLOCKED_FOR_SUB: "✗ SUB BLOCKED",
  SKU_NOT_OFFERED: "✗ SKU NOT OFFERED",
  QUOTA_UNKNOWN: "! QUOTA UNKNOWN",
};

function verdictCell(v: RegionVerdict["verdict"]): string {
  const label = VERDICT_LABEL[v];
  if (!colorEnabled()) return label;
  switch (v) {
    case "AVAILABLE":
      return c.green(c.bold(label));
    case "FULL":
    case "BLOCKED_FOR_SUB":
    case "SKU_NOT_OFFERED":
      return c.red(label);
    case "QUOTA_UNKNOWN":
      return c.yellow(label);
  }
}

function quotaCell(row: RegionVerdict): string {
  if (row.free === null || row.limit === null) {
    if (row.verdict === "QUOTA_UNKNOWN") return colorEnabled() ? c.yellow("?") : "?";
    return colorEnabled() ? c.dim("—") : "—";
  }
  const label = `${row.free}/${row.limit} free`;
  if (!colorEnabled()) return label;
  return row.free >= 1 ? c.green(label) : c.red(label);
}

function offeredCell(offered: boolean): string {
  if (!colorEnabled()) return offered ? "✓" : "✗";
  return offered ? c.green("✓") : c.red("✗");
}

export function printVerdictTable(rows: RegionVerdict[]): void {
  const headers = ["REGION", "GEO", "LOCATION", "OFFERED", "QUOTA", "VERDICT"];
  const body = rows.map((r) => [
    r.region,
    shortGeo(r.geographyGroup),
    displayCell(r.physicalLocation ?? r.displayName),
    offeredCell(r.skuOffered),
    quotaCell(r),
    verdictCell(r.verdict),
  ]);
  printTable(body, headers);
}

export function printFooter(rows: RegionVerdict[], elapsedMs: number, sku: string): void {
  const ready = rows.filter((r) => r.verdict === "AVAILABLE");
  const seconds = (elapsedMs / 1000).toFixed(1);
  console.log("");
  if (ready.length > 0) {
    const names = ready.map((r) => r.region).join(", ");
    const prefix = `Ready to deploy ${sku} (${ready.length}):`;
    console.log(`${colorEnabled() ? c.green(c.bold(prefix)) : prefix} ${names}`);
  } else {
    const msg = `No region can deploy ${sku} right now.`;
    console.log(colorEnabled() ? c.red(msg) : msg);
  }
  const footer = `Scanned ${rows.length} regions in ${seconds}s.`;
  console.log(colorEnabled() ? c.dim(footer) : footer);
}
