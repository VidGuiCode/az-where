import { printError, printErrorJson } from "./output.js";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class NonInteractiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonInteractiveError";
  }
}

export class AzCliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr: string,
    public readonly command: string,
  ) {
    super(message);
    this.name = "AzCliError";
  }
}

export class AzNotLoggedInError extends AzCliError {
  constructor(command: string, stderr: string) {
    super("Not logged in. Run: az login", 1, stderr, command);
    this.name = "AzNotLoggedInError";
  }
}

export class AzNotInstalledError extends AzCliError {
  constructor(command: string) {
    super(
      "Azure CLI (`az`) is not installed or not on PATH.",
      127,
      "",
      command,
    );
    this.name = "AzNotInstalledError";
  }
}

export class ArmHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly statusText: string,
    public readonly endpoint: string,
    public readonly armCode: string | null,
    public readonly armMessage: string | null,
    public readonly bodySnippet: string,
  ) {
    super(
      armCode && armMessage
        ? `ARM ${statusCode} ${statusText}: ${armCode} - ${armMessage}`
        : `ARM ${statusCode} ${statusText}`,
    );
    this.name = "ArmHttpError";
  }
}

export function getExitCode(error: unknown): number {
  if (error instanceof AzNotInstalledError) return 127;
  if (error instanceof AzNotLoggedInError) return 2;
  if (error instanceof ValidationError || error instanceof NonInteractiveError) return 3;
  if (error instanceof AzCliError) return 1;
  if (error instanceof ArmHttpError) return 1;
  return 1;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof AzNotInstalledError) {
    return `${error.message}\n  Hint: az-where is a wrapper around the Azure CLI — install it first:\n         https://learn.microsoft.com/cli/azure/install-azure-cli\n         Then sign in with: az login`;
  }
  if (error instanceof AzNotLoggedInError) {
    return `${error.message}\n  Hint: az-where delegates auth to the Azure CLI — run 'az login' and retry.`;
  }
  if (error instanceof AzCliError) {
    return `${error.message}\n  Hint: 'az' returned exit code ${error.exitCode}. Try running the command manually: ${error.command}`;
  }
  if (error instanceof ArmHttpError) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return `${error.message}\n  Hint: ARM rejected the current Azure CLI token or subscription permissions. Check 'az account show' and your role assignments.`;
    }
    if (error.statusCode === 429) {
      return `${error.message}\n  Hint: ARM throttled the request. Retry in a moment or lower --concurrency.`;
    }
    return `${error.message}\n  Hint: ARM request failed while reading ${error.endpoint}. Retry with --refresh if cached data may be stale.`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function exitWithError(error: unknown, json = false): never {
  if (json) {
    printErrorJson(error);
  } else {
    printError(getErrorMessage(error));
  }
  process.exit(getExitCode(error));
}
