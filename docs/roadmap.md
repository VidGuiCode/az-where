# Roadmap

Planned improvements and features for upcoming releases. This is a living document: version targets can move based on usage, implementation risk, and feedback.

## Released

### 0.0.1 - Initial CLI

- `azw <sku>` positional shorthand with automatic `Standard_` normalization.
- `regions`, `quota`, `pick`, `geos`, and `where` commands.
- Geography shortcuts: `--eu`, `--us`, `--asia`, plus `--geography <group>`.
- Table, JSON, compact JSON, and name-only output modes.
- Live progress on TTY, log-line fallback in CI/non-TTY.

### 0.1.0 - ARM Scanner And SKU Discovery

- Direct ARM REST scanner using a bearer token from the current Azure CLI login.
- `azw skus` for discovering VM SKU names by geography, family, or single region.
- Faster region scans with parallel ARM requests.
- Subscription-blocked verdicts, SKU-not-offered folding, and improved output.

### 0.2.0 - Updates

- `azw update` command.
- Background GitHub release check with a 24h cache.
- Update-check suppression for scripts, CI, JSON/name output, and explicit opt-out.

### 0.2.1 - Startup UX And Docs

- Progress appears immediately during Azure token and region startup work.
- Startup scan wording now matches the user-facing scan command.
- README slimmed down into a shorter first-run guide.

### 0.2.2 - Update Fixes

- Bare `azw` can now show the post-help update banner.
- `azw update` forces a fresh GitHub release check instead of trusting the 24h cache.

## Planned

### 0.3.0 - Faster Repeated Scans And Smarter Picks

- Persistent cache for locations and SKU data under the user's platform cache directory.
- `--refresh` flag to bypass cached ARM data.
- Better diagnostics for auth failures, ARM failures, subscription blocks, SKU-not-offered, and quota exhaustion.
- `--near <city>` for `pick` / `suggest` so region choice can prefer a sensible location.
- `azw suggest <sku>`: one recommended region plus a short explanation of why it was chosen.
- Documentation cleanup so README, architecture, and roadmap all reflect the current ARM REST implementation.
- `TRADEMARKS.md` and final unofficial-disclaimer audit.

### 0.4.0 - Multi-SKU Comparison

- `azw compare --skus B1s,B2s,D2s_v5`.
- Matrix-style view across regions and SKU sizes.
- JSON shape for agents/scripts to choose fallback sizes automatically.

### 0.5.0 - IaC Preflight

- `azw verify <file.tf | file.bicep>`.
- Detect `location + sku` pairs before deployment.
- Report deployability, quota, and subscription-blocking issues before `terraform apply` or Bicep deployment.

### Later

- Pricing lookup via the Azure Retail Prices API.
- Broader Azure resource checks beyond VM SKUs.
- Possible multi-cloud modules if the Azure workflow proves stable first.

## Open Questions

- Should `pick` stay quiet by default forever, or gain an explicit `--progress` / `--verbose` mode?
- Should `suggest` replace most human uses of `pick`, leaving `pick` as the strict scripting command?
- Should cache be opt-in at first, or enabled by default with `--refresh` as the escape hatch?

Feedback and suggestions welcome via [GitHub Issues](https://github.com/VidGuiCode/az-where/issues).
