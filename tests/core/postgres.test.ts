import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCheckCommand } from "../../src/commands/check.js";
import {
  checkPostgresSku,
  classifyPostgresSku,
  type PostgresCapability,
} from "../../src/core/postgres.js";

vi.mock("../../src/core/az.js", () => ({
  az: vi.fn().mockResolvedValue({ accessToken: "test-token", subscription: "test-subscription" }),
}));

vi.mock("../../src/core/cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/cache.js")>()),
  readArmCache: vi.fn().mockResolvedValue(undefined),
  writeArmCache: vi.fn().mockResolvedValue(undefined),
}));

const target = { tier: "GeneralPurpose", sku: "Standard_D2ds_v5" };
const region = "francecentral";
const sku = { name: target.sku, vCores: 2 };
const tier = { name: target.tier, supportedServerSkus: [sku] };
const advertised: PostgresCapability = {
  supportedFeatures: [{ name: "OfferRestricted", status: "Disabled" }],
  supportedServerEditions: [tier],
};

describe("classifyPostgresSku", () => {
  it("matches names case-insensitively and accepts omitted statuses", () => {
    expect(
      classifyPostgresSku(
        [advertised],
        { tier: "generalpurpose", sku: "standard_d2ds_v5" },
        region,
      ),
    ).toMatchObject({
      verdict: "POSTGRES_SKU_ADVERTISED",
      evidence: { listed: true, offerRestricted: false, restrictionScope: null, vCores: 2 },
    });
  });

  it("does not confuse a listing in a different tier with the requested SKU", () => {
    const catalog = {
      ...advertised,
      supportedServerEditions: [
        { ...tier, supportedServerSkus: [{ name: "Standard_D4ds_v5" }] },
        { ...tier, name: "Burstable" },
      ],
    };
    expect(classifyPostgresSku([catalog], target, region)).toMatchObject({
      verdict: "POSTGRES_SKU_NOT_LISTED",
      evidence: { listed: false, offerRestricted: false, vCores: null },
    });
  });

  it("honors an explicit offer restriction when the edition list is absent", () => {
    expect(
      classifyPostgresSku(
        [
          {
            supportedFeatures: [{ name: "OfferRestricted", status: "Enabled" }],
            reason: "An Azure detail that should stay out of the result",
          },
        ],
        target,
        region,
      ),
    ).toMatchObject({
      verdict: "POSTGRES_SKU_RESTRICTED",
      evidence: { listed: null, offerRestricted: true, restrictionScope: "offer", vCores: null },
      reason: expect.stringContaining("offer restriction"),
    });
  });

  it.each([
    { record: { ...advertised, restricted: "Enabled" }, scope: "region" },
    {
      record: {
        ...advertised,
        supportedFeatures: [
          ...advertised.supportedFeatures!,
          { name: "Restricted", status: "Enabled" },
        ],
      },
      scope: "region",
    },
    { record: { ...advertised, status: "Disabled" }, scope: "region" },
    {
      record: { ...advertised, supportedServerEditions: [{ ...tier, status: "Disabled" }] },
      scope: "tier",
    },
    {
      record: {
        ...advertised,
        supportedServerEditions: [
          { ...tier, supportedServerSkus: [{ ...sku, status: "Disabled" }] },
        ],
      },
      scope: "sku",
    },
  ])("lets a $scope restriction override a listed SKU", ({ record, scope }) => {
    expect(classifyPostgresSku([advertised, record], target, region)).toMatchObject({
      verdict: "POSTGRES_SKU_RESTRICTED",
      evidence: { listed: true, restrictionScope: scope },
    });
  });

  it.each([
    { catalog: [], listed: null },
    { catalog: [{ ...advertised, supportedFeatures: [] }], listed: true },
    {
      catalog: [
        {
          ...advertised,
          supportedServerEditions: [{ name: "Burstable", supportedServerSkus: [sku] }],
        },
      ],
      listed: null,
    },
    {
      catalog: [{ ...advertised, supportedServerEditions: [{ ...tier, supportedServerSkus: [] }] }],
      listed: null,
    },
    {
      catalog: [
        {
          ...advertised,
          supportedServerEditions: [{ ...tier, supportedServerSkus: [{ vCores: 2 }] }],
        },
      ],
      listed: null,
    },
    {
      catalog: [{ ...advertised, supportedServerEditions: [{ ...tier, status: "Visible" }] }],
      listed: true,
    },
  ])("keeps incomplete or ambiguous inventory inconclusive ($listed)", ({ catalog, listed }) => {
    expect(classifyPostgresSku(catalog, target, region)).toMatchObject({
      verdict: "POSTGRES_SKU_UNKNOWN",
      evidence: { listed },
    });
  });
});

describe("PostgreSQL capability transport and check command", () => {
  const fetch = vi.fn();
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    fetch.mockReset();
    vi.stubGlobal("fetch", fetch);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("looks through all live pages before deciding the SKU is absent", async () => {
    const first = {
      ...advertised,
      supportedServerEditions: [{ ...tier, supportedServerSkus: [{ name: "Standard_D4ds_v5" }] }],
    };
    const nextLink = "https://management.azure.com/next";
    fetch
      .mockResolvedValueOnce(Response.json({ value: [first], nextLink }))
      .mockResolvedValueOnce(Response.json({ value: [{ supportedServerEditions: [tier] }] }));

    await expect(checkPostgresSku(target, region)).resolves.toMatchObject({
      verdict: "POSTGRES_SKU_ADVERTISED",
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://management.azure.com/subscriptions/test-subscription/providers/Microsoft.DBforPostgreSQL/locations/francecentral/capabilities?api-version=2026-10-01",
      nextLink,
    ]);
  });

  it("rejects an invalid list page instead of issuing a completed verdict", async () => {
    fetch
      .mockResolvedValueOnce(
        Response.json({ value: [advertised], nextLink: "https://management.azure.com/next" }),
      )
      .mockResolvedValueOnce(Response.json({ properties: {} }));
    await expect(checkPostgresSku(target, region)).rejects.toThrow("invalid list response");
  });

  async function run(...flags: string[]) {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const program = new Command().addCommand(createCheckCommand());
    await program.parseAsync(
      [
        "check",
        "postgres",
        "--region",
        region,
        "--tier",
        target.tier,
        "--sku",
        target.sku,
        ...flags,
      ],
      { from: "user" },
    );
    return { stdout, stderr, exit };
  }

  it("prints a versioned check result with separate unchecked policy evidence after a policy read fails", async () => {
    fetch
      .mockResolvedValueOnce(Response.json({ value: [{ name: region }] }))
      .mockResolvedValueOnce(Response.json({}, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ value: [advertised] }));
    const { stdout, stderr, exit } = await run("-o", "json");
    expect(exit).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.mock.calls[0][0])).toEqual({
      schemaVersion: 1,
      kind: "check",
      resourceKind: "postgres",
      ...target,
      region,
      verdict: "POSTGRES_SKU_ADVERTISED",
      confidence: "availability",
      cache: expect.any(Object),
      policy: expect.objectContaining({ checked: false, error: expect.stringContaining("403") }),
      evidence: { listed: true, offerRestricted: false, restrictionScope: null, vCores: 2 },
      explanation: {
        code: "POSTGRES_SKU_ADVERTISED",
        reason: expect.stringContaining(region),
        hint: null,
      },
    });
  });

  it("prints a scalar policy denial without fetching PostgreSQL capabilities", async () => {
    fetch.mockResolvedValueOnce(Response.json({ value: [{ name: region }] })).mockResolvedValueOnce(
      Response.json({
        value: [
          {
            properties: { parameters: { listOfAllowedLocations: { value: ["eastus"] } } },
          },
        ],
      }),
    );
    const { stdout } = await run("-o", "value");
    expect(stdout.mock.calls).toEqual([["POLICY_DENIED"]]);
    expect(process.exitCode).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns an ARM error on stderr when the service request fails", async () => {
    fetch
      .mockResolvedValueOnce(Response.json({ value: [{ name: region }] }))
      .mockResolvedValueOnce(Response.json({}, { status: 403 }));
    const { stdout, stderr, exit } = await run("--no-policy", "-o", "json");
    expect(stdout).not.toHaveBeenCalled();
    expect(JSON.parse(stderr.mock.calls[0][0])).toMatchObject({
      code: "ARM_HTTP_ERROR",
      details: { statusCode: 403 },
    });
    expect(exit).toHaveBeenCalledWith(1);
  });
});
