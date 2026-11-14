# 0014. Structure rules are a test, and their debt only shrinks

Status: Accepted

## Context

ADR 0001 and the CONTRIBUTING code map were written down but checked by hand, so they drifted. By 2026-11-15, 18 runtime and connector files imported the root `config.ts`, 11 core files were missing from the code map, and `runtime/kage-tools.ts` had grown to 832 lines. A rule nobody runs is a wish.

## Decision

`tests/structure.test.ts` runs in `npm test`, so CI fails when a rule breaks. Today it checks:

| Rule | Why |
|---|---|
| `core/` does no I/O, reads no environment, sets no timers, and imports only `core/` | ADR 0001: rules a test drives with plain inputs |
| `runtime/` and `connectors/` never import a root file | the root files wire the hub; a module below them must not reach up |
| A source file is 300 lines or fewer | one file, one job; a long file is where unrelated jobs pile up |
| Every `core/` and `runtime/` file is in the CONTRIBUTING code map | a newcomer, human or agent, finds code from the map |
| A `core/` export is used by another file (a shell script counts), or by its own file and a test that drives it | an export nobody needs reads like an API someone depends on, and code only a test calls is dead |
| `compat: remove after YYYY-MM-DD` code is gone by its date | migrations end; old paths do not stay forever |

Each rule lists today's breaks as debt by name. A new break fails. A fixed break that is still listed also fails, so the list only shrinks. A long file may not grow past its listed size.

## Consequences

- Never add to a debt list. Fix the code, or write a new ADR that changes the rule.
- A new rule enters with its debt listed, then the debt is paid one PR at a time.
- The test reads files as text, so it costs about 100 ms.

## How it is checked

It is the check. Edit a `core/` file to import `node:fs`, and `node --test tests/structure.test.ts` fails with `impureCore: new breaks`.
