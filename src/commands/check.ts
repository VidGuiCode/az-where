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
import { checkPostgresSku, validatePostgresTarget } from "../core/postgres.js";
import { scanResourceAvailability } from "../core/resources.js";
import { scanRegions } from "../core/scan.js";
import { normalizeSku } from "../core/sku.js";
import { scanStorageAvailability, validateStorageTarget } from "../core/storage.js";
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

  const storage = new Command("storage")
    .description("Check a Storage account kind and SKU in one region.")
    .requiredOption("--kind <kind>", "Storage account kind (e.g. StorageV2)")
    .requiredOption("--sku <sku>", "Storage SKU (e.g. Standard_ZRS)")
    .requiredOption("--region <name>", "Azure region name")
    .option("--no-policy", "Skip Azure Policy allowed-location checks")
    .option("--refresh", "Bypass cached ARM location data")
    .action(runStorageCheckAction);
  addOutputOption(addJsonCompatibilityOptions(storage, "Machine-readable JSON output"));

  const postgres = new Command("postgres")
    .description("Check a PostgreSQL Flexible Server compute tier and SKU in one region.")
    .requiredOption("--tier <tier>", "PostgreSQL compute tier (e.g. GeneralPurpose)")
    .requiredOption("--sku <sku>", "PostgreSQL compute SKU (e.g. Standard_D2ds_v5)")
    .requiredOption("--region <name>", "Azure region name")
    .option("--no-policy", "Skip Azure Policy allowed-location checks")
    .option("--refresh", "Bypass cached ARM location data")
    .action(runPostgresCheckAction);
  addOutputOption(addJsonCompatibilityOptions(postgres, "Machine-readable JSON output"));

  cmd.addCommand(vm);
  cmd.addCommand(resource);
  cmd.addCommand(storage);
  cmd.addCommand(postgres);
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

async function runStorageCheckAction(opts: {
  kind: string;
  sku: string;
  region: string;
  policy?: boolean;
  refresh?: boolean;
  json?: boolean;
  compact?: boolean;
  output?: string;
}): Promise<void> {
  let jsonErrors = Boolean(opts.json);
  try {
    const mode = resolveOutputMode(opts, { allowValue: true, command: "check storage" });
    jsonErrors = isJsonOutput(mode);
    const target = validateStorageTarget(opts.kind, opts.sku);
    const { accountKind, sku } = target;
    if (!opts.region.trim()) throw new ValidationError("Provide an Azure region name.");
    const [location] = matchRegion(
      await listLocations({
        progressLabel: `Checking ${sku} in ${opts.region}`,
        refresh: Boolean(opts.refresh),
      }),
      opts.region,
    );
    if (!location) throw new ValidationError(`Unknown region '${opts.region}'.`);

    const policy = await loadPolicyCheck({ enabled: opts.policy !== false, required: false });
    const [{ verdict, listed, restrictionReasons, reason }] = await scanStorageAvailability(
      target,
      [location],
      policy.check,
    );
    if (mode === "value") {
      console.log(verdict);
    } else if (isJsonOutput(mode)) {
      printJson({
        schemaVersion: 1,
        kind: "check",
        resourceKind: "storage",
        accountKind,
        sku,
        region: location.name,
        verdict,
        confidence: "availability",
        cache: armCacheSummary(),
        policy: policy.summary,
        evidence: { listed, restrictionReasons },
        explanation: { code: verdict, reason, hint: null },
      });
    } else {
      printTable(
        [[location.name, accountKind, sku, verdict]],
        ["REGION", "ACCOUNT KIND", "SKU", "VERDICT"],
      );
      console.log(`Reason: ${reason}`);
      console.log("Confidence: availability. Account quota and live capacity were not checked.");
      if (!policy.summary.checked) {
        console.log(`Policy: unchecked${policy.summary.error ? ` (${policy.summary.error})` : ""}.`);
      }
    }
    if (verdict !== "STORAGE_SKU_ADVERTISED") process.exitCode = 1;
  } catch (err) {
    exitWithError(err, jsonErrors);
  }
}

function matchRegion(locations: Awaited<ReturnType<typeof listLocations>>, region: string) {
  const normalized = region.trim().toLowerCase();
  return locations.filter((l) => l.name.toLowerCase() === normalized);
}

async function runPostgresCheckAction(opts: {
  tier: string;
  sku: string;
  region: string;
  policy?: boolean;
  refresh?: boolean;
  json?: boolean;
  compact?: boolean;
  output?: string;
}): Promise<void> {
  let jsonErrors = Boolean(opts.json);
  try {
    const mode = resolveOutputMode(opts, { allowValue: true, command: "check postgres" });
    jsonErrors = isJsonOutput(mode);
    const target = validatePostgresTarget(opts.tier, opts.sku);
    if (!opts.region.trim()) throw new ValidationError("Provide an Azure region name.");
    const [location] = matchRegion(
      await listLocations({
        progressLabel: `Checking ${target.sku} in ${opts.region}`,
        refresh: Boolean(opts.refresh),
      }),
      opts.region,
    );
    if (!location) throw new ValidationError(`Unknown region '${opts.region}'.`);

    const policy = await loadPolicyCheck({ enabled: opts.policy !== false, required: false });
    const { verdict, evidence, reason } = await checkPostgresSku(target, location.name, policy.check);
    if (mode === "value") {
      console.log(verdict);
    } else if (isJsonOutput(mode)) {
      printJson({
        schemaVersion: 1,
        kind: "check",
        resourceKind: "postgres",
        ...target,
        region: location.name,
        verdict,
        confidence: "availability",
        cache: armCacheSummary(),
        policy: policy.summary,
        evidence,
        explanation: { code: verdict, reason, hint: null },
      });
    } else {
      printTable(
        [[location.name, target.tier, target.sku, verdict]],
        ["REGION", "COMPUTE TIER", "SKU", "VERDICT"],
      );
      console.log(`Reason: ${reason}`);
      console.log("Confidence: availability. HA, zones, quota and live capacity were not checked.");
      if (!policy.summary.checked) {
        console.log(`Policy: unchecked${policy.summary.error ? ` (${policy.summary.error})` : ""}.`);
      }
    }
    if (verdict !== "POSTGRES_SKU_ADVERTISED") process.exitCode = 1;
  } catch (err) {
    exitWithError(err, jsonErrors);
  }
}

function resourceCheckRows(rows: ResourceAvailabilityVerdict[]): string[][] {
  return rows.map((r) => [r.region, r.resourceType, r.verdict, r.confidence]);
}
