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

### 0.3.0 - Cache And Refresh

- Persistent cache for locations and SKU data under the user's platform cache directory.
- `--refresh` flag to bypass cached ARM data.
- Quota/usage remains live.

### 0.3.1 - Diagnostics

- Typed ARM HTTP errors with status, endpoint, ARM code, and ARM message.
- Better human and JSON diagnostics for ARM failures.

### 0.3.2 - Suggest And Near

- `azw suggest <sku>`: one recommended region plus a short explanation of why it was chosen.
- `--near <city>` for location-aware suggestions using a built-in coordinate list.

### 0.3.3 - Docs And Legal

- README "How It Works" section.
- Architecture refresh for ARM REST, cache, and suggest behavior.
- `TRADEMARKS.md` and final unofficial-disclaimer audit.

### 0.3.4 - Updater UX

- `azw update` asks before installing newer releases.
- Bare `azw` can surface the same interactive update prompt after help.

### 0.3.5 - Azure Policy Accuracy

- Azure Policy allowed-location checks for scan commands.
- `POLICY_DENIED` verdicts so `pick` and `suggest` do not return policy-blocked regions.
- `--no-policy` escape hatch and policy metadata in JSON output.

### 0.3.6 - Deployable Family Search

- `azw available --family <prefix>` for finding deployable VM SKUs in a family.
- Default output shows only SKUs/regions that pass policy, SKU restrictions, and live quota.
- `--all` exposes blocked candidates and quota checks now require enough free vCPUs for the selected SKU.

### 0.3.7 - Pricing

- `azw price <sku> --region <name>` for retail compute price estimates.
- `azw available --price` to compare deployable family options with hourly and monthly estimates.
- Pricing remains optional enrichment and never changes deployability verdicts.

### 0.4.0 - Availability Discovery Foundation

- Reframe public docs from VM-only wording to Azure availability discovery with deep VM support.
- Introduce canonical explicit VM forms while preserving existing shortcuts:
  - `azw availability vm <sku> [--region <name>|--eu|--us|--asia|--geography <group>]`
  - `azw pick vm <sku> [scope]`
  - `azw suggest vm <sku> [scope]`
- Add generic resource availability discovery:
  - `azw availability resource <alias-or-type> [--region <name>|--eu|--us|--asia|--geography <group>]`
  - `azw check resource <alias-or-type> --region <name>`
- Add friendly aliases for common Azure resource types, starting with `storage-account`, `key-vault`, `web-app`, `app-service-plan`, `aks`, and `postgres-flexible-server`.
- Keep verdicts honest by distinguishing generic resource availability from full deployability.
- Standardize output with `--output` / `-o`:
  - `-o table`
  - `-o json`
  - `-o compact`
  - `-o value`
  - `-o name`
- Keep `--json`, `--compact`, and `--name` as compatibility aliases.

### 0.4.1 - Syntax Polish And Help Order

- Polish help text so canonical syntax is taught first and VM shortcuts are clearly labeled as compatibility aliases.
- List `availability`, `check`, `pick`, and `suggest` before legacy VM-specific commands in top-level help.
- Clarify `pick` and `suggest` argument labels around `vm <sku>` canonical syntax.
- Update legacy command descriptions to point toward `azw availability vm <sku>`.

### 0.4.2 - Real-World Smoke And Output Hardening

- Tighten `--output` / `-o` support across all commands, especially unsupported `value`/`name` modes.
- Add command-specific supported-mode errors before Azure calls start.
- Keep script output modes quiet: JSON carries policy metadata, while `value` and `name` emit only their intended values.
- Recognize compact shorthand forms such as `-ocompact` as machine output for progress/update suppression.
- Add smoke coverage for invalid output-mode combinations that should fail before Azure calls.
- Live-smoke canonical generic resource checks against ARM provider metadata and policy-restricted subscriptions.

### 0.4.3 - Resource Discovery And Release Automation

- `azw resources` to discover Azure resource types, with `--namespace` and `--grep` filters and `table`/`json`/`name` output, reusing the cached provider catalog.
- Tag-triggered GitHub Action that builds, tests, packs, and publishes the release tarball on every `v*` tag push.

## Planned

### 0.4.4 - Environment Doctor

- `azw doctor` to verify local prerequisites before any Azure scan: Azure CLI installed, a supported `az` version, an active login, a default subscription, and a mintable ARM token.
- Clear pass/fail checklist with install and `az login` hints, `-o json` for scripts, and a non-zero exit when a prerequisite is missing so CI can gate on it.
- Surfaces the existing `AzNotInstalledError` / `AzNotLoggedInError` signals up front instead of only on the first failing command. Top-level diagnostic command, outside the verb/kind grammar (like `update`).

### 0.4.5 - VM Comparison

- `azw compare vm B1s,B2s,D2s_v5 --eu`.
- Matrix-style view across regions and VM sizes.
- JSON shape for agents/scripts to choose fallback sizes automatically.
- Keep compare VM-only in this release; do not add resource comparison yet.

### 0.4.6 - Check Explanations And JSON Contracts

- Add evidence-based blocker details for `azw check vm` and `azw check resource`.
- Improve human explanations for `POLICY_DENIED`, `BLOCKED_FOR_SUB`, `QUOTA_FULL`, `SKU_NOT_OFFERED`, `QUOTA_UNKNOWN`, `RESOURCE_SUPPORTED`, and `RESOURCE_NOT_SUPPORTED`.
- Document stable JSON shapes for:
  - `availability vm`
  - `availability resource`
  - `check vm`
  - `check resource`
  - `pick vm`
  - `suggest vm`
- Keep explanations factual; do not claim full deployability for generic resource checks.

### 0.4.7 - IaC Preflight Foundation

- `azw verify <file.tf | file.bicep>`.
- Detect `location + sku` pairs before deployment, starting with VM resources.
- Report deployability, quota, policy, and subscription-blocking issues before `terraform apply` or Bicep deployment.
- Broaden to generic resource availability checks as the discovery layer matures.

### Later

- Deep service-specific checks beyond VMs, only after API research confirms reliable signals:
  - `azw check storage --kind StorageV2 --replication LRS --region <name>`
  - `azw check postgres --sku B_Standard_B1ms --region <name>`
  - `azw check aks --node-size B2s --region <name>`
  - `azw check appservice --plan B1 --region <name>`
- Optional tiny script snippets or env output, not full deployment generation.
- Possible multi-cloud modules if the Azure workflow proves stable first.

See [command-standard.md](command-standard.md) for command naming, output, and verdict rules.

Feedback and suggestions welcome via [GitHub Issues](https://github.com/VidGuiCode/az-where/issues).
