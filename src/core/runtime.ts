export function hasArg(flag: string): boolean {
  return process.argv.includes(flag);
}

export function isNonInteractiveMode(): boolean {
  return hasArg("--no-interactive") || !process.stdin.isTTY || !process.stdout.isTTY;
}

export function isCompactMode(): boolean {
  return hasArg("--compact") || outputModeArg() === "compact";
}

export function isMachineOutputMode(): boolean {
  if (hasArg("--json") || hasArg("--name") || hasArg("--pick") || hasArg("--compact")) return true;
  const mode = outputModeArg();
  return mode === "json" || mode === "compact" || mode === "value" || mode === "name";
}

function outputModeArg(): string | null {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "-o" || arg === "--output") {
      return process.argv[i + 1]?.trim().toLowerCase() ?? null;
    }
    if (arg.startsWith("--output=")) {
      return arg.slice("--output=".length).trim().toLowerCase();
    }
    if (arg.startsWith("-o=")) {
      return arg.slice("-o=".length).trim().toLowerCase();
    }
  }
  return null;
}
