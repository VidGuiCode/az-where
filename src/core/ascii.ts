/**
 * PowerShell 5.1 and legacy Windows consoles default to cp1252, so UTF-8
 * bytes emitted by Node render as `G�vle` for `Gävle`. This helper folds
 * non-ASCII back to a readable approximation (`Gavle`). Used only for the
 * table's LOCATION cell on Windows; JSON output and the in-memory
 * `RegionVerdict` keep the original Unicode.
 */
export function asciiSafe(s: string | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7f]/g, "?");
}
