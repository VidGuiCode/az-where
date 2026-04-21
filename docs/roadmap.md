# Roadmap

Planned improvements and features for upcoming releases. Living document — items may shift between releases or be dropped based on usage and feedback. See [context/VISION.md](../context/VISION.md) for the product thesis.

---

## v0.1 — Minimum viable scope

### Features

- ~~**`azw B1s --eu`** — positional-SKU shorthand, auto-prefixed to `Standard_B1s`~~ — shipped
- ~~**`azw regions <sku>`** — parallel per-region scan, coloured verdict table (`✓ DEPLOY` / `✗ QUOTA FULL` / `✗ SKU NOT OFFERED` / `! QUOTA UNKNOWN`)~~ — shipped
- ~~**`azw quota <sku>`** — same scan sorted by free vCPU descending~~ — shipped
- ~~**`azw pick <sku>`** — single region name on stdout; exit 1 if none qualify~~ — shipped
- ~~**`azw geos`** — enumerate `geographyGroup` values the subscription sees~~ — shipped
- ~~**`--eu` / `--us` / `--asia`** sugar over `--geography`~~ — shipped
- ~~**`--json` / `--compact` / `--name`** three output formats~~ — shipped
- ~~**Live progress bar with rolling ETA** on TTY, log-line fallback on CI / non-TTY / `NO_COLOR`~~ — shipped
- ~~**UTF-8 safe table rendering** (ANSI-aware padding via `src/core/color.ts`)~~ — shipped
- ~~**Post-pack smoke test** covers both `az-where` and `azw` bin entries~~ — shipped

### Pending for v0.1

- **TRADEMARKS.md** + prominent unofficial disclaimer audit

---

## v0.2 — Caching and diagnostics

- **Persistent SKU-list cache** under the user's XDG cache dir with a short TTL (5–15 min)
- **`--refresh` flag** to bypass the cache
- **Better diagnostics on `az` failures** — surface whether the failure was auth, quota, or SKU offering
- **`--near <city>`** option for `pick` that sorts by geographic proximity using `physicalLocation`

---

## v0.3 — Stretch scope

- **`azw suggest <sku>`** — one best region with a short explanation of *why* it was picked (quota headroom × latency × geography)
- **`azw verify <file.tf | file.bicep>`** — read resource definitions, check each `location + sku` pair, flag problems before you waste an `apply` cycle
- **`azw compare --skus B1s,B2s,D2s_v5`** — side-by-side matrix across sizes and regions

---

## Possible future modules

- Pricing lookup via the Azure Retail Prices API
- Multi-cloud (AWS/GCP) modules — the name and design leave room, but Azure comes first

---

Feedback and suggestions welcome via [GitHub Issues](https://github.com/VidGuiCode/az-where/issues).
