# 0008. Auto-update follows the `stable` tag

Status: Accepted. Amended by [0013](0013-releases-are-made-by-the-owners-hub.md).

## Decision

The hub moves its checkout only to origin's `stable` tag, with a fast-forward merge. A merge to `main` reaches no install until `stable` moves. Only the owner's hub moves it, after the commit has run there for 24 hours (0013). No CI job or other install pushes tags. A tag moved back is never followed. With no `stable` tag, nothing updates, and `kage doctor` says so.

## How it is checked

`core/tests/auto-update.test.ts` tests the skip rules and `soakGate` (`core/auto-update.ts`).
