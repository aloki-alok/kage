# 0018. A kagelet works like Kage, under Kage

Status: Accepted. Builds on 0015 and 0016. Changes 0004 and 0005 for kagelets only.

## Decision

### A kagelet is a folder

```
kagelets/<name>/
  job.md     front matter (goal, number, manager, schedule, tools, people), then the job and its rules in plain words
  memory/    what it learned
```

Its record (runs, cost, the number over time, held actions) comes from the event log. Nothing else lives in the folder.

### Who does what

| Who | Does | Never |
|---|---|---|
| Kagelet | Works toward its number. Writes its memory as it works. Ends each run with the number and what it needs. | Messages the owner. Changes its own `job.md`. |
| Hub | Checks every action: an undoable one runs and is logged, a one-way door is held. Enforces the budget. Folds a repeated ask into the open one. Expires a scheduled run's ask after `kagelets.askExpiryMinutes`. | Judges the work. |
| Kage | Creates, changes and retires kagelets on its own. Answers a held action when a rule line in `job.md` covers it. Approves memory that becomes a rule. Reviews a kagelet when its number has not moved for `kagelets.stallRuns` runs. | Sets a goal without a person. |
| The person who asked | Answers the held actions of their own run. Their yes counts inside the access the owner set for that kagelet. | Answers for the owner's prod, money or access grants. |
| Owner | Sets goals and each kagelet's access. Answers the one-way doors Kage's rules do not cover. | Hears from any kagelet except through Kage. |

A scheduled run's asker is its manager, Kage.

### Rules

0. **Kage is for the owner and the teammates the owner added. Everyone else talks to kagelets.** Kage holds the owner's write access and prod data, so only the owner and the teammates added with `kage add` reach Kage. Kage opens a kagelet to more people by naming them in its `people:` line. A person named there talks to that kagelet only, inside that kagelet's access, and never reaches Kage through it.
1. **One instruction text.** Kage and every kagelet read `core/instructions.ts`, with the role named. There is no separate kagelet prompt.
2. **`tools: all`** gives a kagelet Kage's tools behind the hub's action check. Without it, a kagelet keeps its tool list. The tokens file, Kage's code and the kagelet's own `job.md` stay closed by path either way.
Built so far for a held step no rule or reviewer covers: the owner's card (`runtime/deferred-approvals.ts`), keyed on the command alone, and a yes spent by the kagelet's one retry of it.

3. **Always allow.** Any yes can be "always allow", which adds one plain rule line to `job.md`. Built so far: the owner's `allow:` lines, matched by code with no model (`core/held-rules.ts`). Kage's saves keep them and never write one, and a short list of kinds (root, disk erase, recursive permissions, cron, system folders, shutdown, a push to a protected branch) is never covered by a rule. At `kagelets.release` review, a cheap model may also let a low-stakes held kind run (`core/held-review.ts`); prod, customer, money and access kinds never reach it. Known gap, older than the reviewer: a kagelet can write a script, a git hook or a git config line that is not held, and a later reviewed step runs it inside the sandbox. The sandbox, not the hold, bounds that.
4. **A review names the failure.** When Kage reviews a stalled kagelet, it fixes the kagelet's memory or rules, or it brings the owner one question about the goal.

Every number is a setting with a default. Every held action, answer, expiry and review writes one event row with ids and the state only (ADR 0010).

## How it is checked

Each slice ships with its tests, red first, and a local stress run before it reaches a live hub:

| Slice | Stress test before live |
|---|---|
| Repeats fold, scheduled asks expire | Replay a week of the waiting ledger: count open asks before and after |
| Always allow | The same ask twice: the second is answered from the line, with no ask |
| One instruction text | Every existing kagelet runs one day on the new text with no new refusal or failed report |
| Folder per kagelet | Migrate a copy of a kagelets folder: every kagelet parses, runs, and keeps its memory |
| Goal and number (0016) | A fake measure moves `working` to `met` to `working` with one wake each way |
| `tools: all` with the action check | A corpus of destructive and safe commands: every destructive one held, no safe one held |
| The asker answers | A teammate's thread: only the teammate's answer releases the action, the owner gets no message |
