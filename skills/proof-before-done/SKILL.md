---
name: proof-before-done
description: Use before you say a change is done, live, fixed, merged, scheduled, healthy, normal, unenforced or impossible, before you explain a cause or a risk, and before you ship a fix to a shared layer or a batch of items.
---

Every rule here exists because a claim made without a read cost a correction. Each rule has its why on the same line.

## Claims come from a read made after the action

1. After a write, read the thing you changed (the rule, the schedule, the PR, the row) and quote what it showed in one clause. A write call that ended with an error may still have run.
2. Create a promised follow-up first, then quote its id and next run. A promise with no schedule behind it is not a promise.
3. Before you say you cannot, check the capability in the code or the log. Capabilities change between sessions.
4. Retry a write only after a read shows it did not run. A retry on a write that ran does it twice.
5. A status can hide the outcome. A completed call may be a voicemail greeting, so read the first turn of the transcript before you say someone answered.
6. A risk found by searching code is a guess. Trace each path, check real data for real cases, then label each risk real, possible or not real.

## Causes and baselines

1. Name a cause only from evidence that fits it. Matching times alone is a coincidence until you read the code path.
2. A metric that matches recent days may still be unhealthy. After a few bad days the baseline is the bad state. Find the day the metric moved and report that onset as a finding.
3. Count over at least a full day before you say an alert clears or repeats daily. One hour of data hides the rest.
4. Before you call a limit unenforced, search where the field is read, not where it is defined.
5. Before you raise an alarm on a drop, count what is left to process. An empty queue looks like a fault.
6. Read the target repo's own rules before you propose a fix there. A fix that breaks a repo rule costs a correction.

## Changes that reach other people

1. A fix that changes a shared layer comes with its cost and a narrower option, as numbered choices with a recommendation. Put the cause and the known gaps in the PR body from the start.
2. A fix that drops, skips or deletes something gets each change walked through with its reason and what a user would lose. Wait for a read before you add more.
3. A migration that replaces an option must keep every existing record behaving the same. List each old value, what it maps to, and the row count per value.
4. A notice goes to the whole audience the ask names. A cut you invent shrinks the reach without anyone choosing it. Offer cuts as options with a count for each.
5. For a batch of similar items, make two or three that differ from each other and get feedback before you make the rest. Rewriting a whole batch costs the batch each time.

## Shell habits

1. A wait loop that searches for a process by its own command text matches its own shell. Use a bracket pattern, for example `grep -q [p]rocess-name`.
2. Stop your own background shells with the task stop tool, not by killing process ids.
