import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { compareVersions, normalizeTag, shouldSkipUpdateCheck } from "../../src/core/updateCheck.js";

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.2", "0.2.0")).toBe(0);
  });

  it("returns negative when first is behind", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("0.2.0", "0.2.1")).toBeLessThan(0);
    expect(compareVersions("0.9.9", "1.0.0")).toBeLessThan(0);
  });

  it("returns positive when first is ahead (local dev build)", () => {
    expect(compareVersions("0.3.0", "0.2.0")).toBeGreaterThan(0);
    expect(compareVersions("0.2.1", "0.2.0")).toBeGreaterThan(0);
  });

  it("strips pre-release suffixes before comparing", () => {
    expect(compareVersions("0.2.0-beta.1", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.0", "0.2.1-rc.2")).toBeLessThan(0);
  });

  it("handles non-numeric components by treating them as 0", () => {
    expect(compareVersions("abc.def", "0.0.0")).toBe(0);
  });
});

describe("normalizeTag", () => {
  it("strips a leading v", () => {
    expect(normalizeTag("v0.2.0")).toBe("0.2.0");
    expect(normalizeTag("0.2.0")).toBe("0.2.0");
  });

  it("leaves non-v-prefixed tags alone", () => {
    expect(normalizeTag("release-2024")).toBe("release-2024");
  });
});

// Snapshot process.env / process.argv and restore between cases so each
// test runs against a known suppression state.
describe("shouldSkipUpdateCheck", () => {
  const argvBefore = [...process.argv];
  const envBefore = { ...process.env };

  beforeEach(() => {
    process.argv = ["node", "cli.js"];
    // Wipe the known suppressor env vars; other vars are fine.
    delete process.env.AZ_WHERE_NO_UPDATE_CHECK;
    delete process.env.CI;
    delete process.env.NO_COLOR;
  });

  afterEach(() => {
    process.argv = argvBefore;
    process.env = { ...envBefore };
  });

  it("does not skip when nothing suggests machine-readable mode", () => {
    expect(shouldSkipUpdateCheck()).toBe(false);
  });

  it("skips under --json", () => {
    process.argv.push("--json");
    expect(shouldSkipUpdateCheck()).toBe(true);
  });

  it("skips under --name", () => {
    process.argv.push("--name");
    expect(shouldSkipUpdateCheck()).toBe(true);
  });

  it("skips under --compact", () => {
    process.argv.push("--compact");
    expect(shouldSkipUpdateCheck()).toBe(true);
  });

  it("skips under --no-update-check", () => {
    process.argv.push("--no-update-check");
    expect(shouldSkipUpdateCheck()).toBe(true);
  });

  it("skips under AZ_WHERE_NO_UPDATE_CHECK env", () => {
    process.env.AZ_WHERE_NO_UPDATE_CHECK = "1";
    expect(shouldSkipUpdateCheck()).toBe(true);
  });

  it("skips under CI=true", () => {
    process.env.CI = "true";
    expect(shouldSkipUpdateCheck()).toBe(true);
  });

  it("skips under NO_COLOR", () => {
    process.env.NO_COLOR = "1";
    expect(shouldSkipUpdateCheck()).toBe(true);
  });
});
