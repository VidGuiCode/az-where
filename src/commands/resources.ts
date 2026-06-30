import { Command } from "commander";
import { exitWithError } from "../core/errors.js";
import { printInfo, printJson, printTable } from "../core/output.js";
import { armCacheSummary } from "../core/cache.js";
import { listResourceTypes } from "../core/resources.js";
import {
  addJsonCompatibilityOptions,
  addOutputOption,
  isJsonOutput,
  resolveOutputMode,
} from "../core/outputMode.js";

/**
 * Discovery for the `resource` kind — the catalog companion to `skus`/`geos`.
 * It surfaces the ARM provider catalog that resource scans already download,
 * so users can find a type to feed `availability resource` / `check resource`.
 */
export function createResourcesCommand(): Command {
  const cmd = new Command("resources")
    .description("Discover Azure resource types for `availability resource` / `check resource`.")
    .option("--namespace <ns>", "Filter to one provider namespace (e.g. Microsoft.Storage)")
    .option("--grep <text>", "Only show types whose full resource type contains <text>")
    .option("--refresh", "Bypass cached ARM provider data")
    .option("--name", "Print one resource type per line")
    .action(async (opts) => {
      let jsonErrors = Boolean(opts.json);
      try {
        const mode = resolveOutputMode(opts, { allowName: true, command: "resources" });
        jsonErrors = isJsonOutput(mode);
        const entries = await listResourceTypes({
          namespace: opts.namespace,
          grep: opts.grep,
          refresh: Boolean(opts.refresh),
        });

        if (mode === "name") {
          for (const e of entries) console.log(e.resourceType);
          if (entries.length === 0) process.exit(1);
          return;
        }

        if (isJsonOutput(mode)) {
          printJson({
            schemaVersion: 1,
            kind: "resources",
            namespace: opts.namespace ?? null,
            grep: opts.grep ?? null,
            count: entries.length,
            cache: armCacheSummary(),
            resourceTypes: entries,
          });
          if (entries.length === 0) process.exit(1);
          return;
        }

        if (entries.length === 0) {
          printInfo(
            "No resource types matched. Broaden --namespace/--grep, or retry with --refresh.",
          );
          process.exit(1);
        }
        printInfo("");
        printTable(
          entries.map((e) => [e.alias ?? "—", e.resourceType, String(e.locationCount)]),
          ["ALIAS", "RESOURCE TYPE", "REGIONS"],
        );
        printInfo("");
        printInfo(
          `${entries.length} resource types. Use one with: azw availability resource <type> --eu`,
        );
      } catch (err) {
        exitWithError(err, jsonErrors);
      }
    });
  addOutputOption(addJsonCompatibilityOptions(cmd, "Machine-readable JSON output"));
  return cmd;
}
