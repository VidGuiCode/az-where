import { Command } from "commander";
import { exitWithError, ValidationError } from "../core/errors.js";
import { printJson } from "../core/output.js";
import { filterByGeography, listLocations, resolveGeography } from "../core/geo.js";
import { scanRegions, sortVerdicts } from "../core/scan.js";
import { normalizeSku } from "../core/sku.js";
import { armCacheSummary } from "../core/cache.js";
import { loadPolicyCheck } from "../core/policy.js";

export function createPickCommand(): Command {
  return new Command("pick")
    .description("Print one region where the SKU is ready to deploy. For `terraform apply -var`.")
    .argument("[sku]", "VM SKU (e.g. B1s)")
    .option("--sku <sku>", "VM SKU (alternative to positional)")
    .option("--eu", "EU only")
    .option("--us", "US only")
    .option("--asia", "Asia Pacific only")
    .option("--geography <group>", "geographyGroup filter", "all")
    .option("--concurrency <n>", "Parallel ARM calls (default 16)", "16")
    .option("--no-policy", "Skip Azure Policy allowed-location checks")
    .option("--refresh", "Bypass cached ARM location/SKU data")
    .option("--json", "Emit JSON with the pick")
    .action(async (positional: string | undefined, opts) => {
      try {
        const rawSku = opts.sku ?? positional;
        if (!rawSku) throw new ValidationError("Missing SKU. Try: azw pick B1s --eu");
        const sku = normalizeSku(rawSku);

        const geoInput = opts.eu ? "eu" : opts.us ? "us" : opts.asia ? "asia" : opts.geography;
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

        const concurrency = Math.max(1, parseInt(opts.concurrency, 10) || 16);
        const policy = await loadPolicyCheck({
          enabled: opts.policy !== false,
          required: true,
        });
        // Stop the scan as soon as any region comes back AVAILABLE — `pick` only
        // needs one. In-flight calls still resolve (can't kill an open fetch
        // mid-body), but no new regions get queued.
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
          if (opts.json) {
            printJson({
              schemaVersion: 1,
              kind: "pick",
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

        if (opts.json) {
          printJson({
            schemaVersion: 1,
            kind: "pick",
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

        // Plain region name — pipe-friendly, the whole point of `pick`.
        console.log(ready.region);
      } catch (err) {
        exitWithError(err, Boolean(opts.json));
      }
    });
}
