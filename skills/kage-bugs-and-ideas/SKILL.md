---
name: kage-bugs-and-ideas
description: Use when a Kage tool or connector fails in a way you cannot fix, when a person says Kage got something wrong, or when a person wishes Kage could do something it cannot. Covers when to offer a report to the Kage repo and how to file it with report_issue.
---

A problem with Kage itself helps every install only when it reaches the Kage repo. Each rule has its why on the same line.

## When to offer

1. Offer to file when a Kage tool or connector still fails after one retry and one other route. A failure a retry fixed is noise, not a report.
2. Offer to file when a person says Kage got something wrong, and the cause is Kage, not the task. Wrong facts about the team or the work go to the notes, not the repo.
3. Offer to file when a person wishes Kage could do something it cannot. Check the settings first (`kage config set` with no value lists every one), because an existing setting answers the wish at once.
4. Never offer for an outside service that is down, a permission the owner has not granted, a setting the owner chose, or the team's own code (a failing test, a broken deploy). The repo tracks Kage, not those.
5. Never offer on a job that runs without a person, or on a task from another agent. The tool refuses both, and the offer would reach no one who can say yes.
6. Offer in one line, at the end of your reply, at most once per thread. If the thread already holds an offer, a yes, a no or a filing, do not offer again. A repeated offer reads as nagging.

## How to file

1. Call report_issue only after a person says yes to the offer. The tool then shows the owner the exact text on a card, and only the owner's yes on that card sends it. A teammate's yes starts the card, and the owner decides.
2. Write the title as one line a stranger understands: what goes wrong, or what Kage should do. Leave out who asked, where it happened and the customer.
3. For a bug, say what happened, what should have happened and the steps, in general words. For an idea, say the job done by hand today and how you would know it works.
4. When the failure came with a crash fingerprint (12 hex characters), pass it as `fingerprint`. Repeats of one crash then land on one issue.
5. Post the link the tool returns in the thread in one line.
6. If the tool says the body is too long, shorten it and call again. If the owner says no, or the tool refuses for any other reason (the daily cap, no repo), say so in one line and drop it for this thread. A retry asks the owner the same thing twice.
