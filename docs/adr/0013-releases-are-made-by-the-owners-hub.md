# 0013. Releases are made by the owner's hub

Status: Accepted. Known gap: releases are unsigned (#58).

## Decision

A release is a `vX.Y.Z` tag on `main`, a GitHub Release with notes from the merged PR titles, and the `stable` tag on the same commit.

`kage release` makes one (`runtime/release.ts`, rules in `core/release.ts`):
- It bumps `package.json`, `package-lock.json` and `plugin.json` in one commit: minor for any new feature, patch otherwise.
- It refuses unless the checkout is clean `main`, equal to `origin/main`, with green CI on that commit.
- The release commit is the soaked commit plus the version bump, made in a scratch worktree. One atomic push moves main, the tag and `stable`.
- If it fails after its push, `kage release` (before the tag) or `gh release create` (after it) finishes it, and the hub DMs the owner.

The owner's hub releases by itself, checked every hour (`autoRelease` in `hub/router.ts`):
- It releases the newest commit ahead of `stable` that completed an unbroken 24-hour run on this hub, even if the hub has moved on since (`soakGate` in `core/auto-update.ts`).
- A run is the hub's boots on one commit, kept in the `boots` ledger. A boot on a commit that changes only files the hub never runs (the `INERT` table: docs, tests, skill text, licenses, version-only changes) continues the run. Any other boot starts a new one.
- A crash loop (three starts in 10 minutes, or a crash-loop DM) voids the run, and `kage doctor` must say `All good`.
- Every hour it logs the next candidate and when its gate opens. A failing gate DMs nothing.
- The hub's checkout sits on `main`, level with `origin/main`.

Only the repo admin's hub releases. The hub asks `gh repo view --json viewerPermission` and acts on `ADMIN` only, so the rule follows what GitHub allows.

## How it is checked

`core/tests/release.test.ts` (version bump, notes, grouping) and `core/tests/auto-update.test.ts` (`soakGate`, `inertChange`). `kage release --dry-run` prints the version and notes and changes nothing.
