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

export async function installRelease(latestTag: string): Promise<void> {
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  const url = releaseTarballUrl(latestTag);
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(npmBin, ["install", "-g", url], {
      stdio: "inherit",
      windowsHide: false,
    });
    child.on("error", reject);
    child.on("close", resolve);
  });

  if (code !== 0) {
    throw new Error(`npm install failed with exit code ${code ?? "unknown"}.`);
  }
}
