```mermaid
flowchart TD
  R0["0. Model poll: a full model run every tick"]:::cost
  R1["1. Tripwire: a fixed command runs with no model"]:::cheap
  R2["2. Event: a Slack post wakes the job, no polling"]:::cheap
  R3["3. Distilled rule (later)"]
  R4["4. Retro note (later)"]
  R0 -->|"shadow run proves it"| R1
  R1 -->|"shadow run proves it"| R2
  R2 -.-> R3
  R3 -.-> R4
  R1 -->|"output changed"| W["Job's own session wakes and posts"]
  R2 -->|"matching post"| W
```

# How Kage keeps monitors cheap

A monitor that asks a model what changed pays for a full run to learn that nothing did. Kage treats that model poll as the costly first draft of a monitor. It moves the job to a cheaper step only when the cheaper step has proven it sees the same things.

## The ladder

1. **Model poll.** The job wakes a model on every tick. This works for any job, and it is the fallback when a job has nothing cheaper.
2. **Tripwire.** The job has one fixed read command. The hub runs it with no model. The model wakes only when the output changes.
3. **Event.** A Slack channel the job watches wakes it on each matching post, bots included. Nothing polls.
4. **Distilled rule, later.** The model's past decisions would become a tested rule.
5. **Retro note, later.** A job that nobody reacts to would get one line in the weekly retro.

Only steps 1 to 3 exist today. Each wake runs in the job's own lane, so its session keeps only its own earlier wakes and not the whole thread.

## Each step is proven first

For a few days a job runs both ways: the old model poll and the new tripwire, side by side. Kage logs every case where they disagree. It drops the model poll only when the tripwire has caught everything the poll caught. A tripwire that misses a change never replaces the poll.

## A monitor is never stopped on its own

Kage never stops a job because it looks quiet. A quiet monitor may be working. If a probe command keeps failing, Kage sends one ping to the person who asked, with the error, and keeps trying. Stopping stays a human choice.

## Every number is a setting

The timeout, the output cap, the failure count before a ping, the shadow period and the model for job runs are all settings. The owner or Kage may change them while the hub runs. See the Tripwires section of [the settings reference](../settings.md).

## A probe runs only what you approved

A probe runs in the hub, outside any session's sandbox. So the rules are strict.

1. The probe command is fixed when the job is made. The approval shows it.
2. Each script the command calls is pinned by its content hash.
3. If a session edits a pinned script, the probe refuses to run. Kage asks again, and the changed script needs a new yes.

Editing a file can therefore never run new code in the hub. This is the same trust model as [Kagelets](kagelets.md) use for their database read, and it follows [Approvals](approvals.md).
