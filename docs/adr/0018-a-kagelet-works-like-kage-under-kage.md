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
Built so far for a held step no rule or reviewer covers: the owner's card (`runtime/deferred-approvals.ts`), keyed on the command alone, and a yes spent by the kagelet's one retry of it. The owner's `always` also writes an exact `allow:` line for that command (`core/kagelets/kagelet.ts` addAllow), never for an owner-only kind.

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

## Grants and files

- A kagelet's grant is its approval and only shrinks. A tool outside it is denied, and no card goes to the owner. (`runtime/sdk-sessions.ts`, `core/kagelets/kagelet.ts`)
- A kagelet gets only Kage's thread tools and `message_kagelet`. The rest act as the owner or outlive the run. (`core/kagelets/kagelet.ts`)
- `tools: all` always runs in the OS sandbox and drops the owner's own settings, whose allow rules would widen it. (`core/kagelets/kagelet.ts`)
- A lane whose file is gone keeps no tools. It never falls back to approval cards. (`hub/router.ts`, `hub/kagelets.ts`)
- A kagelet name has no dots or slashes, so it never leaves the kagelets folder. A model name that is not an alias is held. (`core/kagelets/kagelet.ts`, `runtime/sdk-sessions.ts`)
- A kagelet's `people` and `owners` are one line each. A second line is refused, because the front matter keeps only the last. (`core/kagelets/people.ts`)
- Only the owner adds a person to a people line, because that person can steer every tool the kagelet holds. (`runtime/kagelets/manager.ts`)
- Every save by Kage's tool is checked as if approved first. A model steers every save, so no save widens a grant. (`runtime/kagelets/manager.ts`)
- The kagelet's memory folder must be a real directory at exactly `<kagelets>/<name>/memory`. No link or hard link may reach Kage's or the owner's memory. (`runtime/kagelets/memory.ts`)
- The dream only proposes. A proposal file under `.proposals/` is never read by a prompt. A note lands only through Kage's `decide`. (`runtime/kagelets/memory.ts`)
- A need reaches Kage as one task and goes to the owner's list only if Kage cannot finish it. A repeat folds before the cap. (`runtime/kagelets/needs.ts`)
- A kagelet message waits in the store until its target is idle. Only a normal turn end acknowledges it. Any other end queues it again. (`runtime/kagelets/routes.ts`)
- A held-step rule `*` never matches whitespace, quotes, shell syntax, a refspec colon or `..`. A rule starts with a literal command word. (`core/held-rules.ts`)
- The reviewer reads a whole plain command only. A chained, nested or widened step is never reviewed, and a process stop is never low-stakes. (`core/held-review.ts`)
- A yes is spent by the one retry of the same call, and an open card keeps the step the owner's. The reviewer slot is taken before the call. (`runtime/deferred-approvals.ts`, `runtime/sdk-sessions.ts`, `runtime/kagelets/review.ts`)
- A card for a lane is capped (`OPEN_PER_KEY`), so a looping kagelet cannot flood the owner's DM. (`runtime/deferred-approvals.ts`)
- A measure Kage wrote runs only after the owner's yes on that exact command. A changed script stops it. A new command starts a new trend. (`runtime/kagelets/measures.ts`)
- `db_read` passes the query as `$1`, never in the command line. Its statement check is the second wall, and fails closed on anything read two ways. (`runtime/tools/kagelet-tools.ts`, `core/db-read.ts`)
- A cost-capped kagelet stays paused past midnight. Only a person resumes it. (`runtime/kagelets/cost-cap.ts`)
