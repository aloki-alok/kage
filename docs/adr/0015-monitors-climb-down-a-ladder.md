# 0015. Monitors climb down a ladder, and the hub records every step

Status: Accepted

## Context

A recurring check (a schedule) ran as a full model turn in its thread's session each time it fired. On the owner's hub on 2026-11-15, five monitors cost $106 in a day over 466 runs, and almost every run found nothing new. Each run also replayed the thread's whole history. Backing off when quiet was rejected: it slows the very catch a monitor exists for. A smaller model alone was rejected: it still pays a model to read nothing new.

## Decision

A monitor is a ladder, and Kage moves each job down it when that is safe for the job:

| Rung | What runs | Model cost per check |
|---|---|---|
| 0. Model poll | a model turn on the clock | full |
| 1. Tripwire | a fixed probe command on the clock; the model wakes only when the normalized output changes | none |
| 2. Event | a subscription to a Slack channel; a matching post (bots included) wakes the model at once | none |
| 3. Distilled rule (later) | a rule built from the model's own past decisions; the model wakes on input unlike any it has seen | rare |
| 4. Retro note (later) | a line in the weekly retro when nobody reacts to a job's posts | none |

Three kinds of thing, kept apart:

1. **Capabilities, tested in code:** probes, channel subscriptions, a job's own session lane (`<thread>#side-job-<id>`), replay over past data, and live shadow runs.
2. **Judgment, the model's:** which rung a job uses, the probe and its ignore lines, the model a job runs on, and how much proof a job needs before it moves (replay depth, shadow length). Kage weighs what a missed catch costs, how often the event happens, how much history exists, and whether the asker relies on it. It tells the asker in one line what it chose and why.
3. **Mechanics, fixed in code, never the model's call:** a probe command is fixed when the job is made, and every script it runs is pinned by its content hash (a changed script stops the probe until a new yes). After a Slack reconnect, each watched channel is re-read from the last post seen. A job is never stopped silently: a probe that keeps failing pings the asker and keeps trying.

Every number is a setting with a default (`tripwires.*`, `harness.jobModel`, see docs/settings.md), and the owner or Kage may change it at runtime. Nothing about a job's pace, model or proof is hardcoded.

The hub tracks everything. Each probe tick, channel match, catch-up, wake, failure ping and Kage decision writes one event row on its run's trace (core/events.ts) and one `kage logs` line: ids and counts only, never message text. `kage stats` and the retro read those rows.

## Consequences

- A job moved to rung 1 or 2 costs nothing between events, so it can check more often than a model poll could afford.
- A probe runs in the hub, outside a session's sandbox. The pinned command and scripts are what keep that safe, so a probe may never run text a session can change without a new yes.
- A clock run no longer sees its thread's history. A job's prompt must stand on its own (the schedule tool already asks for that).
- Rungs 3 and 4 wait until rungs 1 and 2 have run on real jobs.

## How it is checked

- `core/tests/tripwire.test.ts`: normalize, fingerprint, the wake decision, and the failure ping.
- `runtime/tests/probes.test.ts`: an edited pinned script is refused, a timeout kills the probe, output is capped, and only the listed environment names reach it.
- `runtime/tests/channel-watch.test.ts`: matching (bots, regex), attachment text, the catch-up after a gap, and dedupe by ts.
- `runtime/tests/scheduler.test.ts`: a clock run lands on its job lane, and a watch stays in its thread.
- The event rows for each step have their own tests in the slice that writes them.
