<div align="center">

# `az-where`

**Where in Azure can I actually deploy this?**

[![Release](https://img.shields.io/badge/release-v0.2.0-cb3837?logo=github&logoColor=white)](https://github.com/VidGuiCode/az-where/releases)
[![License](https://img.shields.io/badge/license-MIT-22c55e.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178c6?logo=typescript&logoColor=white)](tsconfig.json)
[![Platform](https://img.shields.io/badge/platform-windows%20%7C%20linux%20%7C%20macos-lightgrey)](#install)

</div>

```bash
azw B1s
```

Scans regions in parallel and checks SKU offering, subscription allowance, and vCPU quota for each one. Use `--eu` / `--us` / `--asia` or `--geography <group>` to narrow the scan.

> **Unofficial** community CLI. Not affiliated with, endorsed by, or sponsored by Microsoft. "Azure" and "Microsoft" are trademarks of Microsoft Corporation. `az-where` wraps the official [Azure CLI (`az`)](https://learn.microsoft.com/cli/azure/) and delegates all authentication to your existing `az login` session.

---

## Why not just use `az`?

Without `az-where`, answering "can I put a B1s somewhere?" looks like this:

```bash
# Step 1 — list the regions your subscription can see
az account list-locations --query "[].name" -o tsv

# Step 2 — for each region, is B1s offered? (pipe → loop → JSON)
for r in $(az account list-locations --query "[].name" -o tsv); do
  az vm list-skus --location "$r" --size Standard_B1s \
    --query "[?resourceType=='virtualMachines']" -o json
done
# ...60s+ per pass, output is raw JSON, no verdict.

# Step 3 — and quota? different command, different shape.
az vm list-usage --location eastus --query "[?name.value=='standardBsFamily']"
```

With `az-where`:

```bash
azw B1s
```

One call prints a table with the three checks combined into a single verdict per region.

## Install

**From a pinned release tarball (recommended):**

```bash
npm install -g https://github.com/VidGuiCode/az-where/releases/download/v0.2.0/az-where-0.2.0.tgz
```

**Always-latest via the GitHub release API** (resolves to the newest published `.tgz`):

```bash
# bash / zsh
npm install -g "$(gh release view --repo VidGuiCode/az-where --json assets -q '.assets[0].url')"
```

```powershell
# PowerShell 5.1 / 7 — capture the URL first, then install.
# (PS's native-arg passing mangles chained jq filters, so keep the -q expression simple.)
$url = gh release view --repo VidGuiCode/az-where --json assets -q '.assets[0].url'
npm install -g $url
```

**From source** (clone + build):

```bash
git clone https://github.com/VidGuiCode/az-where.git
cd az-where
npm install
npm run build
npm install -g .
```

**Uninstall:**

```bash
npm uninstall -g az-where
```

Requires **Node 20+** and the **[Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)** installed and logged in (`az login`). `az-where` never stores credentials — it uses whatever `az account show` already resolves to.

Two binaries are installed: `az-where` (long) and `azw` (short). They are the same tool. The rest of this README uses `azw`.

**Verify the install:**

```bash
azw --version          # → 0.2.0
azw where              # shows your current subscription / user
```

### Stay up to date

`azw` quietly checks GitHub once every 24 hours to see whether you're on the latest published release. If you're behind, a single dim line appears on stderr after your command finishes — stdout pipelines stay clean:

```
A new az-where is available: 0.3.0 (you're on 0.2.0). Run 'azw update' for install steps, or set AZ_WHERE_NO_UPDATE_CHECK=1 to silence this.
```

Ask for install commands tailored to the latest tag:

```bash
azw update             # human output with pinned + always-latest commands
azw update --json      # same thing, machine-readable
```

**Turn the check off** in any of the following ways:

| How | Scope |
|---|---|
| `--no-update-check` flag | This invocation only |
| `AZ_WHERE_NO_UPDATE_CHECK=1` env var | Every future invocation |
| `--json` / `--name` / `--compact` | Auto-suppressed (keeps machine output clean) |
| `CI=true` / `NO_COLOR=1` | Auto-suppressed |

The result is cached under `%LOCALAPPDATA%\az-where\version-check.json` on Windows and `$XDG_CACHE_HOME/az-where/` elsewhere. Fetch timeout is 1.5 s — offline? You won't know, and neither will `azw`.

## Quick start

| What you want | Type |
|---|---|
| Where can I deploy a B1s? | `azw B1s` |
| Narrow to a geography | `azw B1s --eu` · `azw B1s --us` · `azw B1s --asia` |
| Any other geography group | `azw B1s --geography "Middle East"` |
| Quota headroom, sorted by free vCPUs | `azw quota B1s` |
| Just give me one region name | `azw pick B1s` |
| What `--geography` values does my sub see? | `azw geos` |
| Which subscription am I signed in as? | `azw where` |

Run `azw <verb> --help` for every flag on a command.

## What you see

```
  REGION              GEO    LOCATION            OFFERED   QUOTA         VERDICT
  ─────────────────   ────   ─────────────────   ───────   ──────────    ─────────────────
  eastus              US     Virginia            ✓         8/10 free     ✓ DEPLOY
  westeurope          EU     Amsterdam           ✓         6/10 free     ✓ DEPLOY
  southeastasia       ASIA   Singapore           ✓         10/10 free    ✓ DEPLOY
  australiaeast       APAC   New South Wales     ✓         ?             ! QUOTA UNKNOWN
  francecentral       EU     Paris               ✓         0/10 free     ✗ QUOTA FULL
  germanywestcentral  EU     Frankfurt           ✗         —             ✗ SKU NOT OFFERED

Ready to deploy Standard_B1s (3): eastus, westeurope, southeastasia
Scanned 42 regions in 5.8s.
```

While the scan runs, stderr shows a live progress bar with an ETA:

```
Scanning for Standard_B1s [████████░░░░░░░░░░░░] 22/42 · 2.3s elapsed · ~2.1s remaining · francecentral
```

Colours auto-disable when output is piped, when `--json` is used, or when `NO_COLOR=1` / `CI=true` is set. The progress bar falls back to one log line per region (`[1/11] westeurope ✓ 0.8s`) in those environments.

## Global flags

| Flag | Purpose |
|---|---|
| `--eu` / `--us` / `--asia` | Filter to a `geographyGroup` |
| `--geography <group>` | Any exact group (run `azw geos` to list them) |
| `--concurrency <n>` | Parallel `az` calls during a scan (default 8) |
| `--json` | Structured JSON on stdout, colour and progress off |
| `--compact` | One-line JSON (saves tokens when piping to AI) |
| `--name` | One region name per line (on `regions`/`pick`), no decoration |
| `--no-interactive` | Fail instead of prompting (auto-detected in non-TTY) |
| `--no-update-check` | Skip the once-per-day GitHub release check for this run |

Environment:

- `NO_COLOR=1` — disable ANSI colour everywhere
- `CI=true` — disable the redrawing progress bar; use log lines instead

Exit codes: `0` success, `1` no match or generic error, `2` auth (`az login` required), `3` validation.

## Using with AI agents

Any agent that can run shell commands can use `azw` directly — no MCP server, no protocol. Pair `--json` with `--compact` to minimise token usage:

```bash
azw B1s --json --compact
```

Want one region name for a Terraform plan? `pick` prints exactly that:

```bash
terraform apply -var="location=$(azw pick B1s)"
```

`pick` exits with code 1 when no region qualifies, so your script fails fast.

## Recipes

**Terraform var injection**

```bash
export TF_VAR_location=$(azw pick B2s --eu)   # exits 1 if none deployable
terraform apply
```

**CI gate — fail the pipeline if your SKU lost all regions**

```yaml
- run: azw regions Standard_D2s_v5 --eu --name > /dev/null
```

Exit code 1 when nothing is AVAILABLE blocks the deploy job.

**Dynamic SKU selection**

```bash
sku=$(azw skus --eu --family B --json | jq -r '.skus[0].name')
region=$(azw pick "$sku" --eu) || exit 1
az vm create --size "$sku" --location "$region" ...
```

Notes:

- Every verb supports `--json`.
- `pick` and `regions --name` print raw strings, one per line — safe for `$(...)` capture.
- `CI=1` auto-suppresses spinners and the redrawing progress bar.
- Run `azw quota <sku>` before `az vm create` to avoid the classic `QuotaExceeded` surprise.

## How auth works

`az-where` never stores credentials, never asks for a token, and never reimplements sign-in. It shells out to the official `az` CLI, which already handles user logins, service principals, and managed identities. Whatever `az account show` currently resolves to is what `az-where` uses.

If `az` says you're not logged in, `az-where` exits with code 2 and prints `Run: az login`.

## How this differs from raw `az`

1. **Read-only.** `az-where` never creates, modifies, or deletes Azure resources. Ever.
2. **Visible progress.** Slow operations always show what they're doing and how long they've taken — inherited from the prior-art PowerShell prototypes in [context/](context/).
3. **Correct-by-default output.** UTF-8 terminal rendering so `Gävle` doesn't become `GΣvle`. Times formatted as `1m23s`, not raw seconds.
4. **Parallel where safe.** An N-region scan makes N concurrent `az` calls — the difference between a 60s scan and a 3s one.

## Development

```bash
bun install
bun run dev -- B1s            # live-run against the source
bun run build                  # → dist/
bun test                       # vitest
bun run verify-pack            # pack, install, smoke-test both bin names
```

See [docs/architecture.md](docs/architecture.md) for source layout and [docs/roadmap.md](docs/roadmap.md) for planned work.

## Vibe coding

This project was built with AI assistance — architecture, tooling decisions, and implementation were developed through human-AI collaboration. The code works and the design is intentional, but it was not written line by line without AI involvement.

Contributions welcome regardless of how they are written.

## License

[MIT](LICENSE)
