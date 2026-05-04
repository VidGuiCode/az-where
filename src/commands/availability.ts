import { Command } from "commander";
import { armCacheSummary } from "../core/cache.js";
import { c, colorEnabled } from "../core/color.js";
import { exitWithError, ValidationError } from "../core/errors.js";
import { filterByGeography, listLocations, resolveGeography, shortGeo } from "../core/geo.js";
import { printInfo, printJson, printTable } from "../core/output.js";
import {
  addJsonCompatibilityOptions,
  addOutputOption,
  isJsonOutput,
  resolveOutputMode,
} from "../core/outputMode.js";
import { loadPolicyCheck, type PolicySummary } from "../core/policy.js";
import { scanResourceAvailability } from "../core/resources.js";
import type { ResourceAvailabilityVerdict } from "../core/types.js";
import { runRegionsAction } from "./regions.js";

export function createAvailabilityCommand(): Command {
  const cmd = new Command("availability").description(
    "Canonical availability scans for VMs and generic Azure resources.",
  );

  const vm = new Command("vm")
    .description("Scan where a VM SKU can deploy.")
    .argument("<sku>", "VM SKU (e.g. B1s, Standard_B1s, D2s_v5)")
    .option("--region <name>", "Scope to a single region")
    .option("--eu", "Shortcut for --geography Europe")
    .option("--us", "Shortcut for --geography US")
    .option("--asia", "Shortcut for --geography 'Asia Pacific'")
    .option("--geography <group>", "Filter by geographyGroup", "all")
    .option("--concurrency <n>", "Parallel ARM calls (default 16)", "16")
    .option("--all", "Show every region, including those where the SKU isn't offered")
    .option("--no-policy", "Skip Azure Policy allowed-location checks")
    .option("--refresh", "Bypass cached ARM location/SKU data")
    .option("--name", "Print one deployable region name per line")
    .action(async (sku: string, opts) => {
      await runRegionsAction(sku, opts, "availability");
    });
  addOutputOption(addJsonCompatibilityOptions(vm, "Machine-readable JSON output"));

  const resource = new Command("resource")
    .description("Scan where Azure advertises a resource type.")
    .argument("<target>", "Friendly alias or raw Azure resource type")
    .option("--region <name>", "Scope to a single region")
    .option("--eu", "Shortcut for --geography Europe")
    .option("--us", "Shortcut for --geography US")
    .option("--asia", "Shortcut for --geography 'Asia Pacific'")
    .option("--geography <group>", "Filter by geographyGroup", "all")
    .option("--no-policy", "Skip Azure Policy allowed-location checks")
    .option("--refresh", "Bypass cached ARM location/provider data")
    .option("--name", "Print one supported region name per line")
    .action(async (target: string, opts) => {
      await runResourceAvailabilityAction(target, opts);
    });
  addOutputOption(addJsonCompatibilityOptions(resource, "Machine-readable JSON output"));

  cmd.addCommand(vm);
  cmd.addCommand(resource);
  return cmd;
}

export async function runResourceAvailabilityAction(
  target: string,
  opts: {
    region?: string;
    eu?: boolean;
    us?: boolean;
    asia?: boolean;
    geography?: string;
    policy?: boolean;
    refresh?: boolean;
    json?: boolean;
    compact?: boolean;
    name?: boolean;
    output?: string;
  },
): Promise<void> {
  let jsonErrors = Boolean(opts.json);
  try {
    const mode = resolveOutputMode(opts, { allowName: true });
    jsonErrors = isJsonOutput(mode);
    if (!target.trim()) {
      throw new ValidationError(
        "Missing resource. Try: azw availability resource storage-account --eu",
      );
    }
    if (opts.region) validateRegionScope(opts);

    const geoInput = opts.eu
      ? "eu"
      : opts.us
        ? "us"
        : opts.asia
          ? "asia"
          : (opts.geography ?? "all");
    const geo = resolveGeography(geoInput);
    const allLocations = await listLocations({
      progressLabel: `Checking resource availability for ${target}`,
      etaSeconds: 5,
      refresh: Boolean(opts.refresh),
    });
    const locations = opts.region
      ? matchRegion(allLocations, opts.region)
      : filterByGeography(allLocations, geo);
    if (locations.length === 0) {
      throw new ValidationError(
        opts.region
          ? `Unknown region '${opts.region}'. Try: azw geos`
          : `No regions matched geography '${geoInput}'. Try: azw geos`,
      );
    }

    const policy = await loadPolicyCheck({
      enabled: opts.policy !== false,
      required: false,
    });
    const { resolved, rows, elapsedMs } = await scanResourceAvailability({
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
    const supported = rows.filter((r) => r.verdict === "RESOURCE_SUPPORTED");
    const ok = supported.length > 0;

    if (mode === "name") {
      for (const r of supported) console.log(r.region);
      if (!ok) process.exit(1);
      return;
    }

    if (isJsonOutput(mode)) {
      printJson({
        schemaVersion: 1,
        kind: "availability",
        resourceKind: "resource",
        target,
        resolved,
        confidence: "availability",
        geography: opts.region ? null : (geo ?? "all"),
        region: opts.region ? locations[0].name : null,
        scannedAt: new Date().toISOString(),
        elapsedMs,
        cache: armCacheSummary(),
        policy: policy.summary,
        regions: rows,
      });
      if (!ok) process.exit(1);
      return;
    }

    printPolicyWarning(policy.summary);
    printTable(resourceRows(rows), ["REGION", "GEO", "LOCATION", "VERDICT", "CONFIDENCE"]);
    const hidden = rows.filter((r) => r.verdict === "RESOURCE_NOT_SUPPORTED").length;
    if (hidden > 0) {
      const note = `${supported.length} supported, ${hidden} not advertised for ${resolved.resourceType}.`;
      printInfo(colorEnabled() ? c.dim(note) : note);
    }
    if (!ok) process.exit(1);
  } catch (err) {
    exitWithError(err, jsonErrors);
  }
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

function resourceRows(rows: ResourceAvailabilityVerdict[]): string[][] {
  return rows.map((r) => [
    r.region,
    shortGeo(r.geographyGroup),
    r.physicalLocation ?? r.displayName,
    r.verdict,
    r.confidence,
  ]);
}

function printPolicyWarning(policy: PolicySummary): void {
  if (!policy.error) return;
  process.stderr.write(`Azure Policy was not checked: ${policy.error}\n`);
}
