# 0018. A kagelet works like Kage, under Kage

Status: Proposed. Builds on 0015 and 0016. Changes 0004 and 0005 for kagelets only.

## Context

A kagelet today is a thin helper: one prompt paragraph, a tool list with no file, shell or agent tool, and memory that changes only at night. It can repeat a task. It cannot own a job in a domain, because it cannot do the work Kage does.

Every yes still goes to the owner. In one week of the owner's waiting ledger, about 60 open asks reached the owner. Sorted by hand, only about 17 were real calls (product calls and one-way doors). The rest were repeats of a pending question, "may I start?" on undoable work, "run this command", and work that belonged to a teammate. A team cannot use a kagelet the owner made if every question comes back to the owner.

## Decision

1. **One folder per kagelet.** `kagelets/<name>/job.md` holds the front matter (goal, number, manager, schedule, tools) and the job in plain words, including its rules as plain lines. `kagelets/<name>/memory/` holds what it learned. Its record (runs, cost, the number over time, held actions) is derived from the event log, not kept in the folder.
2. **One instruction text.** Kage and every kagelet read the same session instructions (`core/instructions.ts`), with the role named. The separate kagelet prompt is deleted. A kagelet follows the door rule like Kage: do and report what can be undone, hold a one-way door.
3. **`tools: all` gives a kagelet Kage's tools.** The hub then checks the action, not the tool name. An undoable action runs and is logged. A one-way door is held. The tokens file, Kage's code and the kagelet's own `job.md` stay closed by path for every kagelet. Without `tools: all`, a kagelet keeps its tool list, so cheap monitors stay cheap.
4. **The asker answers.** A held action goes to the person who asked for that run: in their thread, only they can answer. Inside the access the owner set for the kagelet, a teammate's yes counts for the teammate's own work. The owner's prod, money and access grants still need the owner. A scheduled run's asker is the kagelet's manager, which is Kage.
5. **Kage answers before the owner.** Kage answers a held action when a rule line in the kagelet's `job.md` covers it. Only Kage messages the owner. An answer can be "always allow", which adds one plain rule line to `job.md`, so the question does not come back.
6. **One open question per decision.** A new ask that repeats an open one is folded into it. An open ask from a scheduled run expires after `kagelets.askExpiryMinutes`.
7. **Memory is written during work.** A kagelet writes its memory folder freely while it works. The nightly dream prunes it. A line that would become a standing rule, or a change to `job.md`, still needs Kage's approval (the 0016 rule: a run never moves its own goal).
8. **Kage manages by the number.** Kage does not review every run. When a kagelet's number does not move for `kagelets.stallRuns` runs, Kage reviews it and decides: the kagelet knows too little (Kage fixes its memory or rules), or the goal is wrong (Kage brings the owner one question).

Every number is a setting with a default. Every held action, answer, expiry and review writes one event row with ids and the state only (ADR 0010).

## Consequences

- A kagelet can own a domain job, and Kage creates and runs it without the owner choosing each step.
- Most asks stop reaching the owner: repeats fold, undoable work proceeds, a teammate answers for their own work.
- The action check is the new risk. A shell command can be destructive in ways a tool name never shows. Slice 6 of the build does not ship until the stress tests below pass locally.
- A teammate's yes now counts for something. The owner's ceiling for each kagelet bounds it.

## How it is checked

Each slice ships with its tests, red first, and a local stress run before it reaches the live hub:

| Slice | Stress test before live |
|---|---|
| Repeats fold, scheduled asks expire | Replay last week's waiting ledger: count open asks before and after |
| "Always allow" adds a rule line | The same ask twice: the second is answered from the line, with no ask |
| One instruction text | Every existing kagelet runs one day on the new text with no new refusal or failed report |
| Folder per kagelet | Migrate a copy of the live kagelets folder: every kagelet parses, runs, and keeps its memory |
| Goal and number (0016) | A fake measure moves `working` to `met` to `working` with one wake each way |
| `tools: all` with the action check | A corpus of destructive and safe commands: every destructive one held, no safe one held |
| The asker answers | A teammate's thread: only the teammate's answer releases the action, the owner gets no message |
