/**
 * Heuristics for handling a positional SKU argument like `azw B1s`.
 *
 * Azure VM size names are of the form `Standard_<letter><digit(s)><lowercase-suffix>`.
 * Users almost always mean `Standard_B1s` when they type `B1s`; we auto-prepend
 * the prefix. When the token doesn't look like a SKU we treat it as a verb and
 * let Commander resolve it normally.
 */

const SKU_PREFIX = "Standard_";
// Loose but deliberate: starts with a letter, uses only SKU-legal characters.
// The "must contain a digit" constraint is checked separately so `Standard_B1s`
// (underscore before the digit) still qualifies.
const SKU_SHAPE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Normalise a SKU token: prepend `Standard_` when the user dropped it. */
export function normalizeSku(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed.toLowerCase().startsWith("standard_")) {
    // Preserve canonical casing: `Standard_` + the rest the user gave us.
    return SKU_PREFIX + trimmed.slice("standard_".length);
  }
  return SKU_PREFIX + trimmed;
}

/** True when the token looks like an Azure VM size (so it can be a positional SKU). */
export function looksLikeSku(token: string): boolean {
  if (!token) return false;
  if (token.startsWith("-")) return false;
  if (!SKU_SHAPE.test(token)) return false;
  // VM sizes always have at least one digit; plain words like `regions` don't.
  return /\d/.test(token);
}
