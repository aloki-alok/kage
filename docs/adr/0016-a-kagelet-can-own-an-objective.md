# 0016. A kagelet can own an objective, measured by a number

Status: Proposed

## Context

A kagelet today has a job (a prompt), a schedule and a grant. It can do a task again and again, but it cannot tell whether the work is winning, or when it is done. People hand work over in steps: first a task, then an outcome, then the whole job. Kage stops at the first step.

Once execution is cheap, the work that fails is the goal, not the doing. An outcome Kage can check by itself needs a number, so the number has to be part of the kagelet, not something the model makes up each run.

## Decision

A kagelet file may hold an objective. Three front-matter lines, all optional together:

| Line | Means | Example |
|---|---|---|
| `objective` | The outcome in plain words | Keep the signup error rate low |
| `measure` | A command, or a `db_read` query, whose output ends in one number | `./scripts/signup-errors.sh` |
| `target` | A comparison the number must meet | `<= 2` |

How it runs:

1. Before each run, the hub runs the measure with no model, the same way it runs a probe (ADR 0015): the command is fixed and pinned, and a teammate's measure gets one approval card. The last number in the output is the value.
2. The run gets the objective, the value, the target and the recent trend, quoted as data. The kagelet plans its own work toward the target and reports what it did and why.
3. When the target holds for `objectives.holdRuns` runs in a row (a setting), the kagelet is met. A met kagelet does not stop. It drops to watching: its measure becomes a probe, and no model runs while the number holds. If the number slips past the target, the next run works on it again.
4. Kage writes the three lines from what the person asked ("keep signups healthy"), and says in one line what number it picked and why. The person can change any line, and so can Kage when it finds a better measure.

Every number is a setting with a default (`objectives.*`). The hub writes one event row and one `kage logs` line per measure, per state change (working, met, slipped) and per refused or failed measure, with ids and the value only.

## Consequences

- An outcome becomes something a kagelet can own: it knows whether it is winning without asking.
- A met objective costs nothing while it holds, because it reuses the tripwire probe.
- A bad measure makes a kagelet chase the wrong number. Kage shows the measure and its value in every report, so a person sees what is being chased.
- A measure is a command the hub runs, so it carries the probe's trust rules and approval card.

## How it is checked

To be written with the code: parsing the three lines (a target that does not parse is an error the file shows), the value taken from the output, the met and slipped transitions with `holdRuns`, the measure reused as a probe while met, and an event row for each step.
