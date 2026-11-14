# 0007. Tests live in `<folder>/tests/`

Status: Accepted (#111)

## Context

Tests next to source files cluttered each folder, and tests in one far-away folder were hard to match to their code.

## Decision

A test for `<folder>/x.ts` is `<folder>/tests/x.test.ts`. Test helpers live there too (`runtime/tests/fake-sdk.ts`). Tests are never loose beside the code they test.

## Consequences

- `npm test` finds tests by glob (`package.json:12`: `core/`, `connectors/`, `runtime/`, `cli/`).
- A new folder with tests must be added to that glob.
- Extension tests are the exception: `extension/tests/e2e/` runs in Chromium (`CONTRIBUTING.md`).

## How it is checked

`git ls-files | grep '\.test\.ts$' | grep -v '/tests/'` prints nothing today. No hook enforces it.
