import { Command } from "commander";
import { armCacheSummary } from "../core/cache.js";
import { c, colorEnabled } from "../core/color.js";
import { exitWithError, ValidationError } from "../core/errors.js";
import { listLocations } from "../core/geo.js";
import { parseIacFiles } from "../core/iac.js";
import { printInfo, printJson, printTable } from "../core/output.js";
import {
  addJsonCompatibilityOptions,
  addOutputOption,
  isJsonOutput,
  isScriptOutput,
  resolveOutputMode,
} from "../core/outputMode.js";
import { buildVerifyPayload } from "../core/payloads.js";
import { loadPolicyCheck, type PolicySummary } from "../core/policy.js";
import {
  buildVerifyResourceTable,
  buildVerifyTable,
  countResourceVerdicts,
  countVerdicts,
  matchVerifyLocations,
  scanVerifyPairs,
  scanVerifyResourcePairs,
  verifyBlockerSummary,
  verifyResourceBlockerSummary,
} from "../core/verify.js";

/**
 * `azw verify <files...>` — IaC preflight. Parse Terraform/Bicep files and
 * check every statically-known pair before `terraform apply` or a Bicep
 * deployment:
 * - VM `location + size` pairs run through the same deployability chain as
 *   `azw check vm` (0.4.7).
 * - Generic `type + location` pairs (storage accounts, key vaults, web apps,
 *   service plans, AKS, PostgreSQL flexible servers, … since 0.4.8) run
 *   through the provider-catalog availability engine of `azw check resource`
 *   — availability confidence, never deployability.
 *
 * Only literal values are checked; dynamic expressions (variables,
 * interpolation, `resourceGroup().location`) are reported as skipped, never
 * guessed. There are no scope flags — the regions come from the files.
 *
 * `value` and `name` are rejected as validation errors: a file check has no
 * single script value.
 */
export function createVerifyCommand(): Command {
  const cmd = new Command("verify")
    .description(
      "Preflight Terraform/Bicep files: check VM size pairs and generic resource regions before apply.",
    )
    .argument("<files...>", "One or more .tf / .bicep files")
    .option("--concurrency <n>", "Parallel ARM calls (default 16)", "16")
    .option("--no-policy", "Skip Azure Policy allowed-location checks")
    .option("--refresh", "Bypass cached ARM location/SKU/provider data")
    .action(async (files: string[], opts) => {
      await runVerifyAction(files, opts);
    });
  addOutputOption(addJsonCompatibilityOptions(cmd, "Machine-readable JSON output"));
  return cmd;
}

export async function runVerifyAction(
  files: string[],
  opts: {
    concurrency?: string;
    policy?: boolean;
    refresh?: boolean;
    json?: boolean;
    compact?: boolean;
    output?: string;
  },
): Promise<void> {
  let jsonErrors = Boolean(opts.json);
  try {
    const mode = resolveOutputMode(opts, { command: "verify" });
    jsonErrors = isJsonOutput(mode);

    // Parsing and validation all happen before any Azure call, so a bad
    // path or extension fails fast with exit 3 even in CI.
    const parsedFiles = await parseIacFiles(files);
    const vmResourceCount = parsedFiles.reduce((n, f) => n + f.vmResourceCount, 0);
    const genericResourceCount = parsedFiles.reduce((n, f) => n + f.genericResourceCount, 0);
    if (vmResourceCount === 0 && genericResourceCount === 0) {
      throw new ValidationError(
        `No checkable resources found in ${files.length} file${
          files.length === 1 ? "" : "s"
        }. verify reads VM types (azurerm_*virtual_machine*, Microsoft.Compute/virtualMachines | virtualMachineScaleSets) and common generic types (azurerm_storage_account, azurerm_key_vault, azurerm_*_web_app, azurerm_service_plan, azurerm_kubernetes_cluster, azurerm_postgresql_flexible_server, and their Microsoft.* Bicep equivalents).`,
      );
    }
    const pairs = parsedFiles.flatMap((f) => f.pairs);
    const resourcePairs = parsedFiles.flatMap((f) => f.resourcePairs);
    const skipped = [...parsedFiles.flatMap((f) => f.skipped)];
    const resourceSkipped = [...parsedFiles.flatMap((f) => f.resourceSkipped)];
    const formats = [...new Set(parsedFiles.map((f) => f.format))];

    const totalCount = vmResourceCount + genericResourceCount;
    const locations = await listLocations({
      progressLabel: `Verifying ${totalCount} resource${totalCount === 1 ? "" : "s"}`,
      etaSeconds: 3,
      refresh: Boolean(opts.refresh),
    });
    const vmMatch = matchVerifyLocations(pairs, locations);
    skipped.push(...vmMatch.unmatched);
    const resourceMatch = matchVerifyLocations(resourcePairs, locations);
    resourceSkipped.push(...resourceMatch.unmatched);

    const policy = await loadPolicyCheck({
      enabled: opts.policy !== false,
      required: false,
    });
    const concurrency = Math.max(1, parseInt(opts.concurrency ?? "16", 10) || 16);
    const scanStart = Date.now();
    const vmScan =
      vmMatch.matched.length > 0
        ? await scanVerifyPairs({
            pairs: vmMatch.matched,
            concurrency,
            refresh: Boolean(opts.refresh),
            policy: policy.check,
          })
        : null;
    const resourceScan =
      resourceMatch.matched.length > 0
        ? await scanVerifyResourcePairs({
            pairs: resourceMatch.matched,
            refresh: Boolean(opts.refresh),
            policy: policy.check,
          })
        : null;
    const elapsedMs =
      vmMatch.matched.length + resourceMatch.matched.length > 0 ? Date.now() - scanStart : 0;
    const rows = vmScan?.rows ?? [];
    const resourceRows = resourceScan?.rows ?? [];

    const counts = countVerdicts(rows);
    const blocked = rows.length - counts.AVAILABLE;
    const resourceCounts = countResourceVerdicts(resourceRows);
    const resourceBlocked = resourceRows.length - resourceCounts.RESOURCE_SUPPORTED;

    if (isJsonOutput(mode)) {
      printJson(
        buildVerifyPayload({
          files: parsedFiles.map((f) => f.file),
          formats,
          scannedAt: new Date().toISOString(),
          elapsedMs,
          rows,
          skipped,
          vmResourceCount,
          resourceRows,
          resourceSkipped,
          genericResourceCount,
          cache: armCacheSummary(),
          policy: policy.summary,
        }),
      );
      if (blocked + resourceBlocked > 0) process.exit(1);
      return;
    }

    printPolicyWarning(policy.summary, mode);

    if (rows.length > 0) {
      const { headers, body } = buildVerifyTable(rows);
      printTable(body, headers);
      console.log("");
      // Reasons only for blocked pairs — available rows are self-explanatory.
      for (const row of rows) {
        if (row.checks.verdict === "AVAILABLE") continue;
        console.log(`Reason: ${row.resourceName} @ ${row.file}:${row.line} — ${row.explanation.reason}`);
        if (row.explanation.hint) console.log(`  Hint: ${row.explanation.hint}`);
      }
    }

    if (resourceRows.length > 0) {
      const label = "Generic resources (availability, not deployability):";
      console.log("");
      printInfo(colorEnabled() ? c.bold(label) : label);
      const { headers, body } = buildVerifyResourceTable(resourceRows);
      printTable(body, headers);
      console.log("");
      for (const row of resourceRows) {
        if (row.checks.verdict === "RESOURCE_SUPPORTED") continue;
        console.log(`Reason: ${row.resourceName} @ ${row.file}:${row.line} — ${row.explanation.reason}`);
        if (row.explanation.hint) console.log(`  Hint: ${row.explanation.hint}`);
      }
    }

    if (rows.length === 0 && resourceRows.length === 0) {
      const msg = "No resources were statically checkable — nothing was verified.";
      printInfo(colorEnabled() ? c.yellow(msg) : msg);
    }

    if (blocked > 0) {
      const msg = `${blocked} of ${rows.length} checked VM resource${
        rows.length === 1 ? "" : "s"
      } cannot deploy as written.`;
      printInfo(colorEnabled() ? c.red(c.bold(msg)) : msg);
      const summary = verifyBlockerSummary(counts);
      if (summary) printInfo(colorEnabled() ? c.dim(summary) : summary);
    } else if (rows.length > 0) {
      const msg = `All ${rows.length} checked VM resource${
        rows.length === 1 ? "" : "s"
      } can deploy as written.`;
      printInfo(colorEnabled() ? c.green(c.bold(msg)) : msg);
    }

    if (resourceBlocked > 0) {
      const msg = `${resourceBlocked} of ${resourceRows.length} checked generic resource${
        resourceRows.length === 1 ? "" : "s"
      } unavailable in ${resourceRows.length === 1 ? "its" : "their"} region${
        new Set(resourceRows.map((r) => r.region)).size === 1 ? "" : "s"
      } as written.`;
      printInfo(colorEnabled() ? c.red(c.bold(msg)) : msg);
      const summary = verifyResourceBlockerSummary(resourceCounts);
      if (summary) printInfo(colorEnabled() ? c.dim(summary) : summary);
    } else if (resourceRows.length > 0) {
      const msg = `All ${resourceRows.length} checked generic resource${
        resourceRows.length === 1 ? "" : "s"
      } advertised in ${
        resourceRows.length === 1 ? "its" : "their"
      } region — availability, not deployability.`;
      printInfo(colorEnabled() ? c.green(c.bold(msg)) : msg);
    }

    const allSkipped = [...skipped, ...resourceSkipped];
    if (allSkipped.length > 0) {
      console.log("");
      const label = `Skipped ${allSkipped.length} resource${
        allSkipped.length === 1 ? "" : "s"
      } — not statically checkable:`;
      printInfo(colorEnabled() ? c.yellow(label) : label);
      for (const s of allSkipped) {
        printInfo(`  ${s.resourceName} @ ${s.file}:${s.line} — ${s.detail} (${s.reason})`);
      }
      if (rows.length === 0 && resourceRows.length === 0) {
        const warn =
          "Nothing was verifiable: every resource uses dynamic values. Set literal location/size values, or check a region manually: azw check vm <sku> --region <name> | azw check resource <type> --region <name>";
        printInfo(colorEnabled() ? c.yellow(warn) : warn);
      }
    }

    const regionCount = new Set([...rows, ...resourceRows].map((r) => r.region)).size;
    const seconds = (elapsedMs / 1000).toFixed(1);
    const across = `across ${regionCount} region${regionCount === 1 ? "" : "s"} in ${seconds}s.`;
    const footer =
      rows.length > 0 && resourceRows.length > 0
        ? `Verified ${rows.length} of ${vmResourceCount} VM resources and ${resourceRows.length} of ${genericResourceCount} generic resources ${across}`
        : resourceRows.length > 0
          ? `Verified ${resourceRows.length} of ${genericResourceCount} generic resources ${across}`
          : `Verified ${rows.length} of ${vmResourceCount} VM resources ${across}`;
    printInfo(colorEnabled() ? c.dim(footer) : footer);

    // Skips never fail the run: verify exits 1 only when a checked pair is
    // actually blocked (VM pair blocked, or generic resource not available),
    // so variable-driven files stay a warning, not a gate.
    if (blocked + resourceBlocked > 0) process.exit(1);
  } catch (err) {
    exitWithError(err, jsonErrors);
  }
}

function printPolicyWarning(
  policy: PolicySummary,
  mode: ReturnType<typeof resolveOutputMode>,
): void {
  if (isScriptOutput(mode)) return;
  if (!policy.error) return;
  process.stderr.write(`Azure Policy was not checked: ${policy.error}\n`);
}
