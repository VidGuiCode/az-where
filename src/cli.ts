#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { createWhereCommand } from "./commands/where.js";
import { createRegionsCommand } from "./commands/regions.js";
import { createPickCommand } from "./commands/pick.js";
import { createQuotaCommand } from "./commands/quota.js";
import { createGeosCommand } from "./commands/geos.js";
import { createSkusCommand } from "./commands/skus.js";
import { configureHelp } from "./core/help.js";
import { c, colorEnabled } from "./core/color.js";
import { looksLikeSku, normalizeSku } from "./core/sku.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

function splash(version: string): string {
  const title = colorEnabled() ? c.cyan(c.bold("az-where")) : "az-where";
  const tag = colorEnabled() ? c.dim(`v${version}`) : `v${version}`;
  const auth = colorEnabled()
    ? c.dim("Requires: az login  (auth is delegated to the Azure CLI)")
    : "Requires: az login  (auth is delegated to the Azure CLI)";
  return `
  ${title}  ${tag}
  Unofficial CLI: where in Azure can I actually deploy this?
  ${auth}

  ${colorEnabled() ? c.bold("Quickest path:") : "Quickest path:"}
    azw B1s --eu              Coloured table of EU regions for Standard_B1s
    azw pick B1s --eu         One region name (for terraform / scripts)
    azw quota D2s_v5          vCPU headroom, sorted by free capacity
    azw where                 Current Azure subscription / user
    azw geos                  Discover what --geography values your sub sees
    azw skus --eu --family B  Discover VM SKU names (family, vCPU, RAM)
`;
}

/**
 * Positional-SKU shorthand: `azw B1s ...` rewrites to `azw regions B1s ...`
 * so the golden path is as short as possible. Verbs still win if the first
 * arg is a known verb name — we only rewrite when the token looks like a
 * VM size and isn't already a registered command.
 */
function rewritePositionalSku(argv: string[], verbs: Set<string>): string[] {
  // argv = [node, script, first, ...rest]
  if (argv.length < 3) return argv;
  const first = argv[2];
  if (!first || first.startsWith("-")) return argv;
  if (verbs.has(first)) return argv;
  if (!looksLikeSku(first)) return argv;
  return [...argv.slice(0, 2), "regions", normalizeSku(first), ...argv.slice(3)];
}

const program = new Command();

program
  .name("az-where")
  .description("Unofficial CLI that answers 'where in Azure can I actually deploy this?'")
  // --json is declared per-subcommand; declaring it here too makes Commander
  // route the flag to the parent and leave `opts.json` undefined on the action.
  // --compact and --no-interactive are consumed directly via hasArg() in
  // runtime.ts, so they don't need a Commander declaration either.
  .version(pkg.version)
  .helpCommand(true)
  .action(() => {
    process.stdout.write(splash(pkg.version) + "\n");
    program.help();
  });

program.addCommand(createWhereCommand());
program.addCommand(createRegionsCommand());
program.addCommand(createPickCommand());
program.addCommand(createQuotaCommand());
program.addCommand(createGeosCommand());
program.addCommand(createSkusCommand());

configureHelp(program);

const verbs = new Set<string>(program.commands.map((cmd) => cmd.name()));
const argv = rewritePositionalSku(process.argv, verbs);

program.parseAsync(argv);
