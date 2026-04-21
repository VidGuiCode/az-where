import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Progress } from "../../src/core/progress.js";

describe("Progress", () => {
  let writes: string[];
  let originalWrite: typeof process.stderr.write;
  let originalCI: string | undefined;
  let originalNoColor: string | undefined;
  let originalIsTty: boolean | undefined;

  beforeEach(() => {
    writes = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    originalCI = process.env.CI;
    originalNoColor = process.env.NO_COLOR;
    originalIsTty = process.stderr.isTTY;
    // Force log mode (not live redraw) for deterministic test output.
    process.env.CI = "1";
    delete process.env.NO_COLOR;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    if (originalCI === undefined) delete process.env.CI;
    else process.env.CI = originalCI;
    if (originalNoColor !== undefined) process.env.NO_COLOR = originalNoColor;
    if (originalIsTty !== undefined) {
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTty, configurable: true });
    }
    vi.useRealTimers();
  });

  it("emits a header and one line per tick in log mode", () => {
    const p = new Progress(3, "Scanning");
    p.tick("a");
    p.tick("b");
    p.tick("c");
    p.done();

    const all = writes.join("");
    expect(all).toContain("Scanning (3)");
    expect(all).toContain("[1/3] a");
    expect(all).toContain("[2/3] b");
    expect(all).toContain("[3/3] c");
  });

  it("tracks elapsed time across ticks", async () => {
    const p = new Progress(1, "x");
    await new Promise((r) => setTimeout(r, 15));
    p.tick("only");
    p.done();
    expect(p.elapsedMs()).toBeGreaterThanOrEqual(10);
  });

  it("marks failures distinctly in log mode", () => {
    const p = new Progress(4, "x");
    p.tick("ok-one");
    p.tick("blocked-one", "sub");
    p.tick("missing-one", "off");
    p.tick("broken-one", "err");
    p.done();
    const all = writes.join("");
    expect(all).toContain("ok-one ✓");
    expect(all).toContain("blocked-one ✗sub");
    expect(all).toContain("missing-one ✗off");
    expect(all).toContain("broken-one ✗err");
  });
});
