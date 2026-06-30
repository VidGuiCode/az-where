import { Command } from "commander";
import { armCacheSummary } from "../core/cache.js";
import { exitWithError, ValidationError } from "../core/errors.js";
import { filterByGeography, listLocations, resolveGeography } from "../core/geo.js";
import { printInfo, printJson } from "../core/output.js";
import {
  addJsonCompatibilityOptions,
  addOutputOption,
  isJsonOutput,
  resolveOutputMode,
} from "../core/outputMode.js";
import { scanRegions, sortVerdicts } from "../core/scan.js";
import { normalizeSku } from "../core/sku.js";
import { chooseSuggestion, knownPlaces, resolvePlace } from "../core/suggest.js";
import { loadPolicyCheck } from "../core/policy.js";

export function createSuggestCommand(): Command {
  const cmd = new Command("suggest")
    .description("Suggest one deployable VM region. Canonical: `azw suggest vm <sku>`.")
    .argument("[vmOrSku]", "Canonical kind `vm`, or VM SKU shortcut")
    .argument("[sku]", "VM SKU for canonical syntax (`azw suggest vm B1s`)")
    .option("--sku <sku>", "VM SKU (alternative to positional)")
    .option("--eu", "EU only")
    .option("--us", "US only")
    .option("--asia", "Asia Pacific only")
    .option("--geography <group>", "geographyGroup filter", "all")
    .option("--near <city>", "Prefer regions near a known city, e.g. Luxembourg")
    .option("--concurrency <n>", "Parallel ARM calls (default 16)", "16")
    .option("--no-policy", "Skip Azure Policy allowed-location checks")
    .option("--refresh", "Bypass cached ARM location/SKU data")
    .action(async (vmOrSku: string | undefined, sku: string | undefined, opts) => {
      await runSuggestAction(resolveVmTarget(vmOrSku, sku, opts.sku, "suggest"), opts);
    });
  addOutputOption(addJsonCompatibilityOptions(cmd, "Machine-readable JSON output"));
  return cmd;
}

export async function runSuggestAction(
  rawSku: string | undefined,
  opts: {
    eu?: boolean;
    us?: boolean;
    asia?: boolean;
    geography?: string;
    near?: string;
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
    const mode = resolveOutputMode(opts, { allowValue: true, command: "suggest" });
    jsonErrors = isJsonOutput(mode);
    if (!rawSku) throw new ValidationError("Missing SKU. Try: azw suggest vm B1s --eu");
    const sku = normalizeSku(rawSku);

    const nearInput = opts.near ? String(opts.near) : "";
    const near = nearInput ? resolvePlace(nearInput) : null;
    if (nearInput && !near) {
      throw new ValidationError(
        `Unknown --near city '${nearInput}'. Known values: ${knownPlaces().join(", ")}`,
      );
    }

    const geoInput = opts.eu
      ? "eu"
      : opts.us
        ? "us"
        : opts.asia
          ? "asia"
          : (opts.geography ?? "all");
    const geo = resolveGeography(geoInput);
    const all = await listLocations({
      progressLabel: `Suggesting region for ${sku}`,
      etaSeconds: 5,
      refresh: Boolean(opts.refresh),
    });
    const locations = filterByGeography(all, geo);
    if (locations.length === 0) {
      throw new ValidationError(`No regions matched geography '${geoInput}'.`);
    }

    const concurrency = Math.max(1, parseInt(opts.concurrency ?? "16", 10) || 16);
    const policy = await loadPolicyCheck({
      enabled: opts.policy !== false,
      required: true,
    });
    const { rows: raw, elapsedMs } = await scanRegions({
      sku,
      locations,
      concurrency,
      refresh: Boolean(opts.refresh),
      policy: policy.check,
    });
    const rows = sortVerdicts(raw);
    const suggestion = chooseSuggestion(rows, near);

    if (!suggestion) {
      if (isJsonOutput(mode)) {
        printJson({
          schemaVersion: 1,
          kind: "suggest",
          resourceKind: "vm",
          sku,
          geography: geo ?? "all",
          near: nearInput || null,
          elapsedMs,
          cache: armCacheSummary(),
          policy: policy.summary,
          suggested: null,
        });
        process.exit(1);
      }
      process.stderr.write(`No region can deploy ${sku} right now.\n`);
      process.exit(1);
    }

    if (isJsonOutput(mode)) {
      printJson({
        schemaVersion: 1,
        kind: "suggest",
        resourceKind: "vm",
        sku,
        geography: geo ?? "all",
        near: nearInput || null,
        elapsedMs,
        cache: armCacheSummary(),
        policy: policy.summary,
        suggested: {
          region: suggestion.row.region,
          displayName: suggestion.row.displayName,
          reason: suggestion.reason,
          score: suggestion.score,
          factors: suggestion.factors,
        },
      });
      return;
    }

    printInfo(suggestion.row.region);
    if (mode !== "value") printInfo(suggestion.reason);
  } catch (err) {
    exitWithError(err, jsonErrors);
  }
}

function resolveVmTarget(
  kindOrSku: string | undefined,
  target: string | undefined,
  skuOption: string | undefined,
  verb: string,
): string | undefined {
  if (skuOption) return skuOption;
  if (!kindOrSku) return undefined;
  if (kindOrSku === "vm") return target;
  if (target) {
    throw new ValidationError(
      `Unsupported ${verb} kind '${kindOrSku}'. Use: azw ${verb} vm ${target}`,
    );
  }
  return kindOrSku;
}
