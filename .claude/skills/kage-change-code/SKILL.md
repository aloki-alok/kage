---
name: kage-change-code
description: Use when you change Kage code (core, connectors, runtime, cli, hooks) or add a test. Names the ADRs that bind the change, where code goes, how to test it, and the public-repo check before a push.
---

Kage is a public repo. Follow these steps for any change to `.ts` files.

## 1. Find the binding ADRs

Read the ADRs in `docs/adr/` that match what you touch. Do not copy their text into code or docs. Link them.

| If you touch | Read |
|---|---|
| a file in `core/` | 0001 |
| a connector, or who may start a task | 0002, 0004 |
| `runtime/store.ts` or a new table | 0003 |
| who counts as the owner, `senderOf`, a guard | 0004, 0005 |
| tool limits for a kind of sender | 0005 |
| settings, tokens, `config.ts`, the env file | 0006 |
| a test file | 0007 |
| auto-update or the `stable` tag | 0008 |
| anything that posts to Slack or another channel | 0009 |
| the event log or a ledger | 0010 |

Done when you can name each binding ADR and the line of your change that obeys it. If a change breaks an ADR, stop and write a new ADR first. Do not bend the rule in code.

## 2. Put the code in its place

| Kind of code | Folder |
|---|---|
| A rule that takes inputs and returns a decision, with no I/O | `core/` |
| Hearing from a channel, turning a message into a `Task` | `connectors/` |
| Sessions, the store, the hub's state, file or process I/O | `runtime/` |
| A `kage <command>` | `cli/` (doctor checks go in `cli/doctor/`, one check per file) |

Copy the nearest sibling before you write anything new. `CONTRIBUTING.md` has the "Where things are" table. Write logs to stderr only. Write only syntax Node can strip (no enums).

## 3. Test it

1. Write the test first in `<folder>/tests/<file>.test.ts`.
2. Run it and watch it fail because the behavior is missing, not because of an import error.
3. Make it pass.
4. Run only the touched files, then the typecheck:

```sh
node --test core/tests/<file>.test.ts
npm run typecheck
```

Use fake fixtures only: ids like `U0TEST1`, `A0TEST1`, `C0TEST1`. Never run `npm test` for the whole suite.

## 4. Check the diff before you push

1. Run this grep on the diff. It must print nothing.

```sh
git diff origin/main | grep -nEi "/Users/|xox[abp]-|xapp-|AKIA|@[a-z0-9-]+\.(com|io|dev)"
```

2. Check the diff has no real Slack ids (`U` or `C` followed by 8 or more capitals and digits), no customer names and no real emails.
3. Check commits and the PR body carry no AI attribution and no em dashes (U+2014).

## 5. Open the PR

PR body: Summary (call tree or file tree), Evidence (the red then green commands), Merge danger (one-way or two-way door, widest blast radius). Do not merge it yourself.
