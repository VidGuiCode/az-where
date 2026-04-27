# Changelog

## 0.2.2

### Fixes

- Bare `azw` now prints the post-help update banner instead of exiting before the update check can run.
- `azw update` now forces a fresh GitHub release check instead of trusting a still-fresh 24h cache.

## 0.2.1

### UX

- Show progress immediately during Azure token and region startup work for `regions`, positional SKU scans, `pick`, `quota`, `geos`, `where`, and `update`.
- Keep scan wording user-facing: SKU scans show `Scanning for <sku>` from startup, then switch to the per-region progress bar once the region count is known.
- Slim the README into a shorter first-run guide and fix stale concurrency/ARM wording.

## 0.2.0

### Features

- **`azw update`** verb — checks GitHub Releases for the latest published version and prints install commands (pinned tarball, always-latest via `gh`, and a PowerShell-safe one-liner). `--json` returns the same data as a machine-readable payload. No self-install — the user copies the command, so privilege elevation and global npm bin management stay visible and explicit.
- **Background version check** on every invocation. Hits `api.github.com/repos/VidGuiCode/az-where/releases/latest` with a 1.5 s timeout, caches the result for 24 h under `%LOCALAPPDATA%\az-where\version-check.json` (Windows) / `$XDG_CACHE_HOME/az-where/` (macOS/Linux). If the installed version is behind, a single dim line is written to **stderr** after the verb's output — stdout pipelines stay untouched.
- **Opt-out matrix** for the banner, in order of specificity: `--no-update-check` (this run), `AZ_WHERE_NO_UPDATE_CHECK=1` (persistent), and auto-suppression under `--json` / `--name` / `--compact` / `CI=true` / `NO_COLOR=1`. The explicit `azw update` verb bypasses all suppression except the explicit opt-outs, so `azw update --json` always attempts the check — same pattern as `npm outdated` vs `update-notifier`.

### Reliability

- Network failures during the version check are swallowed silently (`AbortSignal.timeout(1500)` + caught fetch errors). Offline shouldn't mean broken.
- Cache write failures are tolerated too — the worst case is re-fetching next run, capped at the unauth'd GitHub rate limit of 60/h/IP.

## 0.1.0

### Discovery

- New `azw skus` verb for answering "what SKU names exist that I could try?" without reading Microsoft's size docs end-to-end. One ARM call to the subscription-level skus catalog returns every VM SKU, deduped by name, with family / vCPU / RAM / regions columns. Filters: `--eu` / `--us` / `--asia` / `--geography <group>` (client-side on `locations[]`), `--family <letter>` (e.g. `B`, `D`, `E`).
- `azw skus --region <name>` fast path hits the location-scoped skus endpoint and returns in ~2–3 s instead of the ~25–40 s full-catalog scan. Rejects combining `--region` with geography flags (exit 3) rather than silently ignoring them.
- New `Spinner` class in `core/progress.ts` for indeterminate ARM calls — braille frames with live elapsed and ETA. Displays "⠋ Fetching SKU catalog · 3.2s / ~35s" and flips to "(est. ~35s)" if the real call overruns. Used by `skus` during the catalog fetch.

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
- `pick <sku>` now exits with code 1 when every region scan was ineligible (previously exited 0 with an empty string, which silently broke `$(azw pick ...)` captures in shell pipelines).
- `quota <sku>` filters to regions where the SKU is actually offered by default, so the table stops showing "0/10 free" for SKUs that aren't available there anyway. `--all` restores the full view.
- Splash screen now mentions `Requires: az login` up-front, so the first-run "not authenticated" error is traceable to its cause without reading the help text.

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
