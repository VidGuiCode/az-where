import { spawn } from "node:child_process";
import { normalizeTag } from "./updateCheck.js";

export function installCommands(latestTag: string): {
  pinned: string;
  bash: string;
  powershell: string;
} {
  const v = normalizeTag(latestTag);
  return {
    pinned: `npm install -g ${releaseTarballUrl(v)}`,
    bash: `npm install -g "$(gh release view --repo VidGuiCode/az-where --json assets -q '.assets[0].url')"`,
    powershell: `$url = gh release view --repo VidGuiCode/az-where --json assets -q '.assets[0].url'; npm install -g $url`,
  };
}

export function releaseTarballUrl(version: string): string {
  const v = normalizeTag(version);
  return `https://github.com/VidGuiCode/az-where/releases/download/v${v}/az-where-${v}.tgz`;
}

/**
 * A release tag must be a plain semver-ish string once the leading `v` is
 * stripped. The tag comes from GitHub's `tag_name`, so this is normally
 * trustworthy — but `installRelease` runs npm through a shell on Windows
 * (see below), so we refuse anything that isn't `MAJOR.MINOR.PATCH[-pre]`
 * before it ever reaches a command line.
 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

export function isValidReleaseVersion(tag: string): boolean {
  return VERSION_PATTERN.test(normalizeTag(tag));
}

export async function installRelease(latestTag: string): Promise<void> {
  if (!isValidReleaseVersion(latestTag)) {
    throw new Error(
      `Refusing to auto-install unexpected release tag "${latestTag}". ` +
        `Install manually: ${installCommands(latestTag).pinned}`,
    );
  }
  const url = releaseTarballUrl(latestTag);
  // Windows: npm is `npm.cmd`, and since Node 18.20/20.12/22 (CVE-2024-27980)
  // spawning a `.cmd` without a shell throws EINVAL. Run it through the shell
  // on Windows only — POSIX keeps the direct, shell-free spawn. The version is
  // validated above, so the URL contains no shell metacharacters.
  const useShell = process.platform === "win32";
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn("npm", ["install", "-g", url], {
      stdio: "inherit",
      shell: useShell,
      windowsHide: false,
    });
    child.on("error", reject);
    child.on("close", resolve);
  });

  if (code !== 0) {
    throw new Error(`npm install failed with exit code ${code ?? "unknown"}.`);
  }
}
