# Contributing

Thanks for contributing to `az-where`.

Bun is used for local development. Node.js 20+ is required for users installing the CLI — Bun is only needed if you are working on the source. The Azure CLI (`az`) must also be installed locally and you must be signed in (`az login`) to exercise the commands end-to-end.

## Principles

- Read-only: `az-where` must never create, modify, or delete Azure resources
- Delegate auth to `az` — do not reimplement credential handling
- Prefer stable command verbs over ad hoc flags
- Keep human-readable output clean; add machine-readable (`--json`) output deliberately
- Progress is visible: any operation > 2 seconds shows what it is doing
- Cache what is slow; parallelise what is safe

## Development

```bash
bun install
bun run typecheck
bun run build
bun test
```

## Testing

Tests are organised in `tests/`:

```
tests/
├── core/              # unit tests for src/core/ helpers
└── smoke/             # CLI smoke tests against dist/cli.js
```

Run tests: `npm test` or `bun test`.

## Project boundaries

- User-facing commands live in `src/commands/`
- Shared logic belongs in `src/core/`
- All `az` invocation goes through `src/core/az.ts` — command handlers never spawn processes directly
- Keep command handlers thin: resolve inputs, call core helpers, print output
