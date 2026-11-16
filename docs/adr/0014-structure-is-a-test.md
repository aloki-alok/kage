# 0014. Structure rules are a test, and their debt only shrinks

Status: Accepted

## Decision

`tests/structure.test.ts` runs in `npm test`, so CI fails when a rule breaks.

| Rule | Why |
|---|---|
| `core/` does no I/O, reads no environment, sets no timers, and imports only `core/` | ADR 0001: rules a test drives with plain inputs |
| `runtime/` and `connectors/` never import a root file | the root files wire the hub. A module below them must not reach up |
| A source file is 300 lines or fewer, not counting import lines | one file, one job. Imports do not count, so splitting a module never counts against its importers |
| Every `core/` and `runtime/` file is in the CONTRIBUTING code map | a newcomer, human or agent, finds code from the map |
| A `core/` export is used by another file (a shell script counts), or by its own file and a test that drives it | an export nobody needs reads like an API, and code only a test calls is dead |
| `compat: remove after YYYY-MM-DD` code is gone by its date | migrations end |

Each rule lists today's breaks as debt by name. A new break fails. A fixed break that is still listed also fails, so the list only shrinks. A long file may not grow past its listed size. Never add to a debt list: fix the code, or write a new ADR that changes the rule.

## How it is checked

It is the check. Edit a `core/` file to import `node:fs`, and `node --test tests/structure.test.ts` fails with `impureCore: new breaks`.
