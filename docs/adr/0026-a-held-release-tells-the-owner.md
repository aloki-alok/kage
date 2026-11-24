# 0026. A soaked commit that fails a release check tells the owner once

Status: Accepted. Amends ADR 0013, which said a failing gate DMs nothing.

## Decision

The owner's hub still releases by itself (ADR 0013). A commit that finished its 24-hour run is held, and not released, when any of these is true:

- an error kind (an `error` event code, `src/core/telemetry.ts`) shows up during the run, and the hub had none of that kind in the 7 days before the run started;
- `kage doctor` is not `All good`;
- CI or the upgrade drill is not green on that commit (`RELEASE_CHECKS`).

A held commit DMs the owner once for each commit and reason, with what failed. The hub saves the mark only after the DM goes out, so a failed DM is tried again next hour. A candidate still inside its 24 hours DMs nothing, because waiting is not a failure.

The notes come from the merged PR titles in six fixed sections: New features, Access and safety, Optimizations, Bug fixes, Under the hood and Upgrading. Each title loses its type and scope. The owner edits the notes afterwards with `gh release edit`.

## Why

Without the DM, a doctor failure or a red CI run held `stable` back with no word to anyone. The hub only logged why, and nobody reads that log on a quiet day. A new kind of error during the soak is the closest signal the hub has that the candidate broke something no test covers.

## How it is checked

`src/core/tests/auto-update.test.ts` (a new error kind holds the run, a kind seen the week before does not, an error after the run ended does not), `src/core/tests/release.test.ts` (sections and bump), `src/hub/tests/updates.test.ts` (one DM per commit and reason, retried when it did not go out).
