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
}

const MODES = new Set<OutputMode>(["table", "json", "compact", "value", "name"]);

export function addOutputOption(cmd: Command): Command {
  return cmd.option(
    "-o, --output <mode>",
    "Output mode: table, json, compact, value, or name",
    "table",
  );
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
  const explicit = opts.output !== undefined && raw !== "table";
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
    throw new ValidationError("--output name is not supported for this command.");
  }
  if (mode === "value" && !options.allowValue) {
    throw new ValidationError("--output value is not supported for this command.");
  }
  return mode;
}

export function isJsonOutput(mode: OutputMode): boolean {
  return mode === "json" || mode === "compact";
}
