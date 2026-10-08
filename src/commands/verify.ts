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
  buildVerifyTable,
  countVerdicts,
  matchVerifyLocations,
  scanVerifyPairs,
  verifyBlockerSummary,
} from "../core/verify.js";

/**
 * `azw verify <files...>` — IaC preflight. Parse Terraform/Bicep files,
 * extract every statically-known VM `location + size` pair, and run each one
 * through the same deployability checks as `azw check vm` before
 * `terraform apply` or a Bicep deployment.
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
    .description("Preflight Terraform/Bicep files: check VM location+size pairs before apply.")
    .argument("<files...>", "One or more .tf / .bicep files")
    .option("--concurrency <n>", "Parallel ARM calls (default 16)", "16")
    .option("--no-policy", "Skip Azure Policy allowed-location checks")
    .option("--refresh", "Bypass cached ARM location/SKU data")
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
    if (vmResourceCount === 0) {
      throw new ValidationError(
        `No VM or virtual machine scale set resources found in ${files.length} file${
          files.length === 1 ? "" : "s"
        }. verify reads azurerm_*virtual_machine* resources (Terraform) and Microsoft.Compute/virtualMachines | virtualMachineScaleSets (Bicep).`,
      );
    }
    const pairs = parsedFiles.flatMap((f) => f.pairs);
    const parseSkipped = parsedFiles.flatMap((f) => f.skipped);
    const formats = [...new Set(parsedFiles.map((f) => f.format))];

    const locations = await listLocations({
      progressLabel: `Verifying ${vmResourceCount} VM resource${
        vmResourceCount === 1 ? "" : "s"
      }`,
      etaSeconds: 3,
      refresh: Boolean(opts.refresh),
    });
    const { matched, unmatched } = matchVerifyLocations(pairs, locations);
    const skipped = [...parseSkipped, ...unmatched];

    const policy = await loadPolicyCheck({
      enabled: opts.policy !== false,
      required: false,
    });
    const concurrency = Math.max(1, parseInt(opts.concurrency ?? "16", 10) || 16);
    const { rows, elapsedMs } =
      matched.length > 0
        ? await scanVerifyPairs({
            pairs: matched,
            concurrency,
            refresh: Boolean(opts.refresh),
            policy: policy.check,
          })
        : { rows: [], elapsedMs: 0 };

    const counts = countVerdicts(rows);
    const blocked = rows.length - counts.AVAILABLE;

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
          cache: armCacheSummary(),
          policy: policy.summary,
        }),
      );
      if (blocked > 0) process.exit(1);
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
    } else {
      const msg = "No VM resources were statically checkable — nothing was verified.";
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

    if (skipped.length > 0) {
      console.log("");
      const label = `Skipped ${skipped.length} resource${
        skipped.length === 1 ? "" : "s"
      } — not statically checkable:`;
      printInfo(colorEnabled() ? c.yellow(label) : label);
      for (const s of skipped) {
        printInfo(`  ${s.resourceName} @ ${s.file}:${s.line} — ${s.detail} (${s.reason})`);
      }
      if (rows.length === 0) {
        const warn =
          "Nothing was verifiable: every VM resource uses dynamic values. Set literal location/size values, or check a region manually: azw check vm <sku> --region <name>";
        printInfo(colorEnabled() ? c.yellow(warn) : warn);
      }
    }

    const regionCount = new Set(rows.map((r) => r.region)).size;
    const seconds = (elapsedMs / 1000).toFixed(1);
    const footer = `Verified ${rows.length} of ${vmResourceCount} VM resources across ${regionCount} region${
      regionCount === 1 ? "" : "s"
    } in ${seconds}s.`;
    printInfo(colorEnabled() ? c.dim(footer) : footer);

    // Skips never fail the run: verify exits 1 only when a checked pair is
    // actually blocked, so variable-driven files stay a warning, not a gate.
    if (blocked > 0) process.exit(1);
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
