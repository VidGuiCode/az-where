# Contributing to az-where

Open an issue or pull request with the command you ran, what you expected, and what happened. For Azure-specific behavior, include the resource type or VM size, region, and relevant error code. Redact subscription IDs, tenant IDs, and credentials from logs.

## Turn roadmap work into an issue

Start with the [roadmap work queue](docs/roadmap.md#work-queue). Give the issue a title that names the result, such as “Research Storage SKU availability by subscription and region.” Include the user question, the work in scope, any prerequisite, and an observable definition of done.

When a feature depends on Azure API behavior, track the research separately from implementation. Close the research issue with the evidence and a decision to implement, narrow the proposal, or defer it. Use that decision to define the CLI inputs, output, and tests for any implementation issue.

## Set up the project

Use Node.js 20 or later. The repository’s `.nvmrc` and GitHub Actions use Node.js 20.

```bash
npm ci
npm run build
node dist/cli.js --help
```

Bun is optional for running TypeScript directly with `bun run dev -- --help`. Use npm for the test workflow so the CLI smoke tests run against a fresh build.

## Verify a change

```bash
npm run typecheck
npm run lint
npm test
```

- `tests/core/` covers classification, parsers, caching, and JSON output.
- `tests/smoke/` invokes the compiled CLI to check command and output behavior.
- `tests/live/` makes Azure Resource Manager calls and is opt-in. Install the Azure CLI, sign in, select the subscription you want to check, and run the live suite explicitly.

**Bash**

```bash
AZW_LIVE=1 npm test -- tests/live
```

**PowerShell**

```powershell
$env:AZW_LIVE = '1'
try { npm test -- tests/live } finally { Remove-Item Env:AZW_LIVE }
```

For packaging changes, `npm run verify-pack` uses Bash to pack the CLI, install it into a temporary npm project, and check both executable names.

## Maintain the CLI and docs

- Keep Azure operations read-only and delegate authentication to the Azure CLI through `src/core/az.ts`.
- Put argument handling and rendering in `src/commands/`. Keep shared classification and request logic in `src/core/`.
- Use the [command standard](docs/command-standard.md) for syntax and output modes. Update the [JSON contracts](docs/json-contracts.md) and corresponding tests when a supported payload changes.
- Check the README examples and command help when changing user-facing syntax. Record shipped behavior in the [changelog](CHANGELOG.md).
- Keep progress on stderr and preserve clean stdout for scripts.

See the [architecture guide](docs/architecture.md) for the request flow and ownership of the core modules.
