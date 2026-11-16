# 0017. A twin swaps itself in when the hub proves it matches

Status: Accepted

## Context

ADR 0015 moves a monitor down its ladder by running a cheaper twin beside the old job until the twin matches it on real events. Until now the twin was a plain schedule whose prompt said "shadow job X", and a person read its DMs and removed the old job by hand. On the owner's hub that left proven twins waiting for days while the old job kept paying for a model turn on every tick.

A first design let the twin call a tool to report "I matched". A fresh review rejected it, and a real case on 2026-11-16 proved the review right. The twin's probe ran scripts with a broken PATH, failed with exit 0, saw no change, and never woke. The old job caught a rate drift that night. A twin that never wakes never calls a tool, so it could never have recorded that miss, and it would have swapped while blind.

## Decision

The hub grades the twin. The model only says what it would do.

1. **The link is data.** A twin's `job_state.shadow` holds `of` (the old job's id), `live` (the prompt it runs once it is live) and `since`. It is set with `schedule`'s `shadow_of` and `live_prompt`, by a person's task only: a job's own run may not make a twin.
2. **The old job's acts are recorded with its id.** When a job's run posts into its own thread, or logs a prod write, the ledger row carries the job id. A private DM to the owner is not an act.
3. **The twin states a verdict, never a match.** A twin's run calls `shadow_verdict(act, what)`. It posts the "SHADOW ... would ..." line to the owner and writes a `verdicts` ledger row. A twin that never wakes writes nothing, which counts as "would stay quiet".
4. **The hub pairs them, on its job clock, in `core/shadow.ts`.** Within `tripwires.shadowWindowMin` (default 30) of each other:
   - old job acted and the twin said act: a **match**.
   - old job acted and the twin said nothing, or said quiet: a **miss**. This is the 2026-11-16 case.
   - the twin said act and the old job did not act: a **miss** (false alarm).
   - both quiet: nothing. Quiet hours prove nothing about a monitor.
   An old job's run counts once, however many parts it posted.
5. **Any miss blocks the swap.** The hub DMs the owner once per miss with both sides' times, and leaves both jobs running. A person decides: fix the twin and re-make it (its count restarts), or drop it.
6. **`tripwires.swapAfter` matches (default 3) and no miss swap it, with no ask.** The order makes a crash safe:
   1. Save a copy of the old job in the store (`swapped-out`).
   2. Make the twin live: its prompt becomes `live`, and `shadow` goes.
   3. Remove the old job.
   4. Post one line in the thread: the twin is live, the old job is kept for `tripwires.swapUndoDays` (default 7), and "undo the swap" brings it back.
   A crash between steps leaves at most two live jobs for one tick, never none. A rerun finds the twin no longer shadowing and does nothing.
7. **Undo is the owner's.** `restore_job` is an owner-only tool (ADR 0004: only typed owner messages are the owner). It puts the saved job back and turns the twin back into a shadow. After `swapUndoDays` the saved copy is dropped.
8. **The hub records every step** (ADR 0010, ids and counts only): `shadow job=<twin> of=<old> result=match|miss kind=missed|false-alarm`, and `swap job=<twin> of=<old> matches=<n>`, `restore job=<old>`.

## Consequences

- Moving a monitor down the ladder needs no person when it works, and stops for a person the moment it does not.
- The twin can no longer grade itself, and a silent twin is caught by the old job's own acts.
- An old job that acts by some route other than a thread post or a prod log (a phone call alone) gives the hub nothing to pair. Such a job should post what it did, which the owner wants anyway.
- An old job that cries wolf blocks its own twin. The miss DM shows both sides, and the owner decides.
- A probe whose command fails with exit 0 is still silent on its own. The pairing catches it before a swap. Making such a probe loud is separate work.

## How it is checked

`core/tests/shadow.test.ts` (the pairing: match, both kinds of miss, quiet ignored, one count per run, window edges), and the swap's order and restore in `runtime/tests/shadow-swap.test.ts`.
