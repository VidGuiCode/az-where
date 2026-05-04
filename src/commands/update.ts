import { Command } from "commander";
import { checkForUpdate, normalizeTag } from "../core/updateCheck.js";
import { printInfo, printJson } from "../core/output.js";
import { c, colorEnabled } from "../core/color.js";
import { exitWithError } from "../core/errors.js";
import { Spinner } from "../core/progress.js";
import { confirm } from "../core/prompt.js";
import { isNonInteractiveMode } from "../core/runtime.js";
import { installCommands, installRelease } from "../core/updateInstall.js";
import {
  addJsonCompatibilityOptions,
  addOutputOption,
  isJsonOutput,
  resolveOutputMode,
} from "../core/outputMode.js";

/**
 * `azw update` - discoverable surface for the version banner. It checks the
 * latest published tag and, in an interactive terminal, asks before running
 * the npm global install command. JSON/non-interactive modes stay read-only.
 */
export function createUpdateCommand(currentVersion: string): Command {
  const cmd = new Command("update")
    .description("Check for a newer az-where release and ask before installing it.")
    .option("--no-update-check", "(ignored here - this command is the update check)")
    .action(async (opts) => {
      let jsonErrors = Boolean(opts.json);
      try {
        const mode = resolveOutputMode(opts);
        jsonErrors = isJsonOutput(mode);
        await runUpdateFlow(currentVersion, {
          forceRefresh: true,
          json: isJsonOutput(mode),
          promptInstall: true,
          quietWhenCurrent: false,
        });
      } catch (err) {
        exitWithError(err, jsonErrors);
      }
    });
  addOutputOption(addJsonCompatibilityOptions(cmd, "Machine-readable JSON output"));
  return cmd;
}

export async function runUpdateFlow(
  currentVersion: string,
  opts: {
    forceRefresh?: boolean;
    json?: boolean;
    promptInstall?: boolean;
    quietOnFailure?: boolean;
    quietWhenCurrent?: boolean;
  } = {},
): Promise<void> {
  const spinner = opts.json ? null : new Spinner("Checking latest release", 2);
  let status: Awaited<ReturnType<typeof checkForUpdate>>;
  try {
    status = await checkForUpdate(currentVersion, { forceRefresh: opts.forceRefresh });
  } finally {
    spinner?.done();
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
    if (opts.quietOnFailure) return;
    printInfo(
      `Couldn't reach GitHub to check for updates (you're on ${current}). Try again later, or browse releases at https://github.com/VidGuiCode/az-where/releases.`,
    );
    return;
  }

  if (!status.behind) {
    if (!opts.quietWhenCurrent) {
      const msg = `You're up to date (${current} is the latest release).`;
      printInfo(colorEnabled() ? c.green(msg) : msg);
    }
    return;
  }

  const headline = `Update available: ${latest} (current ${current})`;
  printInfo(colorEnabled() ? c.yellow(headline) : headline);
  const commands = installCommands(latest);
  const commandForShell = process.platform === "win32" ? commands.powershell : commands.bash;
  printInfo("");
  printInfo("Install command:");
  printInfo(commandForShell);

  if (!opts.promptInstall || isNonInteractiveMode()) {
    printInfo("");
    printInfo("Run `azw update` in an interactive terminal to install, or copy the command above.");
    return;
  }

  const ok = await confirm("Install this update now?", false);
  if (!ok) {
    printInfo("Skipped install.");
    return;
  }

  await installRelease(latest);
  printInfo(
    colorEnabled()
      ? c.green(`Installed az-where ${normalizeTag(latest)}.`)
      : `Installed az-where ${normalizeTag(latest)}.`,
  );
}
