# 0007. Tests live in `<folder>/tests/`

Status: Accepted

## Decision

A test for `<folder>/x.ts` is `<folder>/tests/x.test.ts`. Test helpers live there too (`runtime/tests/fake-sdk.ts`). `npm test` finds tests by glob (`package.json`), so a new folder with tests is added to that glob. The Chrome extension's end-to-end tests are the exception: `extension/tests/e2e/` runs in Chromium.

## How it is checked

`git ls-files | grep '\.test\.ts$' | grep -v '/tests/'` prints nothing. No hook enforces it.
