import type { RegionVerdict } from "./types.js";

export interface Coordinates {
  lat: number;
  lon: number;
}

export interface Suggestion {
  row: RegionVerdict;
  score: number;
  reason: string;
  factors: {
    free: number | null;
    limit: number | null;
    distanceKm?: number;
    geographyGroup?: string;
  };
}

const PLACES: Record<string, Coordinates> = {
  luxembourg: { lat: 49.6116, lon: 6.1319 },
  amsterdam: { lat: 52.3676, lon: 4.9041 },
  netherlands: { lat: 52.3676, lon: 4.9041 },
  paris: { lat: 48.8566, lon: 2.3522 },
  frankfurt: { lat: 50.1109, lon: 8.6821 },
  dublin: { lat: 53.3498, lon: -6.2603 },
  ireland: { lat: 53.3498, lon: -6.2603 },
  london: { lat: 51.5072, lon: -0.1276 },
  copenhagen: { lat: 55.6761, lon: 12.5683 },
  stockholm: { lat: 59.3293, lon: 18.0686 },
  gavle: { lat: 60.6749, lon: 17.1413 },
  "gävle": { lat: 60.6749, lon: 17.1413 },
  zurich: { lat: 47.3769, lon: 8.5417 },
  geneva: { lat: 46.2044, lon: 6.1432 },
  vienna: { lat: 48.2082, lon: 16.3738 },
  madrid: { lat: 40.4168, lon: -3.7038 },
  milan: { lat: 45.4642, lon: 9.19 },
  warsaw: { lat: 52.2297, lon: 21.0122 },
  oslo: { lat: 59.9139, lon: 10.7522 },
  norway: { lat: 59.9139, lon: 10.7522 },
  marseille: { lat: 43.2965, lon: 5.3698 },
  berlin: { lat: 52.52, lon: 13.405 },
  brussels: { lat: 50.8503, lon: 4.3517 },
};

export function resolvePlace(input: string): Coordinates | null {
  return PLACES[normalizePlace(input)] ?? null;
}

export function knownPlaces(): string[] {
  return Object.keys(PLACES).sort();
}

export function chooseSuggestion(
  rows: RegionVerdict[],
  near?: Coordinates | null,
): Suggestion | null {
  const candidates = rows.filter((r) => r.verdict === "AVAILABLE");
  if (candidates.length === 0) return null;

  const ranked = candidates
    .map((row) => buildSuggestion(row, near))
    .sort((a, b) => {
      const score = b.score - a.score;
      if (score !== 0) return score;
      return a.row.region.localeCompare(b.row.region);
    });

  return ranked[0] ?? null;
}

function buildSuggestion(row: RegionVerdict, near?: Coordinates | null): Suggestion {
  const free = row.free ?? 0;
  const regionCoords = coordinatesForRegion(row);
  const distanceKm = near && regionCoords ? Math.round(distanceKmBetween(near, regionCoords)) : undefined;
  const score = free * 1000 - (distanceKm ?? 0);
  const quota = row.limit !== null && row.free !== null ? `${row.free}/${row.limit} free` : "quota available";
  const nearReason =
    distanceKm !== undefined ? ` and is about ${distanceKm} km from the requested location` : "";
  return {
    row,
    score,
    reason: `${row.region} is deployable with ${quota}${nearReason}.`,
    factors: {
      free: row.free,
      limit: row.limit,
      distanceKm,
      geographyGroup: row.geographyGroup,
    },
  };
}

function coordinatesForRegion(row: RegionVerdict): Coordinates | null {
  return (
    resolvePlace(row.physicalLocation ?? "") ??
    resolvePlace(row.displayName) ??
    resolvePlace(row.region)
  );
}

function normalizePlace(input: string): string {
  return input.trim().toLowerCase();
}

function distanceKmBetween(a: Coordinates, b: Coordinates): number {
  const r = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
