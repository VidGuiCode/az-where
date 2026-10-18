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

export function createPickCommand(): Command {
  const cmd = new Command("pick")
    .description(
      "Pick one region for scripts. Canonical: `azw pick vm <sku>` / `azw pick resource <types>`.",
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
  return cmd;
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
