import { Command } from "commander";
import { armCacheSummary } from "../core/cache.js";
import { exitWithError, ValidationError } from "../core/errors.js";
import { explainResourceVerdict, explainVmVerdict } from "../core/explain.js";
import { listLocations } from "../core/geo.js";
import {
  printJson,
  printTable,
  printVerdictTable,
  renderCheckExplanation,
} from "../core/output.js";
import {
  buildCheckResourcePayload,
  buildCheckVmPayload,
} from "../core/payloads.js";
import {
  addJsonCompatibilityOptions,
  addOutputOption,
  isJsonOutput,
  resolveOutputMode,
} from "../core/outputMode.js";
import { loadPolicyCheck } from "../core/policy.js";
import { scanResourceAvailability } from "../core/resources.js";
import { scanRegions } from "../core/scan.js";
import { normalizeSku } from "../core/sku.js";
import type { ResourceAvailabilityVerdict } from "../core/types.js";

export function createCheckCommand(): Command {
  const cmd = new Command("check").description("Check one target in exactly one Azure region.");

  const vm = new Command("vm")
    .description("Check one VM SKU in one region.")
    .argument("<sku>", "VM SKU (e.g. B1s)")
    .requiredOption("--region <name>", "Azure region name")
    .option("--no-policy", "Skip Azure Policy allowed-location checks")
    .option("--refresh", "Bypass cached ARM location/SKU data")
    .action(async (sku: string, opts) => {
      await runVmCheckAction(sku, opts);
    });
  addOutputOption(addJsonCompatibilityOptions(vm, "Machine-readable JSON output"));

  const resource = new Command("resource")
    .description("Check one generic Azure resource type in one region.")
    .argument("<target>", "Friendly alias or raw Azure resource type")
    .requiredOption("--region <name>", "Azure region name")
    .option("--no-policy", "Skip Azure Policy allowed-location checks")
    .option("--refresh", "Bypass cached ARM location/provider data")
    .action(async (target: string, opts) => {
      await runResourceCheckAction(target, opts);
    });
  addOutputOption(addJsonCompatibilityOptions(resource, "Machine-readable JSON output"));

  cmd.addCommand(vm);
  cmd.addCommand(resource);
  return cmd;
}

async function runVmCheckAction(
  rawSku: string,
  opts: {
    region: string;
    policy?: boolean;
    refresh?: boolean;
    json?: boolean;
    compact?: boolean;
    output?: string;
  },
): Promise<void> {
  let jsonErrors = Boolean(opts.json);
  try {
    const mode = resolveOutputMode(opts, { allowValue: true, command: "check vm" });
    jsonErrors = isJsonOutput(mode);
    const sku = normalizeSku(rawSku);
    const locations = matchRegion(
      await listLocations({
        progressLabel: `Checking ${sku} in ${opts.region}`,
        etaSeconds: 3,
        refresh: Boolean(opts.refresh),
      }),
      opts.region,
    );
    if (locations.length === 0) throw new ValidationError(`Unknown region '${opts.region}'.`);

    const policy = await loadPolicyCheck({
      enabled: opts.policy !== false,
      required: false,
    });
    const { rows } = await scanRegions({
      sku,
      locations,
      concurrency: 1,
      refresh: Boolean(opts.refresh),
      policy: policy.check,
    });
    const row = rows[0];
    const ok = row.verdict === "AVAILABLE";

    if (mode === "value") {
      console.log(row.verdict);
      if (!ok) process.exit(1);
      return;
    }
    if (isJsonOutput(mode)) {
      printJson(buildCheckVmPayload(sku, row, armCacheSummary(), policy.summary));
      if (!ok) process.exit(1);
      return;
    }

    printVerdictTable([row]);
    for (const line of renderCheckExplanation(explainVmVerdict(sku, row))) {
      console.log(line);
    }
    if (!ok) process.exit(1);
  } catch (err) {
    exitWithError(err, jsonErrors);
  }
}

async function runResourceCheckAction(
  target: string,
  opts: {
    region: string;
    policy?: boolean;
    refresh?: boolean;
    json?: boolean;
    compact?: boolean;
    output?: string;
  },
): Promise<void> {
  let jsonErrors = Boolean(opts.json);
  try {
    const mode = resolveOutputMode(opts, { allowValue: true, command: "check resource" });
    jsonErrors = isJsonOutput(mode);
    const locations = matchRegion(
      await listLocations({
        progressLabel: `Checking ${target} in ${opts.region}`,
        etaSeconds: 3,
        refresh: Boolean(opts.refresh),
      }),
      opts.region,
    );
    if (locations.length === 0) throw new ValidationError(`Unknown region '${opts.region}'.`);

    const policy = await loadPolicyCheck({
      enabled: opts.policy !== false,
      required: false,
    });
    const { resolved, rows } = await scanResourceAvailability({
      target,
      locations,
      refresh: Boolean(opts.refresh),
      policy: policy.check,
    });
    if (!resolved.namespace || !resolved.typePath) {
      throw new ValidationError(
        `Unknown resource alias or invalid Azure resource type '${target}'. Try: storage-account or Microsoft.Storage/storageAccounts`,
      );
    }
    const row = rows[0];
    const ok = row.verdict === "RESOURCE_SUPPORTED";

    if (mode === "value") {
      console.log(row.verdict);
      if (!ok) process.exit(1);
      return;
    }
    if (isJsonOutput(mode)) {
      printJson(
        buildCheckResourcePayload(target, resolved, row, armCacheSummary(), policy.summary),
      );
      if (!ok) process.exit(1);
      return;
    }

    printTable(resourceCheckRows([row]), ["REGION", "RESOURCE", "VERDICT", "CONFIDENCE"]);
    for (const line of renderCheckExplanation(explainResourceVerdict(row))) {
      console.log(line);
    }
    if (!ok) process.exit(1);
  } catch (err) {
    exitWithError(err, jsonErrors);
  }
}

function matchRegion(locations: Awaited<ReturnType<typeof listLocations>>, region: string) {
  const normalized = region.trim().toLowerCase();
  return locations.filter((l) => l.name.toLowerCase() === normalized);
}

function resourceCheckRows(rows: ResourceAvailabilityVerdict[]): string[][] {
  return rows.map((r) => [r.region, r.resourceType, r.verdict, r.confidence]);
}
