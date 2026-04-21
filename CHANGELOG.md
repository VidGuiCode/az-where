# Changelog

## 0.1.0

### Performance

- `scanRegions` talks ARM REST directly via `fetch` instead of spawning `az` per region. One `az account get-access-token` up-front, then parallel REST calls. Typical global scan drops from ~250 s to ~13 s — `az` serialises concurrent invocations on the MSAL token-cache file lock on Windows, which turned "concurrency 8" into effectively concurrency 1.
- Live progress bar now redraws every 250 ms regardless of worker progress, so the elapsed clock keeps ticking through slow ARM calls.

### Output quality

- Filter Microsoft-internal regions (`*stg` staging, `*euap` early-access preview) out of every scan — they reported `regionType: "Physical"` but no customer can deploy into them, so showing them was a bug.
- New verdict `BLOCKED_FOR_SUB` (`✗ SUB BLOCKED`) distinguishes "your subscription is blocked here" from "Azure doesn't run this SKU here" (`SKU_NOT_OFFERED`). Different problem, different fix.
- Default table folds `SKU_NOT_OFFERED` rows into a one-line `+ N regions where Azure doesn't offer <sku>` note. `--all` restores the full table. `--json` always returns every row.
- `--all` flag on `regions` and `quota`.
- `listLocations` now reads from ARM (`/locations?api-version=2022-12-01`) instead of `az account list-locations`. Unicode city names (`Gävle`, `Querétaro`) survive on Windows; previously cmd.exe's cp1252/cp850 re-encoded them into `U+FFFD` before Node saw them.
- Windows consoles (PowerShell 5.1, cp1252) also receive an ASCII-folded `LOCATION` cell as a belt-and-braces fallback — `Gävle` → `Gavle`. `--json` output keeps the original Unicode.

### Errors

- `az` missing on PATH now raises `AzNotInstalledError` with a link to the install docs and exit code 127 (was a cryptic ENOENT).

### Fixes

- `--json` on `regions` / `quota` / `pick` now actually emits JSON. Commander was routing the flag to the parent program because it was declared on both levels.

## 0.0.1

Initial release. The golden path (`azw B1s --eu`) works end-to-end: coloured verdict table, live progress bar, footer shortlist.

### Features

- `azw <sku>` positional shorthand, auto-prepends `Standard_` (`B1s` → `Standard_B1s`)
- `azw regions` / `azw quota` / `azw pick` / `azw geos` / `azw where` verbs
- `--eu` / `--us` / `--asia` geography shortcuts, plus `--geography <group>` for anything else
- Parallel per-region scanner (default concurrency 8) for ~10× speedup over a global `az vm list-skus`
- Live progress bar with rolling ETA on TTY; log-line fallback on `CI=true` / `NO_COLOR=1` / non-TTY
- Coloured verdict column (`✓ DEPLOY` / `✗ QUOTA FULL` / `✗ SKU NOT OFFERED` / `! QUOTA UNKNOWN`)
- `--json`, `--compact`, `--name` output formats
- Both `az-where` and `azw` bin entries installed
- Exit codes: 0 success · 1 generic / pick empty · 2 auth failure · 3 validation

### Infrastructure

- TypeScript + ESLint + Prettier + Vitest + GitHub Actions CI
- `scripts/verify-pack.sh` smoke-tests both bin names after `npm pack`
- `src/core/az.ts` — single boundary for spawning the `az` CLI; never uses `exec`
