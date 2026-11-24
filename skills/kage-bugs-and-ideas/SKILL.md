---
name: kage-bugs-and-ideas
description: Use when a Kage tool or connector fails in a way you cannot fix, when a person says Kage got something wrong, or when a person wishes Kage could do something it cannot. Covers when to offer a report to the Kage repo and how to file it with report_issue.
---

A problem with Kage itself helps every install only when it reaches the Kage repo. Each rule has its why on the same line.

## When to offer

1. Offer to file when a Kage tool or connector fails and a retry or a different route does not fix it. A failure you worked around still costs the next person the same time.
2. Offer to file when a person says Kage got something wrong, and the cause is Kage, not the task. Wrong facts about the team or the work go to the notes, not the repo.
3. Offer to file when a person wishes Kage could do something it cannot. Check the tools and settings first, because an existing setting answers the wish at once.
4. Offer in one line, at the end of your reply, at most once per thread. A repeated offer reads as nagging, and a person who wants it will say yes the first time.
5. Never offer on a job that runs without a person, and never for a failure in the work itself (a failing test, a broken deploy). The repo tracks Kage, not the team's code.

## How to file

1. File only after a person says yes to the offer. The owner still approves the exact text on a card, so a teammate's yes is a suggestion, not a filing.
2. Write the title as one line a stranger understands: what goes wrong, or what Kage should do. Leave out who asked, where it happened and the customer.
3. For a bug, say what happened, what should have happened and the steps, in general words. For an idea, say the job done by hand today and how you would know it works.
4. When `kage logs` shows a crash fingerprint for the failure, pass it as `fingerprint`. Repeats of one crash then land on one issue.
5. Post the link the tool returns in the thread in one line. If the owner said no, say nothing more about it.
