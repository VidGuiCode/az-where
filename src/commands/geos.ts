import { Command } from "commander";
import { exitWithError } from "../core/errors.js";
import { printInfo, printJson, printTable } from "../core/output.js";
import { listLocations } from "../core/geo.js";
import { armCacheSummary } from "../core/cache.js";
import {
  addJsonCompatibilityOptions,
  addOutputOption,
  isJsonOutput,
  resolveOutputMode,
} from "../core/outputMode.js";

export function createGeosCommand(): Command {
  const cmd = new Command("geos")
    .description("List geographyGroup values your subscription sees (used for --geography).")
    .option("--refresh", "Bypass cached ARM location data")
    .action(async (opts) => {
      let jsonErrors = Boolean(opts.json);
      try {
        const mode = resolveOutputMode(opts, { command: "geos" });
        jsonErrors = isJsonOutput(mode);
        const locations = await listLocations({
          progressLabel: "Fetching Azure regions",
          etaSeconds: 5,
          refresh: Boolean(opts.refresh),
        });
        const groups = new Map<string, number>();
        for (const l of locations) {
          const g = l.metadata?.geographyGroup ?? "(unknown)";
          groups.set(g, (groups.get(g) ?? 0) + 1);
        }

        const entries = [...groups.entries()].sort((a, b) => b[1] - a[1]);

        if (isJsonOutput(mode)) {
          printJson({
            schemaVersion: 1,
            kind: "geos",
            cache: armCacheSummary(),
            groups: entries.map(([name, count]) => ({ name, regionCount: count })),
          });
          return;
        }

        printInfo("");
        printTable(
          entries.map(([name, count]) => [name, String(count)]),
          ["GEOGRAPHY GROUP", "REGIONS"],
        );
        printInfo("");
        printInfo("Use any of these with --geography, or the shortcuts --eu / --us / --asia.");
      } catch (err) {
        exitWithError(err, jsonErrors);
      }
    });
  addOutputOption(addJsonCompatibilityOptions(cmd, "Machine-readable JSON output"));
  return cmd;
}
