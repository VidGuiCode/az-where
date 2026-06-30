import { Command } from "commander";
import { exitWithError, ValidationError } from "../core/errors.js";
import { printFooter, printInfo, printJson, printVerdictTable } from "../core/output.js";
import { filterByGeography, listLocations, resolveGeography } from "../core/geo.js";
import { scanRegions, sortVerdicts } from "../core/scan.js";
import { normalizeSku } from "../core/sku.js";
import { c, colorEnabled } from "../core/color.js";
import { armCacheSummary } from "../core/cache.js";
import { loadPolicyCheck, type PolicySummary } from "../core/policy.js";
import {
  addJsonCompatibilityOptions,
  addOutputOption,
  isJsonOutput,
  isScriptOutput,
  resolveOutputMode,
} from "../core/outputMode.js";

export function createRegionsCommand(): Command {
  const cmd = new Command("regions")
    .description("Compatibility shortcut for `azw availability vm <sku>`.")
    .argument("[sku]", "VM SKU (e.g. B1s, Standard_B1s, D2s_v5)")
    .option("--sku <sku>", "VM SKU (alternative to positional argument)")
    .option("--eu", "Shortcut for --geography Europe")
    .option("--us", "Shortcut for --geography US")
    .option("--asia", "Shortcut for --geography 'Asia Pacific'")
    .option("--region <name>", "Scope to a single region")
    .option(
      "--geography <group>",
      "Filter by geographyGroup (eu, us, asia, or an exact group)",
      "all",
    )
    .option("--concurrency <n>", "Parallel ARM calls (default 16)", "16")
    .option("--all", "Show every region, including those where the SKU isn't offered")
    .option("--no-policy", "Skip Azure Policy allowed-location checks")
    .option("--refresh", "Bypass cached ARM location/SKU data")
    .option("--name", "Print one region name per line (for scripting)")
    .action(async (positional: string | undefined, opts) => {
      await runRegionsAction(positional, opts, "regions");
    });
  addOutputOption(addJsonCompatibilityOptions(cmd, "Machine-readable JSON output"));
  return cmd;
}

export async function runRegionsAction(
  positional: string | undefined,
  opts: {
    sku?: string;
    eu?: boolean;
    us?: boolean;
    asia?: boolean;
    region?: string;
    geography?: string;
    concurrency?: string;
    all?: boolean;
    policy?: boolean;
    refresh?: boolean;
    json?: boolean;
    compact?: boolean;
    name?: boolean;
    output?: string;
  },
  kind = "regions",
): Promise<void> {
  let jsonErrors = Boolean(opts.json);
  try {
    const mode = resolveOutputMode(opts, { allowName: true, command: kind });
    jsonErrors = isJsonOutput(mode);
    const rawSku = opts.sku ?? positional;
    if (!rawSku) throw new ValidationError("Missing SKU. Try: azw availability vm B1s --eu");
    const sku = normalizeSku(rawSku);

    if (opts.region) validateRegionScope(opts);

    const geoInput = opts.eu
      ? "eu"
      : opts.us
        ? "us"
        : opts.asia
          ? "asia"
          : (opts.geography ?? "all");
    const geo = resolveGeography(geoInput);

    const all = await listLocations({
      progressLabel: `Scanning for ${sku}`,
      etaSeconds: 5,
      refresh: Boolean(opts.refresh),
    });
    const locations = opts.region ? matchRegion(all, opts.region) : filterByGeography(all, geo);

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
    const { rows: raw, elapsedMs } = await scanRegions({
      sku,
      locations,
      concurrency,
      refresh: Boolean(opts.refresh),
      policy: policy.check,
    });
    const rows = sortVerdicts(raw);

    if (mode === "name") {
      printPolicyWarning(policy.summary, mode);
      const ready = rows.filter((r) => r.verdict === "AVAILABLE");
      for (const r of ready) console.log(r.region);
      if (ready.length === 0) process.exit(1);
      return;
    }

    const deployable = rows.some((r) => r.verdict === "AVAILABLE");

    if (isJsonOutput(mode)) {
      printJson({
        schemaVersion: 1,
        kind,
        resourceKind: "vm",
        sku,
        geography: opts.region ? null : (geo ?? "all"),
        region: opts.region ? locations[0].name : null,
        scannedAt: new Date().toISOString(),
        elapsedMs,
        cache: armCacheSummary(),
        policy: policy.summary,
        regions: rows,
      });
      if (!deployable) process.exit(1);
      return;
    }

    const hidden = opts.all ? [] : rows.filter((r) => r.verdict === "SKU_NOT_OFFERED");
    const visible = opts.all ? rows : rows.filter((r) => r.verdict !== "SKU_NOT_OFFERED");
    printPolicyWarning(policy.summary, mode);
    printVerdictTable(visible);
    if (hidden.length > 0) {
      const note = `+ ${hidden.length} regions where Azure doesn't offer ${sku} (use --all to show)`;
      printInfo(colorEnabled() ? c.dim(note) : note);
    }
    printFooter(rows, elapsedMs, sku);
    if (!deployable) process.exit(1);
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
