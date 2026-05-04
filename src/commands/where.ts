import { Command } from "commander";
import { az } from "../core/az.js";
import { printInfo, printJson } from "../core/output.js";
import { exitWithError } from "../core/errors.js";
import { Spinner } from "../core/progress.js";
import type { AzAccount } from "../core/types.js";
import {
  addJsonCompatibilityOptions,
  addOutputOption,
  isJsonOutput,
  resolveOutputMode,
} from "../core/outputMode.js";

export function createWhereCommand(): Command {
  const cmd = new Command("where")
    .description("Show the current Azure subscription and signed-in identity")
    .action(async (opts) => {
      let jsonErrors = Boolean(opts.json);
      try {
        const mode = resolveOutputMode(opts);
        jsonErrors = isJsonOutput(mode);
        const spinner = new Spinner("Checking Azure account", 3);
        let account: AzAccount;
        try {
          account = await az<AzAccount>(["account", "show"]);
        } finally {
          spinner.done();
        }

        if (isJsonOutput(mode)) {
          printJson({
            schemaVersion: 1,
            kind: "context",
            context: {
              subscription: {
                id: account.id,
                name: account.name,
                tenantId: account.tenantId,
                state: account.state,
              },
              user: {
                name: account.user?.name ?? null,
                type: account.user?.type ?? null,
              },
            },
          });
          return;
        }

        printInfo(`Subscription: ${account.name}  (${account.id})`);
        printInfo(`Tenant:       ${account.tenantId}`);
        printInfo(`User:         ${account.user?.name ?? "-"} (${account.user?.type ?? "-"})`);
        printInfo(`State:        ${account.state}`);
      } catch (err) {
        exitWithError(err, jsonErrors);
      }
    });
  addOutputOption(addJsonCompatibilityOptions(cmd, "Output raw JSON"));
  return cmd;
}
