import { armList } from "./arm.js";
import { Spinner } from "./progress.js";
import type { AzLocation } from "./types.js";

/**
 * Aliases users actually type → the exact `metadata.geographyGroup` value
 * returned by `az account list-locations`. Aliases are case-insensitive.
 */
const GEO_ALIASES: Record<string, string> = {
  eu: "Europe",
  europe: "Europe",
  us: "US",
  america: "US",
  "north america": "US",
  asia: "Asia Pacific",
  apac: "Asia Pacific",
  "asia pacific": "Asia Pacific",
};

export function resolveGeography(input: string): string | null {
  const key = input.trim().toLowerCase();
  if (!key || key === "all") return null;
  return GEO_ALIASES[key] ?? input;
}

// Microsoft-internal regions that report `regionType: "Physical"` but no
// customer can deploy into: `*stg` (staging) and `*euap` (early-access preview,
// includes `centraluseuap` / `eastus2euap`). We exclude them by name suffix
// because the metadata doesn't reliably distinguish them otherwise.
const EXCLUDED_SUFFIX = /(stg|euap)$/i;

/**
 * Go straight to ARM instead of `az account list-locations`. Two wins:
 *   - Consistent latency with the rest of the scan (one shared token).
 *   - Unicode survives. `az` output on Windows comes through cmd.exe with
 *     the console's active code page (cp850/cp1252), which mangles names
 *     like `Gävle` into `G�vle` before Node sees them. ARM is pure UTF-8.
 */
export interface ListLocationsOptions {
  progressLabel?: string;
  etaSeconds?: number;
}

export async function listLocations(opts: ListLocationsOptions = {}): Promise<AzLocation[]> {
  const spinner = opts.progressLabel ? new Spinner(opts.progressLabel, opts.etaSeconds) : undefined;
  try {
    const locations = await armList<AzLocation>("/locations?api-version=2022-12-01");
    return locations
      .filter((l) => l.metadata?.regionType === "Physical" || !l.metadata?.regionType)
      .filter((l) => !EXCLUDED_SUFFIX.test(l.name));
  } finally {
    spinner?.done();
  }
}

export function filterByGeography(locations: AzLocation[], group: string | null): AzLocation[] {
  if (!group) return locations;
  return locations.filter((l) => l.metadata?.geographyGroup === group);
}

/** Short tag used in the table's GEO column. */
export function shortGeo(group: string | undefined): string {
  if (!group) return "-";
  if (group === "Europe") return "EU";
  if (group === "US") return "US";
  if (group === "Asia Pacific") return "APAC";
  if (group === "Canada") return "CA";
  if (group === "Middle East") return "ME";
  if (group === "Africa") return "AF";
  if (group === "South America") return "SA";
  return group.slice(0, 4).toUpperCase();
}
