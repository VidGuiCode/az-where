import { Command } from "commander";
import { exitWithError, ValidationError } from "../core/errors.js";
import { explainVmVerdict } from "../core/explain.js";
import { printJson } from "../core/output.js";
import { filterByGeography, listLocations, resolveGeography } from "../core/geo.js";
import {
  allSupportedRegionRows,
  closestMissSummary,
  compareResourceColumnLabel,
  parseResourceTargetList,
  scanCompareResources,
} from "../core/compareResource.js";
import { buildPickPayload, buildPickResourcePayload } from "../core/payloads.js";
import { scanRegions, sortVerdicts } from "../core/scan.js";
import { normalizeSku } from "../core/sku.js";
import { armCacheSummary } from "../core/cache.js";
import { loadPolicyCheck } from "../core/policy.js";
import {
  addJsonCompatibilityOptions,
  addOutputOption,
  isJsonOutput,
  resolveOutputMode,
} from "../core/outputMode.js";
import { scanStorageAvailability, validateStorageTarget } from "../core/storage.js";

export function createPickCommand(): Command {
  const cmd = new Command("pick")
    .description(
      "Pick one region for scripts using a VM SKU, resource types, or a Storage account kind and SKU.",
    )
    .argument("[kindOrSku]", "Canonical kind `vm` or `resource`, or VM SKU shortcut")
    .argument(
      "[target]",
      "VM SKU for `azw pick vm B1s`, or resource list for `azw pick resource storage-account,aks`",
    )
    .option("--sku <sku>", "VM SKU (alternative to positional)")
    .option("--eu", "EU only")
    .option("--us", "US only")
    .option("--asia", "Asia Pacific only")
    .option("--geography <group>", "geographyGroup filter", "all")
    .option("--concurrency <n>", "Parallel ARM calls (default 16)", "16")
    .option("--no-policy", "Skip Azure Policy allowed-location checks")
    .option("--refresh", "Bypass cached ARM location/SKU data")
    .action(async (kindOrSku: string | undefined, target: string | undefined, opts) => {
      if (kindOrSku === "resource") {
        await runPickResourceAction(target, opts);
        return;
      }
      await runPickAction(resolveVmTarget(kindOrSku, target, opts.sku, "pick"), opts);
    });
  addOutputOption(addJsonCompatibilityOptions(cmd, "Emit JSON with the pick"));

  const storage = new Command("storage")
    .description("Pick the first region by name that advertises a Storage account kind and SKU.")
    .requiredOption("--kind <kind>", "Storage account kind (e.g. StorageV2)")
    .requiredOption("--sku <sku>", "Storage SKU (e.g. Standard_ZRS)")
    .option("--eu", "Shortcut for --geography Europe")
    .option("--us", "Shortcut for --geography US")
    .option("--asia", "Shortcut for --geography 'Asia Pacific'")
    .option("--geography <group>", "Filter by geographyGroup", "all")
    .option("--no-policy", "Skip Azure Policy allowed-location checks")
    .option("--refresh", "Bypass cached ARM location data")
    .action(runPickStorageAction);
  addOutputOption(addJsonCompatibilityOptions(storage, "Emit JSON with the Storage pick"));
  cmd.addCommand(storage);
  cmd.hook("preSubcommand", (parent, child) => {
    // The root parser can pass the subcommand as an already parsed operand.
    // Forward shared flags that Commander consumed at the pick level.
    for (const option of child.options) {
      const name = option.attributeName();
      if (parent.getOptionValueSource(name) === "cli") {
        child.setOptionValueWithSource(name, parent.getOptionValue(name), "cli");
      }
    }
  });
  return cmd;
}

async function runPickStorageAction(opts: {
  kind: string;
  sku: string;
  eu?: boolean;
  us?: boolean;
  asia?: boolean;
  geography?: string;
  policy?: boolean;
  refresh?: boolean;
  json?: boolean;
  compact?: boolean;
  output?: string;
}): Promise<void> {
  let jsonErrors = Boolean(opts.json);
  try {
    const mode = resolveOutputMode(opts, { allowValue: true, command: "pick storage" });
    jsonErrors = isJsonOutput(mode);
    const target = validateStorageTarget(opts.kind, opts.sku);
    const geoInput = opts.eu
      ? "eu"
      : opts.us
        ? "us"
        : opts.asia
          ? "asia"
          : (opts.geography ?? "all");
    const geography = resolveGeography(geoInput);
    const all = await listLocations({
      progressLabel: `Picking a region for ${target.accountKind} / ${target.sku}`,
      refresh: Boolean(opts.refresh),
    });
    const locations = filterByGeography(all, geography);
    if (locations.length === 0) {
      throw new ValidationError(`No regions matched geography '${geoInput}'. Try: azw geos`);
    }

    const policy = await loadPolicyCheck({ enabled: opts.policy !== false, required: true });
    const rows = await scanStorageAvailability(target, locations, policy.check);
    rows.sort((a, b) => a.region.localeCompare(b.region));
    const ready = rows.find((row) => row.verdict === "STORAGE_SKU_ADVERTISED");
    if (isJsonOutput(mode)) {
      printJson({
        schemaVersion: 1,
        kind: "pick",
        resourceKind: "storage",
        ...target,
        geography: geography ?? "all",
        confidence: "availability",
        cache: armCacheSummary(),
        policy: policy.summary,
        picked: ready
          ? {
              region: ready.region,
              displayName: ready.displayName,
              geographyGroup: ready.geographyGroup,
              verdict: ready.verdict,
              evidence: { listed: ready.listed, restrictionReasons: ready.restrictionReasons },
              explanation: { code: ready.verdict, reason: ready.reason, hint: null },
            }
          : null,
      });
    } else if (ready) {
      console.log(ready.region);
    } else {
      process.stderr.write(`No qualifying region for ${target.accountKind} / ${target.sku} in the scanned scope.\n`);
    }
    if (!ready) process.exitCode = 1;
  } catch (err) {
    exitWithError(err, jsonErrors);
  }
}

export async function runPickAction(
  rawSku: string | undefined,
  opts: {
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
    const mode = resolveOutputMode(opts, { allowValue: true, command: "pick" });
    jsonErrors = isJsonOutput(mode);
    if (!rawSku) throw new ValidationError("Missing SKU. Try: azw pick vm B1s --eu");
    const sku = normalizeSku(rawSku);

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
    const locations = filterByGeography(all, geo);
    if (locations.length === 0) {
      throw new ValidationError(`No regions matched geography '${geoInput}'.`);
    }

    const concurrency = Math.max(1, parseInt(opts.concurrency ?? "16", 10) || 16);
    const policy = await loadPolicyCheck({
      enabled: opts.policy !== false,
      required: true,
    });
    const { rows: raw } = await scanRegions({
      sku,
      locations,
      concurrency,
      refresh: Boolean(opts.refresh),
      policy: policy.check,
      stopWhen: (r) => r.verdict === "AVAILABLE",
    });
    const sorted = sortVerdicts(raw);
    const ready = sorted.find((r) => r.verdict === "AVAILABLE");

    if (!ready) {
      if (isJsonOutput(mode)) {
        printJson(buildPickPayload(sku, armCacheSummary(), policy.summary, null));
        process.exit(1);
      }
      process.stderr.write(`No region can deploy ${sku} right now.\n`);
      const closest = sorted[0];
      if (closest) {
        process.stderr.write(`Why: ${explainVmVerdict(sku, closest).reason}\n`);
      }
      process.exit(1);
    }

    if (isJsonOutput(mode)) {
      printJson(buildPickPayload(sku, armCacheSummary(), policy.summary, ready));
      return;
    }

    console.log(ready.region);
  } catch (err) {
    exitWithError(err, jsonErrors);
  }
}

/**
 * `azw pick resource storage-account,key-vault --eu` — one script-value
 * region where **every** requested type is `RESOURCE_SUPPORTED`; a single
 * target degenerates to the simple case. The first such region on the stable
 * geography-group-then-name axis wins. Availability confidence only — never
 * deployability.
 */
export async function runPickResourceAction(
  rawTargets: string | undefined,
  opts: {
    eu?: boolean;
    us?: boolean;
    asia?: boolean;
    geography?: string;
    policy?: boolean;
    refresh?: boolean;
    sku?: string;
    json?: boolean;
    compact?: boolean;
    output?: string;
  },
): Promise<void> {
  let jsonErrors = Boolean(opts.json);
  try {
    const mode = resolveOutputMode(opts, { allowValue: true, command: "pick resource" });
    jsonErrors = isJsonOutput(mode);
    if (opts.sku) {
      throw new ValidationError("--sku is VM-only and cannot be combined with resource targets.");
    }
    const targets = parseResourceTargetList(rawTargets ?? "", "pick resource");

    const geoInput = opts.eu
      ? "eu"
      : opts.us
        ? "us"
        : opts.asia
          ? "asia"
          : (opts.geography ?? "all");
    const geo = resolveGeography(geoInput);
    const all = await listLocations({
      progressLabel: `Picking region for ${targets.length} resource type${
        targets.length === 1 ? "" : "s"
      }`,
      etaSeconds: 5,
      refresh: Boolean(opts.refresh),
    });
    const locations = filterByGeography(all, geo);
    if (locations.length === 0) {
      throw new ValidationError(`No regions matched geography '${geoInput}'.`);
    }

    const policy = await loadPolicyCheck({
      enabled: opts.policy !== false,
      required: true,
    });
    const { regionRows, targets: summaries } = await scanCompareResources({
      targets,
      locations,
      refresh: Boolean(opts.refresh),
      policy: policy.check,
    });

    const ready = allSupportedRegionRows(regionRows)[0] ?? null;

    if (!ready) {
      if (isJsonOutput(mode)) {
        printJson(
          buildPickResourcePayload({
            targets,
            resolved: summaries.map((s) => s.resolved),
            cache: armCacheSummary(),
            policy: policy.summary,
            location: null,
          }),
        );
        process.exit(1);
      }
      process.stderr.write("No scanned region advertises every requested resource type.\n");
      const miss = closestMissSummary(summaries);
      if (miss) {
        process.stderr.write(
          `Why: ${compareResourceColumnLabel(miss.target)} is supported in ${miss.supportedCount} of ${regionRows.length} scanned regions.\n`,
        );
      }
      process.exit(1);
    }

    if (isJsonOutput(mode)) {
      printJson(
        buildPickResourcePayload({
          targets,
          resolved: summaries.map((s) => s.resolved),
          cache: armCacheSummary(),
          policy: policy.summary,
          location: ready.location,
        }),
      );
      return;
    }

    console.log(ready.location.name);
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
