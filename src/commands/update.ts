import { Command } from "commander";
import { checkForUpdate, normalizeTag } from "../core/updateCheck.js";
import { printInfo, printJson } from "../core/output.js";
import { c, colorEnabled } from "../core/color.js";
import { exitWithError } from "../core/errors.js";
import { Spinner } from "../core/progress.js";
import { confirm } from "../core/prompt.js";
import { isNonInteractiveMode } from "../core/runtime.js";
import { installCommands, installRelease } from "../core/updateInstall.js";

/**
 * `azw update` — discoverable surface for the version banner. It checks the
 * latest published tag and, in an interactive terminal, asks before running
 * the npm global install command. JSON/non-interactive modes stay read-only.
 */
export function createUpdateCommand(
  currentVersion: string,
): Command {
  return new Command("update")
    .description("Check for a newer az-where release and ask before installing it.")
    .option("--json", "Machine-readable JSON output")
    .option("--no-update-check", "(ignored here — this command *is* the update check)")
    .action(async (opts) => {
      try {
        await runUpdateFlow(currentVersion, {
          forceRefresh: true,
          json: Boolean(opts.json),
          promptInstall: true,
          quietWhenCurrent: false,
        });
      } catch (err) {
        exitWithError(err, Boolean(opts.json));
      }
    });
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

  const latestVersion = normalizeTag(latest);
  const header = `Update available: ${current} -> ${latestVersion}`;
  printInfo("");
  printInfo(colorEnabled() ? c.bold(header) : header);

  const canPrompt = opts.promptInstall && !isNonInteractiveMode();
  if (canPrompt && (await confirm("Install now?"))) {
    printInfo("");
    printInfo(`Running: ${installCommands(latestVersion).pinned}`);
    await installRelease(latestVersion);
    printInfo("");
    printInfo(
      colorEnabled() ? c.green(`Updated to ${latestVersion}.`) : `Updated to ${latestVersion}.`,
    );
    return;
  }

  printInfo("");
  printInfo("Install later with:");
  printInfo(`  ${installCommands(latestVersion).pinned}`);
  if (!canPrompt) {
    printInfo("");
    printInfo("Interactive install prompt is disabled in JSON, CI, or non-TTY mode.");
  }
}
