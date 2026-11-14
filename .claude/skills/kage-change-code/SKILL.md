---
name: kage-change-code
description: Use when you change Kage code (core, connectors, runtime, cli, hooks) or add a test. Names the ADRs that bind the change, where code goes, the clean-code rules the structure test enforces, how to test it, and the public-repo check before a push.
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
| a specialist kagelet, or a rule every install should learn | 0012 (add or edit a skill in `skills/`) |
| any new file, a file near 300 lines, an export, or a move between folders | 0014 |

Done when you can name each binding ADR and the line of your change that obeys it. If a change breaks an ADR, stop and write a new ADR first. Do not bend the rule in code.

## 2. Put the code in its place

| Kind of code | Folder |
|---|---|
| A rule that takes inputs and returns a decision, with no I/O | `core/` |
| Hearing from a channel, turning a message into a `Task` | `connectors/` |
| Sessions, the store, the hub's state, file or process I/O | `runtime/` |
| A `kage <command>` | `cli/` (doctor checks go in `cli/doctor/`, one check per file) |

Copy the nearest sibling before you write anything new. `CONTRIBUTING.md` has the "Where things are" table. Write logs to stderr only. Write only syntax Node can strip (no enums).

## 3. Keep it clean

`tests/structure.test.ts` (ADR 0014) enforces the mechanical rules. The rest are judgment, and review checks them.

1. One file, one job, named for that job. If a file passes 300 lines, split it along its jobs before you add to it.
2. A function does one thing and fits on a screen (about 80 lines). A 6-way `if` on an action becomes one function per action.
3. Grep before you write a helper: `git grep -n "const <name>\|function <name>"`. Reuse the shared home below. If two files need the same new helper, put it in the shared home in the same PR.
4. Pass state in explicitly (a context object or arguments). A module-level `Map` needs a line that prunes it.
5. A list of connectors, tools or channels lives in one table. Never write `['email', 'whatsapp', 'voice']` again in a second file.
6. A pure decision goes in `core/` with its test, and its I/O wrapper goes in `runtime/` or `connectors/`.
7. When you replace code, delete the old path in the same PR. A migration that must stay a while gets `// compat: remove after YYYY-MM-DD`, and the test fails after that date.
8. Never add to a debt list in `tests/structure.test.ts`. When your change fixes a listed break, remove it from the list.

Shared homes (update this table when you add one):

| Need | Use |
|---|---|
| Read a webhook body, check a bearer token | `connectors/webhook.ts` (`readBody`, `bearerOk`) |
| A conversation, its session key, its connector | `core/conversations.ts` |
| Keep state across a restart | the store from `openStore` in `runtime/store.ts`: `store.load(name)` and `store.save(name, value)` (type `Saved`) |
| Who may start a task, a task line | `core/gate.ts` |
| What may go out | `core/outbound.ts` |

## 4. Test it

1. Write the test first in `<folder>/tests/<file>.test.ts`.
2. Run it and watch it fail because the behavior is missing, not because of an import error.
3. Make it pass.
4. Run only the touched files, the structure test, then the typecheck:

```sh
node --test core/tests/<file>.test.ts tests/structure.test.ts
npm run typecheck
```

Use fake fixtures only: ids like `U0TEST1`, `A0TEST1`, `C0TEST1`. Never run `npm test` for the whole suite.

## 5. Check the diff before you push

1. Run this grep on the diff. It must print nothing.

```sh
git diff origin/main | grep -nEi "/Users/|xox[abp]-|xapp-|AKIA|@[a-z0-9-]+\.(com|io|dev)"
```

2. Check the diff has no real Slack ids (`U` or `C` followed by 8 or more capitals and digits), no customer names and no real emails.
3. Check commits and the PR body carry no AI attribution and no em dashes (U+2014).

## 6. Open the PR

PR body: Summary (call tree or file tree), Evidence (the red then green commands), Merge danger (one-way or two-way door, widest blast radius). Do not merge it yourself.

## 7. Leave the next session better off

When the change taught you something a future session would trip on, record it before you finish:

- A mechanical mistake that could happen again becomes a rule in `tests/structure.test.ts` (with its debt), not a sentence.
- A judgment rule or a trap goes in step 3 above, or in the binding ADR.
- A new shared helper goes in the shared homes table.
- A new file goes in the CONTRIBUTING code map (the test fails without it).
