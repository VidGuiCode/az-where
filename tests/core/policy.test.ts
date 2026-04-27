import { describe, expect, it } from "vitest";
import {
  buildPolicyCheck,
  parseAllowedLocationPolicy,
  type PolicyAssignment,
} from "../../src/core/policy.js";

const assignment = (
  name: string,
  locations: string[],
  extra: Partial<PolicyAssignment["properties"]> = {},
): PolicyAssignment => ({
  name,
  properties: {
    displayName: name,
    parameters: {
      listOfAllowedLocations: { value: locations },
    },
    ...extra,
  },
});

describe("Azure Policy allowed-location parsing", () => {
  it("extracts listOfAllowedLocations", () => {
    const summary = parseAllowedLocationPolicy([
      assignment("sys.regionrestriction", ["swedencentral", "NorwayEast"]),
    ]);

    expect(summary).toEqual({
      checked: true,
      restricted: true,
      allowedLocations: ["norwayeast", "swedencentral"],
      assignments: [
        {
          name: "sys.regionrestriction",
          displayName: "sys.regionrestriction",
        },
      ],
      error: null,
    });
  });

  it("also accepts allowedLocations", () => {
    const summary = parseAllowedLocationPolicy([
      {
        name: "custom",
        properties: {
          displayName: "custom",
          parameters: {
            allowedLocations: { value: ["francecentral"] },
          },
        },
      },
    ]);

    expect(summary.allowedLocations).toEqual(["francecentral"]);
  });

  it("ignores DoNotEnforce assignments", () => {
    const summary = parseAllowedLocationPolicy([
      assignment("ignored", ["swedencentral"], { enforcementMode: "DoNotEnforce" }),
    ]);

    expect(summary.restricted).toBe(false);
    expect(summary.allowedLocations).toBeNull();
  });

  it("ignores explicit non-deny effects", () => {
    const summary = parseAllowedLocationPolicy([
      assignment("audit", ["swedencentral"], {
        parameters: {
          listOfAllowedLocations: { value: ["swedencentral"] },
          effect: { value: "Audit" },
        },
      }),
    ]);

    expect(summary.restricted).toBe(false);
  });

  it("intersects multiple allowed-location assignments", () => {
    const summary = parseAllowedLocationPolicy([
      assignment("a", ["swedencentral", "norwayeast"]),
      assignment("b", ["swedencentral", "francecentral"]),
    ]);

    expect(summary.allowedLocations).toEqual(["swedencentral"]);
  });

  it("returns unrestricted when no allowed-location assignment exists", () => {
    const summary = parseAllowedLocationPolicy([{ name: "other", properties: { displayName: "Other" } }]);

    expect(summary).toMatchObject({
      checked: true,
      restricted: false,
      allowedLocations: null,
      assignments: [],
      error: null,
    });
  });

  it("denies regions outside the parsed allow-list", () => {
    const check = buildPolicyCheck(
      parseAllowedLocationPolicy([assignment("sys.regionrestriction", ["swedencentral"])]),
    );

    expect(check.isAllowed("swedencentral")).toBe(true);
    expect(check.isAllowed("denmarkeast")).toBe(false);
    expect(check.reason("denmarkeast")).toContain("sys.regionrestriction");
  });
});
