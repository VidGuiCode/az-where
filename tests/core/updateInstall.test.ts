import { describe, expect, it } from "vitest";
import {
  installCommands,
  isValidReleaseVersion,
  releaseTarballUrl,
} from "../../src/core/updateInstall.js";

describe("releaseTarballUrl", () => {
  it("builds the pinned GitHub release tarball URL", () => {
    expect(releaseTarballUrl("0.3.4")).toBe(
      "https://github.com/VidGuiCode/az-where/releases/download/v0.3.4/az-where-0.3.4.tgz",
    );
  });

  it("accepts tags with a leading v", () => {
    expect(releaseTarballUrl("v0.3.4")).toBe(
      "https://github.com/VidGuiCode/az-where/releases/download/v0.3.4/az-where-0.3.4.tgz",
    );
  });
});

describe("isValidReleaseVersion", () => {
  it("accepts plain and v-prefixed semver tags", () => {
    expect(isValidReleaseVersion("0.4.1")).toBe(true);
    expect(isValidReleaseVersion("v0.4.1")).toBe(true);
    expect(isValidReleaseVersion("1.0.0-beta.2")).toBe(true);
  });

  it("rejects tags that could carry shell metacharacters", () => {
    expect(isValidReleaseVersion("0.4.1; rm -rf /")).toBe(false);
    expect(isValidReleaseVersion("$(whoami)")).toBe(false);
    expect(isValidReleaseVersion("0.4")).toBe(false);
    expect(isValidReleaseVersion("")).toBe(false);
  });
});

describe("installCommands", () => {
  it("keeps the human and JSON install command shape stable", () => {
    expect(installCommands("v0.3.4")).toEqual({
      pinned:
        "npm install -g https://github.com/VidGuiCode/az-where/releases/download/v0.3.4/az-where-0.3.4.tgz",
      bash: `npm install -g "$(gh release view --repo VidGuiCode/az-where --json assets -q '.assets[0].url')"`,
      powershell:
        "$url = gh release view --repo VidGuiCode/az-where --json assets -q '.assets[0].url'; npm install -g $url",
    });
  });
});
