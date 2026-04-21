import { spawn } from "node:child_process";
import { AzCliError, AzNotInstalledError, AzNotLoggedInError } from "./errors.js";

/**
 * Run `az <args>` and parse JSON stdout. Delegates all auth to the user's
 * existing `az login` session. Never mutates Azure state — callers are
 * expected to pass read-only subcommands.
 */
export async function az<T = unknown>(args: string[]): Promise<T> {
  const command = `az ${args.join(" ")}`;

  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    ({ stdout, stderr, exitCode } = await runAz([...args, "-o", "json"]));
  } catch (err) {
    // spawn() rejects with ENOENT when `az` is not on PATH.
    if (isEnoent(err)) throw new AzNotInstalledError(command);
    throw err;
  }

  if (exitCode !== 0) {
    // Windows with shell:true reports "not recognized"; cmd.exe exits with 1, not ENOENT.
    if (looksNotInstalled(stderr)) throw new AzNotInstalledError(command);
    if (/please run ['"]?az login/i.test(stderr) || /not logged in/i.test(stderr)) {
      throw new AzNotLoggedInError(command, stderr);
    }
    throw new AzCliError(`az failed: ${firstLine(stderr) || "unknown error"}`, exitCode, stderr, command);
  }

  if (!stdout.trim()) return null as T;
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new AzCliError(`az produced non-JSON output`, exitCode, stdout, command);
  }
}

function isEnoent(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  // On Windows with shell:true, missing binaries surface as exit code 1 with a
  // "not recognized" message rather than ENOENT; we handle that in runAz.
  return code === "ENOENT";
}

interface AzResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runAz(args: string[]): Promise<AzResult> {
  return new Promise((resolve, reject) => {
    // Use the shell on Windows so `az.cmd` resolves.
    const child = spawn("az", args, { shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
}

function looksNotInstalled(stderr: string): boolean {
  return (
    /is not recognized as an? .*command/i.test(stderr) ||
    /['"]?az['"]?\s*:?\s*command not found/i.test(stderr) ||
    /command not found.*\baz\b/i.test(stderr) ||
    /cannot find the path/i.test(stderr)
  );
}
