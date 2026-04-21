import { hasArg } from "./runtime.js";
import { c, colorEnabled } from "./color.js";

function liveMode(): boolean {
  if (hasArg("--json") || hasArg("--name") || hasArg("--pick")) return false;
  if (process.env.CI || process.env.NO_COLOR) return false;
  return Boolean(process.stderr.isTTY);
}

function logMode(): boolean {
  if (hasArg("--json") || hasArg("--name") || hasArg("--pick")) return false;
  return true;
}

export type TickStatus = "ok" | "sub" | "off" | "err";

// Render a one-glyph reason so the log-mode line distinguishes genuine
// success from the three flavours of "no": subscription blocked, SKU not
// offered, or ARM error. Saves a second pass reading the full table.
function renderMark(status: TickStatus): string {
  switch (status) {
    case "ok":
      return "✓";
    case "sub":
      return "✗sub";
    case "off":
      return "✗off";
    case "err":
      return "✗err";
  }
}

/**
 * Indeterminate ticker for single-shot ARM calls where we don't know the
 * total up-front (e.g. the subscription-wide skus catalog). Spinner + live
 * elapsed on a TTY; a single start/finish line in log mode so CI logs stay
 * readable.
 */
export class Spinner {
  private readonly start = Date.now();
  private readonly live: boolean;
  private readonly log: boolean;
  private heartbeat: NodeJS.Timeout | undefined;
  private frame = 0;
  private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  constructor(
    private readonly label: string,
    private readonly etaSeconds?: number,
  ) {
    this.live = liveMode();
    this.log = logMode();
    if (this.live) {
      this.draw();
      this.heartbeat = setInterval(() => this.draw(), 100);
      this.heartbeat.unref?.();
    } else if (this.log) {
      const eta = etaSeconds ? `  (est. ~${etaSeconds}s)` : "";
      process.stderr.write(`${this.label}...${eta}\n`);
    }
  }

  done(note?: string): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    if (this.live) {
      process.stderr.write("\r\x1b[2K");
    } else if (this.log && note) {
      const el = fmtSeconds(Date.now() - this.start);
      process.stderr.write(`${this.label} ${note} ${el}\n`);
    }
  }

  private draw(): void {
    const f = this.frames[this.frame++ % this.frames.length];
    const elapsed = Date.now() - this.start;
    const glyph = colorEnabled() ? c.cyan(f) : f;
    const el = fmtSeconds(elapsed);
    // Once we've blown past the ETA, show "· 45s (est. ~30s)" instead of
    // silently ticking — the estimate was wrong but the work is still live.
    const etaNote = this.etaSeconds
      ? elapsed < this.etaSeconds * 1000
        ? `/ ~${this.etaSeconds}s`
        : `(est. ~${this.etaSeconds}s)`
      : "";
    const tail = [el, etaNote].filter(Boolean).join(" ");
    const dim = colorEnabled() ? c.dim(tail) : tail;
    process.stderr.write(`\r\x1b[2K${glyph} ${this.label} · ${dim}`);
  }
}

function fmtSeconds(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m${r.toString().padStart(2, "0")}s`;
}

export class Progress {
  private completed = 0;
  private readonly start = Date.now();
  private readonly live: boolean;
  private readonly log: boolean;
  private lastDraw = 0;
  private lastSubLabel: string | undefined;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(
    private readonly total: number,
    private readonly label: string,
    private readonly etaSeconds?: number,
  ) {
    this.live = liveMode();
    this.log = logMode();
    if (this.live) {
      this.draw();
      // Tick the clock even when no work completes — otherwise `az` calls that
      // take 60s feel frozen. Redraws pull fresh Date.now() so elapsed ticks.
      this.heartbeat = setInterval(() => this.draw(this.lastSubLabel), 250);
      this.heartbeat.unref?.();
    } else if (this.log) {
      const eta = etaSeconds ? `  (est. ~${etaSeconds}s)` : "";
      process.stderr.write(`${this.label} (${total})${eta}\n`);
    }
  }

  tick(subLabel?: string, status: TickStatus = "ok"): void {
    this.completed++;
    this.lastSubLabel = subLabel;
    if (this.live) {
      this.draw(subLabel);
    } else if (this.log) {
      const mark = renderMark(status);
      const tag = subLabel ? ` ${subLabel}` : "";
      const el = fmtSeconds(Date.now() - this.start);
      process.stderr.write(`  [${this.completed}/${this.total}]${tag} ${mark} ${el}\n`);
    }
  }

  done(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    if (this.live) {
      // clear the progress line
      process.stderr.write("\r\x1b[2K");
    }
  }

  elapsedMs(): number {
    return Date.now() - this.start;
  }

  private draw(subLabel?: string): void {
    // Throttle to ~10fps to avoid flooding a slow terminal
    const now = Date.now();
    if (now - this.lastDraw < 80 && this.completed < this.total) return;
    this.lastDraw = now;

    const width = 20;
    const ratio = this.total === 0 ? 1 : this.completed / this.total;
    const filled = Math.round(ratio * width);
    const bar = "█".repeat(filled) + "░".repeat(width - filled);

    const elapsed = now - this.start;
    const remaining =
      this.completed > 0 ? (elapsed / this.completed) * (this.total - this.completed) : 0;

    const parts = [
      colorEnabled() ? c.cyan(`[${bar}]`) : `[${bar}]`,
      `${this.completed}/${this.total}`,
      c.dim(`${fmtSeconds(elapsed)} elapsed`),
      this.completed > 0 && this.completed < this.total
        ? c.dim(`~${fmtSeconds(remaining)} remaining`)
        : "",
      subLabel ? c.dim(`· ${subLabel}`) : "",
    ].filter(Boolean);

    process.stderr.write(`\r\x1b[2K${this.label} ${parts.join(" · ")}`);
  }
}
