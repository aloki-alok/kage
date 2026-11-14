# 0008. Auto-update follows the `stable` tag

Status: Accepted (#104)

## Context

A merge to `main` used to reach every install within 6 hours. A bad merge would break every hub with no warning.

## Decision

The hub moves its checkout only to origin's `stable` tag, with a fast-forward merge. The tag moves only after a commit has run on the repo owner's hub for 24 hours, with `kage doctor` at `All good` and no crash-loop DM. The owner's Kage moves it by hand. No code, CI or script pushes tags. A tag moved back is never followed.

## Consequences

- A merge reaches no install until the owner moves the tag.
- A hotfix waits up to 24 hours unless the owner moves the tag sooner.
- With no `stable` tag, nothing updates, and `kage doctor` says so.

## How it is checked

`core/tests/auto-update.test.ts` tests the skip rules (`core/auto-update.ts:15`). The 24-hour rule is a stated process in `AGENTS.md` and `docs/settings.md`, not code.
