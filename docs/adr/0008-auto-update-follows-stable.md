# 0008. Auto-update follows the `stable` tag

Status: Accepted (#104). Amended by [0013](0013-releases-are-made-by-the-owners-hub.md): the owner's hub moves the tag by code.

## Context

A merge to `main` used to reach every install within 6 hours. A bad merge would break every hub with no warning.

## Decision

The hub moves its checkout only to origin's `stable` tag, with a fast-forward merge. The tag moves only after a commit has run on the repo owner's hub for 24 hours, with `kage doctor` at `All good` and no crash-loop DM. Only the owner's own hub moves it (0013). No CI job or other install pushes tags. A tag moved back is never followed.

## Consequences

- A merge reaches no install until the owner's hub moves the tag.
- A hotfix waits up to 24 hours unless the owner runs `kage release` sooner.
- With no `stable` tag, nothing updates, and `kage doctor` says so.

## How it is checked

`core/tests/auto-update.test.ts` tests the skip rules (`core/auto-update.ts`). The 24-hour rule is `soakGate` in `core/auto-update.ts`, tested in `core/tests/auto-update.test.ts`.
