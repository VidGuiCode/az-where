import { Command } from "commander";
import { DOCTOR_FAILURE_EXIT_CODE, renderDoctorReport, runDoctor } from "../core/doctor.js";
import { printInfo, printJson } from "../core/output.js";
import { exitWithError } from "../core/errors.js";
import { Spinner } from "../core/progress.js";
import {
  addJsonCompatibilityOptions,
  addOutputOption,
  isJsonOutput,
  resolveOutputMode,
} from "../core/outputMode.js";

/**
 * `azw doctor` - top-level diagnostic command, outside the verb/kind grammar
 * (like `update`). Verifies local prerequisites before any Azure scan: az
 * installed, supported version, active login, default subscription, and a
 * mintable ARM token. Exits non-zero when a prerequisite is missing so CI can
 * gate on it.
 */
export function createDoctorCommand(): Command {
  const cmd = new Command("doctor")
    .description("Verify local prerequisites: Azure CLI, login, subscription, and ARM token")
    .option("--no-update-check", "(ignored here - doctor is a local diagnostic)")
    .action(async (opts) => {
      let jsonErrors = Boolean(opts.json);
      try {
        const mode = resolveOutputMode(opts, { command: "doctor" });
        jsonErrors = isJsonOutput(mode);

        // Three `az` round-trips worst case; each pays the CLI cold-start tax.
        const spinner = isJsonOutput(mode) ? null : new Spinner("Checking Azure prerequisites", 12);
        let report;
        try {
          report = await runDoctor();
        } finally {
          spinner?.done();
        }

        if (isJsonOutput(mode)) {
          printJson({
            schemaVersion: 1,
            kind: "doctor",
            ok: report.ok,
            passed: report.passed,
            failed: report.failed,
            skipped: report.skipped,
            checks: report.checks,
          });
        } else {
          for (const line of renderDoctorReport(report)) printInfo(line);
        }

        if (!report.ok) process.exit(DOCTOR_FAILURE_EXIT_CODE);
      } catch (err) {
        exitWithError(err, jsonErrors);
      }
    });
  addOutputOption(addJsonCompatibilityOptions(cmd, "Machine-readable JSON output"));
  return cmd;
}
