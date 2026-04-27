import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  armCacheFile,
  armCacheKey,
  armCacheSummary,
  isArmCacheablePath,
  readArmCache,
  resetArmCacheStatsForTests,
  writeArmCache,
} from "../../src/core/cache.js";

describe("ARM cache", () => {
  let tmp: string;
  let before: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "az-where-cache-"));
    before = process.env.AZ_WHERE_CACHE_DIR;
    process.env.AZ_WHERE_CACHE_DIR = tmp;
    resetArmCacheStatsForTests();
  });

  afterEach(async () => {
    if (before === undefined) delete process.env.AZ_WHERE_CACHE_DIR;
    else process.env.AZ_WHERE_CACHE_DIR = before;
    resetArmCacheStatsForTests();
    await rm(tmp, { recursive: true, force: true });
  });

  it("uses a stable key per subscription and request path", () => {
    expect(armCacheKey("sub-a", "/locations?api-version=2022-12-01")).toBe(
      armCacheKey("sub-a", "/locations?api-version=2022-12-01"),
    );
    expect(armCacheKey("sub-a", "/locations?api-version=2022-12-01")).not.toBe(
      armCacheKey("sub-b", "/locations?api-version=2022-12-01"),
    );
  });

  it("only caches allowed ARM list endpoints", () => {
    expect(isArmCacheablePath("/locations?api-version=2022-12-01")).toBe(true);
    expect(isArmCacheablePath("/providers/Microsoft.Compute/skus?api-version=2021-07-01")).toBe(
      true,
    );
    expect(
      isArmCacheablePath("/providers/Microsoft.Compute/locations/westeurope/usages?api-version=2021-07-01"),
    ).toBe(false);
  });

  it("reads fresh cache entries and reports cache use", async () => {
    await writeArmCache("sub", "/locations?api-version=2022-12-01", [{ name: "westeurope" }]);
    await expect(readArmCache("sub", "/locations?api-version=2022-12-01")).resolves.toEqual([
      { name: "westeurope" },
    ]);
    expect(armCacheSummary()).toEqual({ used: true, refreshed: false, ttlSeconds: 600 });
  });

  it("ignores corrupt cache entries", async () => {
    const file = armCacheFile("sub", "/locations?api-version=2022-12-01");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{nope", "utf-8");
    await expect(readArmCache("sub", "/locations?api-version=2022-12-01")).resolves.toBeUndefined();
    expect(armCacheSummary().used).toBe(false);
  });

  it("bypasses reads when refresh is requested", async () => {
    await writeArmCache("sub", "/locations?api-version=2022-12-01", [{ name: "westeurope" }]);
    await expect(readArmCache("sub", "/locations?api-version=2022-12-01", true)).resolves.toBeUndefined();
    expect(armCacheSummary()).toEqual({ used: false, refreshed: true, ttlSeconds: 600 });
  });
});
