import { hasArg, isCompactMode } from "./runtime.js";

function enabled(): boolean {
  if (hasArg("--json") || hasArg("--name") || hasArg("--pick") || isCompactMode()) return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.CI) return false;
  return Boolean(process.stdout.isTTY);
}

const on = enabled();

function wrap(code: number, close = 39): (s: string) => string {
  return on ? (s: string) => `\x1b[${code}m${s}\x1b[${close}m` : (s: string) => s;
}

export const c = {
  green: wrap(32),
  red: wrap(31),
  yellow: wrap(33),
  cyan: wrap(36),
  gray: wrap(90),
  dim: wrap(2, 22),
  bold: wrap(1, 22),
};

export function colorEnabled(): boolean {
  return on;
}

/** Length of a string ignoring ANSI escape sequences. Needed for table padding. */
export function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** padEnd that ignores ANSI escapes when measuring length. */
export function padVisible(s: string, width: number): string {
  const gap = Math.max(0, width - visibleLength(s));
  return s + " ".repeat(gap);
}
