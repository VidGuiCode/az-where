import type { Command } from "commander";
import { ValidationError } from "./errors.js";
import { isCompactMode } from "./runtime.js";

export type OutputMode = "table" | "json" | "compact" | "value" | "name";

export interface OutputOpts {
  output?: string;
  json?: boolean;
  compact?: boolean;
  name?: boolean;
}

export interface ResolveOutputOptions {
  allowName?: boolean;
  allowValue?: boolean;
  command?: string;
}

const MODES = new Set<OutputMode>(["table", "json", "compact", "value", "name"]);

export function addOutputOption(cmd: Command): Command {
  return cmd.option("-o, --output <mode>", "Output mode: table, json, compact, value, or name");
}

export function addJsonCompatibilityOptions(cmd: Command, jsonDescription: string): Command {
  return cmd.option("--json", jsonDescription).option("--compact", "One-line JSON output");
}

export function resolveOutputMode(
  opts: OutputOpts,
  options: ResolveOutputOptions = {},
): OutputMode {
  const raw = String(opts.output ?? "table")
    .trim()
    .toLowerCase();
  const explicit = opts.output !== undefined;
  let mode: OutputMode;

  if (explicit) {
    if (!MODES.has(raw as OutputMode)) {
      throw new ValidationError("Invalid --output. Use table, json, compact, value, or name.");
    }
    mode = raw as OutputMode;
  } else if (opts.name) {
    mode = "name";
  } else if (opts.json && (opts.compact || isCompactMode())) {
    mode = "compact";
  } else if (opts.json) {
    mode = "json";
  } else {
    mode = "table";
  }

  if (mode === "name" && !options.allowName) {
    throw unsupportedMode("name", options);
  }
  if (mode === "value" && !options.allowValue) {
    throw unsupportedMode("value", options);
  }
  return mode;
}

export function isJsonOutput(mode: OutputMode): boolean {
  return mode === "json" || mode === "compact";
}

export function isScriptOutput(mode: OutputMode): boolean {
  return mode === "json" || mode === "compact" || mode === "value" || mode === "name";
}

export function supportedOutputModes(options: ResolveOutputOptions = {}): OutputMode[] {
  const modes: OutputMode[] = ["table", "json", "compact"];
  if (options.allowValue) modes.push("value");
  if (options.allowName) modes.push("name");
  return modes;
}

function unsupportedMode(mode: OutputMode, options: ResolveOutputOptions): ValidationError {
  const command = options.command ? ` for ${options.command}` : "";
  const supported = supportedOutputModes(options).join(", ");
  return new ValidationError(
    `--output ${mode} is not supported${command}. Supported modes: ${supported}.`,
  );
}
