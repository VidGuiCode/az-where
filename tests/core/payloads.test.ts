import { describe, expect, it } from "vitest";
import {
  buildAvailabilityResourcePayload,
  buildAvailabilityVmPayload,
  buildCheckResourcePayload,
  buildCheckVmPayload,
  buildPickPayload,
  buildSuggestPayload,
  buildVerifyPayload,
} from "../../src/core/payloads.js";
import type { IacSkippedResource } from "../../src/core/iac.js";
import { POLICY_DISABLED } from "../../src/core/policy.js";
import { classifyResourceLocation, resolveResourceType } from "../../src/core/resources.js";
import {
  baseVerdict,
  buildQuotaVerdict,
} from "../../src/core/scan.js";
import type { AzLocation, RegionVerdict, ResourceAvailabilityVerdict } from "../../src/core/types.js";
import { toVerifyRow, type VerifyResultRow } from "../../src/core/verify.js";

/**
 * These tests pin the documented stable JSON contracts (docs/json-contracts.md):
 * every top-level field name, in order, plus the row shapes. Field names must
 * not change casually; new fields may only be appended.
 */

const cache = { used: true, refreshed: false, ttlSeconds: 600 };

const location: AzLocation = {
  name: "westeurope",
  displayName: "West Europe",
  regionalDisplayName: "(Europe) West Europe",
  metadata: { geographyGroup: "Europe", physicalLocation: "Netherlands" },
};

// Built through the production builders so key order matches real scans.
const vmCheckRow: RegionVerdict = buildQuotaVerdict(
  baseVerdict(location),
  "standardBSFamily",
  1,
  { name: { value: "standardBSFamily", localizedValue: "Standard BS Family" }, currentValue: 4, limit: 10, unit: "Count" },
);

const resolved = resolveResourceType("storage-account")!;

const resourceRow: ResourceAvailabilityVerdict = classifyResourceLocation({
  target: "storage-account",
  resolved,
  location,
  supported: new Set(["westeurope"]),
  context: { cause: "region-not-advertised", providerRegistered: true, typeLocationCount: 42 },
});

const suggestion = {
  row: vmCheckRow,
  score: 5000,
  reason: "westeurope is deployable with 6/10 free",
  factors: { free: 6, limit: 10 },
};

describe("check payload contracts", () => {
  it("check vm pins the documented top-level fields in order", () => {
    const payload = buildCheckVmPayload("Standard_B1s", vmCheckRow, cache, POLICY_DISABLED);
    expect(Object.keys(payload)).toEqual([
      "schemaVersion",
      "kind",
      "resourceKind",
      "target",
      "region",
      "verdict",
      "confidence",
      "cache",
      "policy",
      "checks",
      "explanation",
    ]);
    expect(payload.kind).toBe("check");
    expect(payload.resourceKind).toBe("vm");
    expect(payload.confidence).toBe("deployability");
    // `checks` is a single row object, not an array.
    expect(Array.isArray(payload.checks)).toBe(false);
  });

  it("check vm carries an explanation whose code mirrors the verdict", () => {
    const payload = buildCheckVmPayload("Standard_B1s", vmCheckRow, cache, POLICY_DISABLED);
    expect(payload.explanation.code).toBe(payload.verdict);
    expect(typeof payload.explanation.reason).toBe("string");
    expect(
      payload.explanation.hint === null || typeof payload.explanation.hint === "string",
    ).toBe(true);
  });

  it("check vm pins the RegionVerdict row fields in order", () => {
    const payload = buildCheckVmPayload("Standard_B1s", vmCheckRow, cache, POLICY_DISABLED);
    expect(Object.keys(payload.checks)).toEqual([
      "region",
      "displayName",
      "geographyGroup",
      "physicalLocation",
      "skuOffered",
      "family",
      "used",
      "limit",
      "free",
      "policyAllowed",
      "policyReason",
      "verdict",
      "requiredVcpus",
      "skuRestrictions",
      "familySizesOffered",
      "errorDetail",
    ]);
  });

  it("check resource pins the documented top-level fields in order", () => {
    const payload = buildCheckResourcePayload(
      "storage-account",
      resolved,
      resourceRow,
      cache,
      POLICY_DISABLED,
    );
    expect(Object.keys(payload)).toEqual([
      "schemaVersion",
      "kind",
      "resourceKind",
      "target",
      "resolved",
      "region",
      "verdict",
      "confidence",
      "cache",
      "policy",
      "checks",
      "explanation",
    ]);
    expect(payload.confidence).toBe("availability");
    expect(Array.isArray(payload.checks)).toBe(false);
    expect(payload.explanation.code).toBe(payload.verdict);
    expect(Object.keys(payload.resolved)).toEqual([
      "input",
      "resourceType",
      "alias",
      "namespace",
      "typePath",
    ]);
  });

  it("check resource pins the ResourceAvailabilityVerdict row fields in order", () => {
    const payload = buildCheckResourcePayload(
      "storage-account",
      resolved,
      resourceRow,
      cache,
      POLICY_DISABLED,
    );
    expect(Object.keys(payload.checks)).toEqual([
      "kind",
      "target",
      "resourceType",
      "region",
      "displayName",
      "geographyGroup",
      "physicalLocation",
      "policyAllowed",
      "policyReason",
      "confidence",
      "verdict",
      "providerRegistered",
      "typeLocationCount",
      "notSupportedCause",
    ]);
  });
});

describe("availability payload contracts", () => {
  it("availability vm pins the documented top-level fields in order", () => {
    const payload = buildAvailabilityVmPayload({
      kind: "availability",
      sku: "Standard_B1s",
      geography: "Europe",
      region: null,
      scannedAt: "2026-10-08T00:00:00.000Z",
      elapsedMs: 4200,
      cache,
      policy: POLICY_DISABLED,
      rows: [vmCheckRow],
    });
    expect(Object.keys(payload)).toEqual([
      "schemaVersion",
      "kind",
      "resourceKind",
      "sku",
      "geography",
      "region",
      "scannedAt",
      "elapsedMs",
      "cache",
      "policy",
      "regions",
    ]);
    expect(payload.kind).toBe("availability");
    expect(payload.regions).toHaveLength(1);
  });

  it("availability resource pins the documented top-level fields in order", () => {
    const payload = buildAvailabilityResourcePayload({
      target: "storage-account",
      resolved,
      geography: "Europe",
      region: null,
      scannedAt: "2026-10-08T00:00:00.000Z",
      elapsedMs: 4200,
      cache,
      policy: POLICY_DISABLED,
      rows: [resourceRow],
    });
    expect(Object.keys(payload)).toEqual([
      "schemaVersion",
      "kind",
      "resourceKind",
      "target",
      "resolved",
      "confidence",
      "geography",
      "region",
      "scannedAt",
      "elapsedMs",
      "cache",
      "policy",
      "regions",
    ]);
    expect(payload.confidence).toBe("availability");
  });
});

describe("pick and suggest payload contracts", () => {
  it("pick success pins fields and the picked object", () => {
    const payload = buildPickPayload("Standard_B1s", cache, POLICY_DISABLED, vmCheckRow);
    expect(Object.keys(payload)).toEqual([
      "schemaVersion",
      "kind",
      "resourceKind",
      "sku",
      "cache",
      "policy",
      "picked",
    ]);
    expect(Object.keys(payload.picked!)).toEqual([
      "region",
      "displayName",
      "geographyGroup",
      "free",
      "limit",
    ]);
  });

  it("pick failure keeps the same fields with picked null", () => {
    const payload = buildPickPayload("Standard_B1s", cache, POLICY_DISABLED, null);
    expect(Object.keys(payload)).toEqual([
      "schemaVersion",
      "kind",
      "resourceKind",
      "sku",
      "cache",
      "policy",
      "picked",
    ]);
    expect(payload.picked).toBeNull();
  });

  it("suggest success and failure pin fields with the suggested object shape", () => {
    const success = buildSuggestPayload({
      sku: "Standard_B1s",
      geography: "Europe",
      near: null,
      elapsedMs: 4200,
      cache,
      policy: POLICY_DISABLED,
      suggestion,
    });
    expect(Object.keys(success)).toEqual([
      "schemaVersion",
      "kind",
      "resourceKind",
      "sku",
      "geography",
      "near",
      "elapsedMs",
      "cache",
      "policy",
      "suggested",
    ]);
    expect(Object.keys(success.suggested!)).toEqual([
      "region",
      "displayName",
      "reason",
      "score",
      "factors",
    ]);

    const failure = buildSuggestPayload({
      sku: "Standard_B1s",
      geography: "Europe",
      near: null,
      elapsedMs: 4200,
      cache,
      policy: POLICY_DISABLED,
      suggestion: null,
    });
    expect(failure.suggested).toBeNull();
  });
});

describe("verify payload contracts", () => {
  const verifyRow: VerifyResultRow = toVerifyRow(
    {
      file: "main.tf",
      line: 14,
      format: "terraform",
      resourceType: "azurerm_linux_virtual_machine",
      resourceName: "vm_linux",
      sku: "Standard_B1s",
      locationLiteral: "westeurope",
      capacity: 1,
    },
    vmCheckRow,
  );

  const skippedFinding: IacSkippedResource = {
    file: "main.tf",
    line: 32,
    format: "terraform",
    resourceType: "azurerm_windows_virtual_machine",
    resourceName: "vm_win",
    reason: "dynamic-location",
    detail: "azurerm_resource_group.rg.location",
  };

  it("verify pins the documented top-level fields in order", () => {
    const payload = buildVerifyPayload({
      files: ["main.tf"],
      formats: ["terraform"],
      scannedAt: "2026-10-08T00:00:00.000Z",
      elapsedMs: 1200,
      rows: [verifyRow],
      skipped: [skippedFinding],
      vmResourceCount: 2,
      cache,
      policy: POLICY_DISABLED,
    });
    expect(Object.keys(payload)).toEqual([
      "schemaVersion",
      "kind",
      "resourceKind",
      "confidence",
      "files",
      "formats",
      "scannedAt",
      "elapsedMs",
      "summary",
      "results",
      "skipped",
      "cache",
      "policy",
    ]);
    expect(payload.kind).toBe("verify");
    expect(payload.resourceKind).toBe("vm");
    expect(payload.confidence).toBe("deployability");
  });

  it("verify results carry source metadata, the pinned checks row, and an explanation", () => {
    const payload = buildVerifyPayload({
      files: ["main.tf"],
      formats: ["terraform"],
      scannedAt: "2026-10-08T00:00:00.000Z",
      elapsedMs: 1200,
      rows: [verifyRow],
      skipped: [],
      vmResourceCount: 1,
      cache,
      policy: POLICY_DISABLED,
    });
    expect(Object.keys(payload.results[0]!)).toEqual([
      "file",
      "line",
      "format",
      "resourceType",
      "resourceName",
      "sku",
      "region",
      "capacity",
      "checks",
      "explanation",
    ]);
    // The embedded row keeps the pinned RegionVerdict field order.
    expect(Object.keys(payload.results[0]!.checks)).toEqual([
      "region",
      "displayName",
      "geographyGroup",
      "physicalLocation",
      "skuOffered",
      "family",
      "used",
      "limit",
      "free",
      "policyAllowed",
      "policyReason",
      "verdict",
      "requiredVcpus",
      "skuRestrictions",
      "familySizesOffered",
      "errorDetail",
    ]);
    expect(payload.results[0]!.explanation.code).toBe(payload.results[0]!.checks.verdict);
  });

  it("verify summary counts resources, checked pairs, skips, and verdicts", () => {
    const payload = buildVerifyPayload({
      files: ["main.tf"],
      formats: ["terraform"],
      scannedAt: "2026-10-08T00:00:00.000Z",
      elapsedMs: 1200,
      rows: [verifyRow],
      skipped: [skippedFinding],
      vmResourceCount: 2,
      cache,
      policy: POLICY_DISABLED,
    });
    expect(payload.summary).toEqual({
      resources: 2,
      checked: 1,
      skipped: 1,
      deployableCount: vmCheckRow.verdict === "AVAILABLE" ? 1 : 0,
      verdictCounts: {
        AVAILABLE: vmCheckRow.verdict === "AVAILABLE" ? 1 : 0,
        FULL: 0,
        SKU_NOT_OFFERED: 0,
        BLOCKED_FOR_SUB: 0,
        POLICY_DENIED: 0,
        QUOTA_UNKNOWN: 0,
      },
    });
    // Skipped findings keep their own shape, separate from verdict rows.
    expect(Object.keys(payload.skipped[0]!)).toEqual([
      "file",
      "line",
      "format",
      "resourceType",
      "resourceName",
      "reason",
      "detail",
    ]);
  });
});
