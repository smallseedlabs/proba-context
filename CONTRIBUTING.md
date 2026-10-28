# Contributing to proba-context

By contributing you agree that your contributions are licensed under the Apache License 2.0.

## Development setup

```bash
npm install
npm run lint        # ESLint, zero warnings allowed
npm run typecheck   # sources and tests
npm test            # unit tests
npm run build
npm run watch:api     # context-api on http://127.0.0.1:3500
```

## Workflow

1. Create a feature branch: `git checkout -b feat/my-change`
2. Make your change, with tests
3. `npm run lint && npm run typecheck && npm test`
4. Commit with [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, ...)
5. Open a pull request against `main`

## Rules

- This repository is public: never commit secrets. Real `.env` files are gitignored.
- `packages/core` holds ports, config and pure logic; it does no network I/O. Adapters live in `packages/adapters`.
- `@smallseedlabs/proba-protocol` is pinned by release tag (`#vX.Y.Z`), never by commit, and bumped by hand.
- Fakes used by tests live only in `*.test.ts` files.
