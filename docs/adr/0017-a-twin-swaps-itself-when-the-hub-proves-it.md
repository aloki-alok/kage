# 0017. A twin swaps itself in when the hub proves it matches

Status: Accepted

## Decision

A cheaper twin runs beside a monitor (ADR 0015). The hub grades the twin. The model only says what it would do.

1. **The link is data.** A twin's `job_state.shadow` holds `of` (the old job's id), `live` (the prompt it runs once it is live) and `since`. It is set with `schedule`'s `shadow_of` and `live_prompt`, by a person's task only. A job's own run may not make a twin.
2. **The old job's acts carry its id.** When a job's run posts into its own thread, or logs a prod write, the ledger row carries the job id. A private DM to the owner is not an act. A job that acts some other way (a phone call alone) posts what it did, or the hub has nothing to pair.
3. **The twin states a verdict, never a match.** A twin's run calls `shadow_verdict(act, what)`. It posts the "SHADOW ... would ..." line to the owner and writes a `verdicts` ledger row. A twin that never wakes writes nothing, which counts as "would stay quiet".
4. **The hub pairs them on its job clock** (`core/shadow.ts`), within `tripwires.shadowWindowMin` of each other:
   - old job acted, twin said act: a **match**.
   - old job acted, twin said nothing or quiet: a **miss**.
   - twin said act, old job did not: a **miss** (false alarm).
   - both quiet: nothing.
   An old job's run counts once, however many parts it posted.
5. **Any miss blocks the swap.** The hub DMs the owner once per miss with both sides' times and leaves both jobs running. A person fixes and re-makes the twin (its count restarts), or drops it.
6. **`tripwires.swapAfter` matches and no miss swap it, with no ask,** in an order that is safe to crash:
   1. Save a copy of the old job in the store (`swapped-out`).
   2. Make the twin live: its prompt becomes `live`, and `shadow` goes.
   3. Remove the old job.
   4. Post one line in the thread: the twin is live, the old job is kept for `tripwires.swapUndoDays`, and "undo the swap" brings it back.
   A crash between steps leaves at most two live jobs for one tick, never none. A rerun finds the twin no longer shadowing and does nothing.
7. **Undo is the owner's.** `restore_job` is an owner-only tool (ADR 0004). It puts the saved job back and turns the twin back into a shadow. After `swapUndoDays` the saved copy is dropped.
8. **The hub records every step** (ADR 0010, ids and counts only): `shadow job=<twin> of=<old> result=match|miss kind=missed|false-alarm`, `swap job=<twin> of=<old> matches=<n>`, `restore job=<old>`.

## How it is checked

`core/tests/shadow.test.ts` (match, both kinds of miss, quiet ignored, one count per run, window edges) and `runtime/tests/shadow-swap.test.ts` (the swap's order and restore).
