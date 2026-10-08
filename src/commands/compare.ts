import { Command } from "commander";
import { armCacheSummary } from "../core/cache.js";
import {
  allDeployableRegions,
  buildCompareTable,
  compareColumnLabel,
  compareLegendLine,
  parseSkuList,
  scanCompare,
  sortCompareRowsForTable,
} from "../core/compare.js";
import { c, colorEnabled } from "../core/color.js";
import { exitWithError, ValidationError } from "../core/errors.js";
import { filterByGeography, listLocations, resolveGeography } from "../core/geo.js";
import { printInfo, printJson, printTable } from "../core/output.js";
import {
  addJsonCompatibilityOptions,
  addOutputOption,
  isJsonOutput,
  isScriptOutput,
  resolveOutputMode,
} from "../core/outputMode.js";
import { loadPolicyCheck, type PolicySummary } from "../core/policy.js";

/**
 * `azw compare vm B1s,B2s,D2s_v5 --eu` — matrix of deployability verdicts
 * across regions × VM sizes. VM-only in 0.4.5; resource comparison is
 * deliberately deferred (see docs/roadmap.md).
 *
 * `value` and `name` are rejected as validation errors: a comparison has no
 * single script value or one-name-per-line meaning.
 */
export function createCompareCommand(): Command {
  const cmd = new Command("compare").description(
    "Compare multiple targets across regions (VM sizes for now).",
  );

  const vm = new Command("vm")
    .description("Matrix of deployability verdicts for several VM sizes across regions.")
    .argument("<skus>", "Comma-separated VM SKU list (e.g. B1s,B2s,D2s_v5)")
    .option("--region <name>", "Scope to a single region")
    .option("--eu", "Shortcut for --geography Europe")
    .option("--us", "Shortcut for --geography US")
    .option("--asia", "Shortcut for --geography 'Asia Pacific'")
    .option("--geography <group>", "Filter by geographyGroup", "all")
    .option("--concurrency <n>", "Parallel ARM calls (default 16)", "16")
    .option("--no-policy", "Skip Azure Policy allowed-location checks")
    .option("--refresh", "Bypass cached ARM location/SKU data")
    .action(async (skus: string, opts) => {
      await runCompareVmAction(skus, opts);
    });
  addOutputOption(addJsonCompatibilityOptions(vm, "Machine-readable JSON output"));

  cmd.addCommand(vm);
  return cmd;
}

export async function runCompareVmAction(
  positional: string,
  opts: {
    region?: string;
    eu?: boolean;
    us?: boolean;
    asia?: boolean;
    geography?: string;
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
    const mode = resolveOutputMode(opts, { command: "compare vm" });
    jsonErrors = isJsonOutput(mode);
    const skus = parseSkuList(positional);

    if (opts.region) validateRegionScope(opts);

    const geoInput = opts.eu
      ? "eu"
      : opts.us
        ? "us"
        : opts.asia
          ? "asia"
          : (opts.geography ?? "all");
    const geo = resolveGeography(geoInput);

    const list = await listLocations({
      progressLabel: `Comparing ${skus.length} VM size${skus.length === 1 ? "" : "s"}`,
      etaSeconds: 5,
      refresh: Boolean(opts.refresh),
    });
    const locations = opts.region
      ? matchRegion(list, opts.region)
      : filterByGeography(list, geo);
    if (locations.length === 0) {
      throw new ValidationError(
        opts.region
          ? `Unknown region '${opts.region}'. Try: azw geos`
          : `No regions matched geography '${geoInput}'. Try: azw geos`,
      );
    }

    const concurrency = Math.max(1, parseInt(opts.concurrency ?? "16", 10) || 16);
    const policy = await loadPolicyCheck({
      enabled: opts.policy !== false,
      required: false,
    });
    const { regionRows, skus: summaries, elapsedMs } = await scanCompare({
      skus,
      locations,
      concurrency,
      refresh: Boolean(opts.refresh),
      policy: policy.check,
    });

    const anyDeployable = summaries.some((s) => s.deployableCount > 0);

    if (isJsonOutput(mode)) {
      printJson({
        schemaVersion: 1,
        kind: "compare",
        resourceKind: "vm",
        confidence: "deployability",
        skus,
        // Region axis shared by every per-SKU result below, in the same order.
        regions: regionRows.map((row) => row.location.name),
        geography: opts.region ? null : (geo ?? "all"),
        region: opts.region ? locations[0].name : null,
        scannedAt: new Date().toISOString(),
        elapsedMs,
        cache: armCacheSummary(),
        policy: policy.summary,
        results: summaries,
      });
      if (!anyDeployable) process.exit(1);
      return;
    }

    printPolicyWarning(policy.summary, mode);
    const sorted = sortCompareRowsForTable(regionRows);
    const { headers, body } = buildCompareTable(sorted, skus);
    printTable(body, headers);
    printInfo(compareLegendLine());

    console.log("");
    for (const summary of summaries) {
      const label = compareColumnLabel(summary.sku).padEnd(
        Math.max(...skus.map((s) => compareColumnLabel(s).length)),
      );
      const line = `${label}   deployable in ${summary.deployableCount}/${regionRows.length} regions`;
      printInfo(
        colorEnabled()
          ? summary.deployableCount > 0
            ? c.green(line)
            : c.red(line)
          : line,
      );
    }

    if (skus.length > 1) {
      const everywhere = allDeployableRegions(sorted);
      if (everywhere.length > 0) {
        const msg = `All ${skus.length} SKUs deploy in ${everywhere.length} region${
          everywhere.length === 1 ? "" : "s"
        }: ${everywhere.join(", ")}`;
        printInfo(colorEnabled() ? c.green(c.bold(msg)) : msg);
      } else {
        const msg = "No single region can deploy every requested SKU.";
        printInfo(colorEnabled() ? c.yellow(msg) : msg);
      }
    }

    const seconds = (elapsedMs / 1000).toFixed(1);
    const footer = `Compared ${skus.length} VM size${skus.length === 1 ? "" : "s"} across ${
      regionRows.length
    } region${regionRows.length === 1 ? "" : "s"} in ${seconds}s.`;
    printInfo(colorEnabled() ? c.dim(footer) : footer);

    if (!anyDeployable) process.exit(1);
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

function validateRegionScope(opts: {
  eu?: boolean;
  us?: boolean;
  asia?: boolean;
  geography?: string;
}): void {
  const conflicting = [
    opts.eu && "--eu",
    opts.us && "--us",
    opts.asia && "--asia",
    opts.geography && opts.geography !== "all" && `--geography ${opts.geography}`,
  ].filter(Boolean);
  if (conflicting.length > 0) {
    throw new ValidationError(
      `--region scopes to a single region and can't be combined with ${conflicting.join(", ")}.`,
    );
  }
}

function matchRegion(locations: Awaited<ReturnType<typeof listLocations>>, region: string) {
  const normalized = region.trim().toLowerCase();
  return locations.filter((l) => l.name.toLowerCase() === normalized);
}
