import { Command } from "commander";
import { exitWithError, ValidationError } from "../core/errors.js";
import { printJson } from "../core/output.js";
import { filterByGeography, listLocations, resolveGeography } from "../core/geo.js";
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
    .description("Print one region where the SKU is ready to deploy. For `terraform apply -var`.")
    .argument("[kindOrSku]", "VM SKU, or kind for canonical syntax (`vm`)")
    .argument("[target]", "VM SKU when using canonical syntax (`azw pick vm B1s`)")
    .option("--sku <sku>", "VM SKU (alternative to positional)")
    .option("--eu", "EU only")
    .option("--us", "US only")
    .option("--asia", "Asia Pacific only")
    .option("--geography <group>", "geographyGroup filter", "all")
    .option("--concurrency <n>", "Parallel ARM calls (default 16)", "16")
    .option("--no-policy", "Skip Azure Policy allowed-location checks")
    .option("--refresh", "Bypass cached ARM location/SKU data")
    .action(async (kindOrSku: string | undefined, target: string | undefined, opts) => {
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
    const mode = resolveOutputMode(opts, { allowValue: true });
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
    const ready = sortVerdicts(raw).find((r) => r.verdict === "AVAILABLE");

    if (!ready) {
      if (isJsonOutput(mode)) {
        printJson({
          schemaVersion: 1,
          kind: "pick",
          resourceKind: "vm",
          sku,
          cache: armCacheSummary(),
          policy: policy.summary,
          picked: null,
        });
        process.exit(1);
      }
      process.stderr.write(`No region can deploy ${sku} right now.\n`);
      process.exit(1);
    }

    if (isJsonOutput(mode)) {
      printJson({
        schemaVersion: 1,
        kind: "pick",
        resourceKind: "vm",
        sku,
        cache: armCacheSummary(),
        policy: policy.summary,
        picked: {
          region: ready.region,
          displayName: ready.displayName,
          geographyGroup: ready.geographyGroup ?? null,
          free: ready.free,
          limit: ready.limit,
        },
      });
      return;
    }

    console.log(ready.region);
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
