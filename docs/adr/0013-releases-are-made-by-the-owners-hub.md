# 0013. Releases are made by the owner's hub

Status: Accepted. Known gap: releases are unsigned (#58).

## Decision

A release is a `vX.Y.Z` tag on `main`, a GitHub Release with notes from the merged PR titles, and the `stable` tag on the same commit.

`kage release` makes one (`src/runtime/release.ts`, rules in `src/core/release.ts`):
- It bumps `package.json`, `package-lock.json` and `plugin.json` in one commit: minor for any new feature, patch otherwise.
- It refuses unless the checkout is clean `main`, equal to `origin/main`, and the commit passed both CI and the upgrade drill (`RELEASE_CHECKS` in `src/core/release.ts`).
- The upgrade drill (`.github/workflows/upgrade.yml`, #312) is what a teammate does: install the previous release, keep an old env file, `kage update --stable` to the candidate, then `kage doctor`. It runs on Linux, macOS arm and macOS Intel, and once with a PATH that has no Homebrew.
- The release commit is the soaked commit plus the version bump, made in a scratch worktree. One atomic push moves main, the tag and `stable`.
- If it fails after its push, `kage release` (before the tag) or `gh release create` (after it) finishes it, and the hub DMs the owner.

The owner's hub releases by itself, checked every hour (`autoRelease` in `src/hub/router.ts`):
- It releases the newest commit ahead of `stable` that completed an unbroken 24-hour run on this hub, even if the hub has moved on since (`soakGate` in `src/core/auto-update.ts`).
- A run is the hub's boots on one commit, kept in the `boots` ledger. A boot on a commit that changes only files the hub never runs (the `INERT` table: docs, tests, skill text, licenses, version-only changes) continues the run. Any other boot starts a new one.
- A crash loop (three starts in 10 minutes, or a crash-loop DM) voids the run, and `kage doctor` must say `All good`.
- Every hour it logs the next candidate and when its gate opens. A candidate still inside its 24 hours DMs nothing. A soaked commit that fails a check is held and DMed once (ADR 0026).
- The hub's checkout sits on `main`, level with `origin/main`.

Only the repo admin's hub releases. The hub asks `gh repo view --json viewerPermission` and acts on `ADMIN` only, so the rule follows what GitHub allows.

## How it is checked

`src/core/tests/release.test.ts` (version bump, notes, grouping, the checks a candidate must pass) and `src/core/tests/auto-update.test.ts` (`soakGate`, `inertChange`). `kage release --dry-run` prints the version and notes and changes nothing.

## Release and update mechanics

- A release merges in a scratch worktree, so the hub's own code is never touched. A push that landed but timed out is finished by `gh release create`. (`src/runtime/release.ts`)
- The doctor is the slow check, so it runs only after the cheap ones pass. A skip logs one line and DMs nothing. (`src/runtime/release.ts`, `src/hub/updates.ts`)
- A crash voids only the soak run it hits. The new run starts clean on the same commit. (`src/core/auto-update.ts`)
- The auto-update mark clears only after the DM is sent, so a failed DM is retried at the next start. (`src/runtime/auto-update.ts`)
- The auto-update job runs a fast-forward only. A folder with its own `.git` inside someone's bigger repo is never pulled. (`src/runtime/auto-update.ts`)
