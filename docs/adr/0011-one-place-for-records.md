# 0011. Every record of what Kage did lives in one place

Status: Accepted, partly built (#119, #52)

## Context

Kage, kagelets and connectors each leave records. The event log and ledgers are rows in `kage.db` (`runtime/ledger.ts:1`, opened at `router.ts:88`). The hub's output is text in `hub.log` (`runtime/hub-log.ts:6`). Small state files sit loose in the config folder: `boots` (`hub.ts:69`), `browser-seen` (`router.ts:215`), `daily-sent`, `retro-sent`, `dream-sent` (`router.ts:379-405`), `version` (`router.ts:495`), `status` (read at `setup.sh:93`) and `canvas-events.jsonl` (`connectors/slack.ts:221`). To see what happened, a person must look in many places.

## Decision

What happened goes in the event log in `kage.db`, as names and outcomes, never content (ADR 0010). `hub.log` holds process output only. Loose state files move into `kage.db`. A new connector or kagelet writes its records to the event log, not to a new file.

## Consequences

- One query answers "what did Kage do", and `kage top` and `kage logs` read one source.
- OpenTelemetry (#52) can export from one place.
- The state move (#119) must migrate the loose files once, safely to rerun.
- Known debt, until #119 lands: the eight loose files above.
- Cost: `setup.sh` reads some of these files in shell today, so each move needs a reader in `cli/`.

## How it is checked

Not yet enforced: issues #119 (state move) and #52 (OpenTelemetry). Check by hand: `ls ~/.config/kage` should list only config, secrets and `kage.db` files once #119 lands.
