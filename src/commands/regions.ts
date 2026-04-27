import { Command } from "commander";
import { exitWithError, ValidationError } from "../core/errors.js";
import { printFooter, printInfo, printJson, printVerdictTable } from "../core/output.js";
import { filterByGeography, listLocations, resolveGeography } from "../core/geo.js";
import { scanRegions, sortVerdicts } from "../core/scan.js";
import { normalizeSku } from "../core/sku.js";
import { c, colorEnabled } from "../core/color.js";

export function createRegionsCommand(): Command {
  return new Command("regions")
    .description("Where can I deploy this VM SKU? Scans regions in parallel and prints a verdict.")
    .argument("[sku]", "VM SKU (e.g. B1s, Standard_B1s, D2s_v5)")
    .option("--sku <sku>", "VM SKU (alternative to positional argument)")
    .option("--eu", "Shortcut for --geography Europe")
    .option("--us", "Shortcut for --geography US")
    .option("--asia", "Shortcut for --geography 'Asia Pacific'")
    .option(
      "--geography <group>",
      "Filter by geographyGroup (eu, us, asia, or an exact group)",
      "all",
    )
    .option("--concurrency <n>", "Parallel ARM calls (default 16)", "16")
    .option("--all", "Show every region, including those where the SKU isn't offered")
    .option("--json", "Machine-readable JSON output")
    .option("--name", "Print one region name per line (for scripting)")
    .action(async (positional: string | undefined, opts) => {
      try {
        const rawSku = opts.sku ?? positional;
        if (!rawSku) throw new ValidationError("Missing SKU. Try: azw B1s --eu");
        const sku = normalizeSku(rawSku);

        const geoInput = opts.eu ? "eu" : opts.us ? "us" : opts.asia ? "asia" : opts.geography;
        const geo = resolveGeography(geoInput);

        const all = await listLocations({ progressLabel: `Scanning for ${sku}`, etaSeconds: 5 });
        const locations = filterByGeography(all, geo);

        if (locations.length === 0) {
          throw new ValidationError(`No regions matched geography '${geoInput}'. Try: azw geos`);
        }

        const concurrency = Math.max(1, parseInt(opts.concurrency, 10) || 16);
        const { rows: raw, elapsedMs } = await scanRegions({ sku, locations, concurrency });
        const rows = sortVerdicts(raw);

        if (opts.name) {
          const ready = rows.filter((r) => r.verdict === "AVAILABLE");
          for (const r of ready) console.log(r.region);
          if (ready.length === 0) process.exit(1);
          return;
        }

        const deployable = rows.some((r) => r.verdict === "AVAILABLE");

        if (opts.json) {
          printJson({
            schemaVersion: 1,
            kind: "regions",
            sku,
            geography: geo ?? "all",
            scannedAt: new Date().toISOString(),
            elapsedMs,
            regions: rows,
          });
          if (!deployable) process.exit(1);
          return;
        }

        const hidden = opts.all ? [] : rows.filter((r) => r.verdict === "SKU_NOT_OFFERED");
        const visible = opts.all ? rows : rows.filter((r) => r.verdict !== "SKU_NOT_OFFERED");
        printVerdictTable(visible);
        if (hidden.length > 0) {
          const note = `+ ${hidden.length} regions where Azure doesn't offer ${sku} (use --all to show)`;
          printInfo(colorEnabled() ? c.dim(note) : note);
        }
        printFooter(rows, elapsedMs, sku);
        // Same exit-code contract as `pick`: zero AVAILABLE means the scan
        // answered the user's question with "nowhere", and `$?` should
        // reflect that for shell pipelines.
        if (!deployable) process.exit(1);
      } catch (err) {
        exitWithError(err, Boolean(opts.json));
      }
    });
}
