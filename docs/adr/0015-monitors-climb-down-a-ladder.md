# 0015. Monitors climb down a ladder, and the hub records every step

Status: Accepted. Rungs 3 and 4 are not built.

## Decision

A monitor is a ladder. Kage moves each job down it when that is safe for the job:

| Rung | What runs | Model cost per check |
|---|---|---|
| 0. Model poll | a model turn on the clock | full |
| 1. Tripwire | a fixed probe command on the clock. The model wakes only when the normalized output changes | none |
| 2. Event | a subscription to a Slack channel, or a POST to the job's own webhook. A matching post or call wakes the model at once | none |
| 3. Distilled rule | a rule built from the model's own past decisions. The model wakes on input unlike any it has seen | rare |
| 4. Retro note | a line in the weekly retro when nobody reacts to a job's posts | none |

Three kinds of thing, kept apart:

1. **Capabilities, tested in code:** probes, channel subscriptions, per-job webhooks, and a job's own session lane (`<thread>#side-job-<id>`).
2. **Judgment, the model's:** which rung a job uses, the probe and its ignore lines, the model a job runs on, and how much proof a job needs before it moves. Kage weighs what a missed catch costs, how often the event happens, and whether the asker relies on it. It tells the asker in one line what it chose and why.
3. **Mechanics, fixed in code:**
   - A probe command is fixed when the job is made, and every script it runs is pinned by its content hash. A changed script stops the probe until a new yes.
   - After a Slack reconnect, each watched channel is re-read from the last post seen.
   - A job is never stopped silently: a probe that keeps failing pings the asker and keeps trying.
   - A run the job woke may never change or remove its own trigger, cron included. It suggests the change in its report, and a person's task applies it.
   - A clock run does not see its thread's history, so a job's prompt stands on its own.

Every number is a setting with a default (`tripwires.*`, `harness.jobModel`, docs/settings.md). Each probe tick, channel match, catch-up, wake, failure ping and Kage decision writes one event row on its run's trace and one `kage logs` line: ids and counts only.

## How it is checked

- `core/tests/tripwire.test.ts`: normalize, fingerprint, the wake decision, and the failure ping.
- `runtime/tests/probes.test.ts`: an edited pinned script is refused, a timeout kills the probe, output is capped, and only the listed environment names reach it.
- `runtime/tests/channel-watch.test.ts`: matching (bots, regex), attachment text, the catch-up after a gap, and dedupe by ts.
- `runtime/tests/scheduler.test.ts`: a clock run lands on its job lane, and a watch stays in its thread.
