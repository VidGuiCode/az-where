import { Command } from "commander";
import { checkForUpdate, normalizeTag } from "../core/updateCheck.js";
import { printInfo, printJson } from "../core/output.js";
import { c, colorEnabled } from "../core/color.js";
import { exitWithError } from "../core/errors.js";
import { Spinner } from "../core/progress.js";

/**
 * `azw update` — discoverable surface for the version banner. Prints the
 * latest published tag alongside copy-pasteable install commands for
 * bash/zsh and PowerShell. Deliberately does NOT run the install itself:
 * global npm installs touch system directories, often need elevation, and
 * hiding that behind a subcommand is a great way to surprise people. The
 * user copies the command and runs it — transparent, boring, safe.
 */
export function createUpdateCommand(
  currentVersion: string,
): Command {
  return new Command("update")
    .description("Check for a newer az-where release and print install commands.")
    .option("--json", "Machine-readable JSON output")
    .option("--no-update-check", "(ignored here — this command *is* the update check)")
    .action(async (opts) => {
      try {
        const spinner = new Spinner("Checking latest release", 2);
        let status: Awaited<ReturnType<typeof checkForUpdate>>;
        try {
          status = await checkForUpdate(currentVersion);
        } finally {
          spinner.done();
        }
        const current = status.currentVersion;
        const latest = status.latestVersion;

        if (opts.json) {
          printJson({
            schemaVersion: 1,
            kind: "update",
            currentVersion: current,
            latestVersion: latest,
            behind: status.behind,
            installCommands: latest ? installCommands(latest) : null,
          });
          return;
        }

        if (!latest) {
          printInfo(
            `Couldn't reach GitHub to check for updates (you're on ${current}). Try again later, or browse releases at https://github.com/VidGuiCode/az-where/releases.`,
          );
          return;
        }

        if (!status.behind) {
          const msg = `You're up to date (${current} is the latest release).`;
          printInfo(colorEnabled() ? c.green(msg) : msg);
          return;
        }

        const header = `Update available: ${current} → ${latest}`;
        printInfo(colorEnabled() ? c.bold(header) : header);
        printInfo("");
        printInfo("  Pinned tarball (recommended):");
        printInfo(`    ${installCommands(latest).pinned}`);
        printInfo("");
        printInfo("  PowerShell — always-latest via gh:");
        printInfo(`    ${installCommands(latest).powershell}`);
        printInfo("");
        printInfo("  bash / zsh — always-latest via gh:");
        printInfo(`    ${installCommands(latest).bash}`);
        printInfo("");
        const tip =
          "Silence the banner on every call: set AZ_WHERE_NO_UPDATE_CHECK=1 or pass --no-update-check.";
        printInfo(colorEnabled() ? c.dim(tip) : tip);
      } catch (err) {
        exitWithError(err, Boolean(opts.json));
      }
    });
}

/**
 * Shape the three install commands. Kept in one place so the `--json`
 * shape and the human output stay in lockstep.
 */
function installCommands(latestTag: string): {
  pinned: string;
  bash: string;
  powershell: string;
} {
  const v = normalizeTag(latestTag);
  return {
    pinned: `npm install -g https://github.com/VidGuiCode/az-where/releases/download/v${v}/az-where-${v}.tgz`,
    bash: `npm install -g "$(gh release view --repo VidGuiCode/az-where --json assets -q '.assets[0].url')"`,
    powershell: `$url = gh release view --repo VidGuiCode/az-where --json assets -q '.assets[0].url'; npm install -g $url`,
  };
}
