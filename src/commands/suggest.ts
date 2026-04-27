import { Command } from "commander";
import { armCacheSummary } from "../core/cache.js";
import { exitWithError, ValidationError } from "../core/errors.js";
import { filterByGeography, listLocations, resolveGeography } from "../core/geo.js";
import { printInfo, printJson } from "../core/output.js";
import { scanRegions, sortVerdicts } from "../core/scan.js";
import { normalizeSku } from "../core/sku.js";
import { chooseSuggestion, knownPlaces, resolvePlace } from "../core/suggest.js";

export function createSuggestCommand(): Command {
  return new Command("suggest")
    .description("Suggest one deployable region and explain why it was chosen.")
    .argument("[sku]", "VM SKU (e.g. B1s)")
    .option("--sku <sku>", "VM SKU (alternative to positional)")
    .option("--eu", "EU only")
    .option("--us", "US only")
    .option("--asia", "Asia Pacific only")
    .option("--geography <group>", "geographyGroup filter", "all")
    .option("--near <city>", "Prefer regions near a known city, e.g. Luxembourg")
    .option("--concurrency <n>", "Parallel ARM calls (default 16)", "16")
    .option("--refresh", "Bypass cached ARM location/SKU data")
    .option("--json", "Machine-readable JSON output")
    .action(async (positional: string | undefined, opts) => {
      try {
        const rawSku = opts.sku ?? positional;
        if (!rawSku) throw new ValidationError("Missing SKU. Try: azw suggest B1s --eu");
        const sku = normalizeSku(rawSku);

        const nearInput = opts.near ? String(opts.near) : "";
        const near = nearInput ? resolvePlace(nearInput) : null;
        if (nearInput && !near) {
          throw new ValidationError(
            `Unknown --near city '${nearInput}'. Known values: ${knownPlaces().join(", ")}`,
          );
        }

        const geoInput = opts.eu ? "eu" : opts.us ? "us" : opts.asia ? "asia" : opts.geography;
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

        const concurrency = Math.max(1, parseInt(opts.concurrency, 10) || 16);
        const { rows: raw, elapsedMs } = await scanRegions({
          sku,
          locations,
          concurrency,
          refresh: Boolean(opts.refresh),
        });
        const rows = sortVerdicts(raw);
        const suggestion = chooseSuggestion(rows, near);

        if (!suggestion) {
          if (opts.json) {
            printJson({
              schemaVersion: 1,
              kind: "suggest",
              sku,
              geography: geo ?? "all",
              near: nearInput || null,
              elapsedMs,
              cache: armCacheSummary(),
              suggested: null,
            });
            process.exit(1);
          }
          process.stderr.write(`No region can deploy ${sku} right now.\n`);
          process.exit(1);
        }

        if (opts.json) {
          printJson({
            schemaVersion: 1,
            kind: "suggest",
            sku,
            geography: geo ?? "all",
            near: nearInput || null,
            elapsedMs,
            cache: armCacheSummary(),
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
        printInfo(suggestion.reason);
      } catch (err) {
        exitWithError(err, Boolean(opts.json));
      }
    });
}
