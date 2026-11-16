# 0016. A kagelet can own an objective, measured by a number

Status: Accepted. Built so far: `work` objectives for kagelets. `when_met: quiet` and objectives on a thread's watch jobs are not built yet.

## Decision

An objective is a probe (ADR 0015) with a target.

| Field | Means | Example |
|---|---|---|
| `objective` | The outcome in plain words | Keep the signup error rate low |
| `measure` | A probe command that prints exactly one line `value: <n>` | `./scripts/signup-errors.sh` |
| `target` | A comparison the value must meet | `<= 2` |
| `when_met` | `work` or `quiet` | `work` |

How it runs:

1. **The hub measures with no model,** on the job's clock, as it runs any probe: the command is fixed and pinned, and a teammate's measure needs the owner's card. Output that is not exactly one `value: <n>` line is a failed measure, never a guessed number. A failed measure reaches every run as a failed reading, and the kagelet says so in its report, which reaches Kage. It does not ping on its own (a cut: add the `tripwires.failPing` ping if failures go unreported).
2. **The model wakes on the state, not on the output.** The state is `working` (target not met) or `met`. While `working`, each clock run wakes the job with the objective, the value, the target and the last `objectives.trendRuns` values, quoted as data. The job plans its own work toward the target and reports what it did.
3. **The number is a scoreboard.** With `when_met: work` (the default for a kagelet), every run reads the objective, the value, the target and the trend, and works on. Meeting the target never stops a worker: a kagelet that keeps two posts a week over 500 views still writes the next post.
   With `when_met: quiet` (the default for a thread's watch job), after `objectives.holdRuns` measures in a row meet the target, the state is `met`, and the hub stops waking the model. It keeps measuring. The first measure that misses flips the state back to `working` and wakes the job once with the slip.
4. **Kage proposes the measure, a person fixes it.** Kage writes the three fields from what the person asked ("keep signups healthy") and says in one line which number it picked and why. A run woken by the job may never change its own measure or target (ADR 0015: a woken run never changes its own trigger), so the model cannot move the goalposts to "met". It suggests the change in its report, and a person's task applies it. A change restarts the `holdRuns` count.
5. **A kagelet uses it the same way.** A kagelet with an objective is synced into a probe job like any other kagelet schedule. Only with `when_met: quiet` are its own cron runs skipped while `met`.

Every number is a setting with a default: `kagelets.measureMinutes` (60), `kagelets.trendRuns` (5), and for `quiet` objectives, when they are built, `objectives.holdRuns` (3). The hub writes one event row per measure and per state change (`working`, `met`, `slipped`, `failed`) with ids and the state only. The value itself stays out of the event log (ADR 0010) and goes only to the woken run and its report.

A quiet objective costs no model while it holds. Every report shows the measure and its value, so a person sees what is being chased.

## How it is checked

To be written with the code: the `value: <n>` parse (anything else fails), the target comparison, every run of a `work` objective carries the value and trend, met or not; for `quiet`, `working` to `met` after `holdRuns`, `met` to `working` on one miss with one wake, no wake while `met`; a woken run refused when it changes its own measure or target, and one event row per step with no value in it.
