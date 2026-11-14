# 0013. Releases are made by the owner's hub

Status: Accepted (#58 stays open: no signing yet)

## Context

ADR 0008 made installs follow the `stable` tag, and left the owner to move it by hand. Nobody did, so origin had no tag and no install updated. Versions were also edited by hand in three files, and a plugin install updates only when `.claude-plugin/plugin.json` changes version.

## Decision

A release is a `vX.Y.Z` tag on `main`, a GitHub Release with notes from the merged PR titles, and the `stable` tag on the same commit. `kage release` does all of it (`runtime/release.ts`, rules in `core/release.ts`). It bumps `package.json`, `package-lock.json` and `plugin.json` in one commit: minor for any new feature, patch otherwise. It refuses unless the checkout is clean `main`, equal to `origin/main`, with green CI on that commit.

The owner's hub checks every hour (`autoRelease` in `router.ts`), because the job clock restarts with the hub. It releases the newest commit that is ahead of `stable` and completed an unbroken 24-hour run on this hub, even if the hub has moved on since (`soakGate` in `core/auto-update.ts`). A run is the hub's boots on one commit, kept as rows in the `boots` ledger in `kage.db`. A boot on a commit whose diff touches only files the hub never runs (the `INERT` table: docs, tests, skill text, licenses, version-only changes) continues the run. Any other boot starts a new run. A crash loop (three starts in 10 minutes, or a crash-loop DM) voids the run it hits, and the clean 24 hours restart at that moment. Also `kage doctor` must say `All good`. The release commit is the soaked commit plus the version bump, made in a scratch worktree and merged into main. One atomic push moves main, the tag and `stable`. Every hour, the job logs the next candidate and when its gate opens, so `kage logs` answers "when is the next release?". A failing gate DMs nothing.

Only the repo admin's hub does this. The hub asks `gh repo view --json viewerPermission` and acts on `ADMIN` only. A config flag could be set on any install, and push access alone also covers a collaborator. The admin check follows what GitHub allows, so it cannot drift from the repo.

## Consequences

- A merge reaches installs in about 24 hours after the owner's hub runs it, with no human step.
- Only a boot on new code restarts the clock, and a commit that soaked is released even after a later merge. Merging code more than daily on a hub that deploys each merge still never completes a run. `kage release` is the owner's override.
- The release commit changes only version files, so CI on it is not awaited before `stable` moves.
- The hub's own checkout must sit on `main`, level with `origin/main`: the owner pulls main by hand (the ship skill does), because the hub follows `stable` only when it is behind it.
- A release that fails after its push is finished by `kage release` (before the tag) or by `gh release create` (after it). The hub DMs the owner when that happens.
- Releases are unsigned (#58). A hub that can push to the repo can move `stable`.

## How it is checked

`core/tests/release.test.ts` (version bump, notes, grouping) and `core/tests/auto-update.test.ts` (`soakGate`, `inertChange`). `kage release --dry-run` prints the version and notes and changes nothing.
