import { Command } from "commander";
import { exitWithError } from "../core/errors.js";
import { printInfo, printJson, printTable } from "../core/output.js";
import { listLocations } from "../core/geo.js";
import { armCacheSummary } from "../core/cache.js";

export function createGeosCommand(): Command {
  return new Command("geos")
    .description("List geographyGroup values your subscription sees (used for --geography).")
    .option("--refresh", "Bypass cached ARM location data")
    .option("--json", "Machine-readable JSON output")
    .action(async (opts) => {
      try {
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

        if (opts.json) {
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
        exitWithError(err, Boolean(opts.json));
      }
    });
}
