import { Command } from "commander";
import { exitWithError, ValidationError } from "../core/errors.js";
import { printFooter, printInfo, printJson, printVerdictTable } from "../core/output.js";
import { filterByGeography, listLocations, resolveGeography } from "../core/geo.js";
import { scanRegions, sortVerdicts } from "../core/scan.js";
import { normalizeSku } from "../core/sku.js";
import { c, colorEnabled } from "../core/color.js";
import { armCacheSummary } from "../core/cache.js";
import { loadPolicyCheck, type PolicySummary } from "../core/policy.js";

export function createQuotaCommand(): Command {
  return new Command("quota")
    .description(
      "vCPU headroom lens: only regions where the SKU is actually offered. Use `regions` for the full availability picture.",
    )
    .argument("[sku]", "VM SKU (e.g. B1s)")
    .option("--sku <sku>", "VM SKU (alternative to positional)")
    .option("--eu", "EU only")
    .option("--us", "US only")
    .option("--asia", "Asia Pacific only")
    .option("--geography <group>", "geographyGroup filter", "all")
    .option("--concurrency <n>", "Parallel ARM calls (default 16)", "16")
    .option("--all", "Also include regions where the SKU isn't offered or your sub is blocked")
    .option("--no-policy", "Skip Azure Policy allowed-location checks")
    .option("--refresh", "Bypass cached ARM location/SKU data")
    .option("--json", "Machine-readable JSON output")
    .action(async (positional: string | undefined, opts) => {
      try {
        const rawSku = opts.sku ?? positional;
        if (!rawSku) throw new ValidationError("Missing SKU. Try: azw quota B1s --eu");
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
          required: false,
        });
        const { rows: raw, elapsedMs } = await scanRegions({
          sku,
          locations,
          concurrency,
          refresh: Boolean(opts.refresh),
          policy: policy.check,
        });

        // Sort by free vCPU desc, then fall back to default verdict order.
        const sorted = sortVerdicts(raw).sort((a, b) => {
          const af = a.free ?? -Infinity;
          const bf = b.free ?? -Infinity;
          return bf - af;
        });

        // `quota` is the capacity lens — by default drop rows where the
        // question doesn't apply (SKU not offered, subscription blocked).
        // `regions` is still the right command for the full availability
        // picture; `--all` here opts into it explicitly.
        const rows = opts.all
          ? sorted
          : sorted.filter((r) => r.skuOffered || r.verdict === "POLICY_DENIED");
        const dropped = sorted.length - rows.length;
        const deployable = rows.some((r) => r.verdict === "AVAILABLE");

        if (opts.json) {
          printJson({
            schemaVersion: 1,
            kind: "quota",
            sku,
            geography: geo ?? "all",
            scannedAt: new Date().toISOString(),
            elapsedMs,
            cache: armCacheSummary(),
            policy: policy.summary,
            regions: rows,
          });
          if (!deployable) process.exit(1);
          return;
        }

        if (rows.length === 0) {
          printPolicyWarning(policy.summary);
          const msg = `No regions in ${geo ?? "scope"} offer ${sku}. Try: azw regions ${sku}${geo ? ` --geography ${geo}` : ""}`;
          printInfo(msg);
        } else {
          printPolicyWarning(policy.summary);
          printVerdictTable(rows);
          if (dropped > 0) {
            const note = `+ ${dropped} regions hidden (not offered or subscription-blocked; --all to show)`;
            printInfo(colorEnabled() ? c.dim(note) : note);
          }
        }
        printFooter(sorted, elapsedMs, sku);
        if (!deployable) process.exit(1);
      } catch (err) {
        exitWithError(err, Boolean(opts.json));
      }
    });
}

function printPolicyWarning(policy: PolicySummary): void {
  if (!policy.error) return;
  process.stderr.write(`Azure Policy was not checked: ${policy.error}\n`);
}
