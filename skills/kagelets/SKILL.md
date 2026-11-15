---
name: kagelets
description: Use on an owner's task that recurs (a watch, a monitor, a check every N hours, a schedule you already run), when the owner asks how your kagelets are doing, when a kagelet run needs something, or when the owner says to revoke a kagelet's tool.
---

A kagelet is a recurring job that runs on its own schedule in a thread and reports to you. You manage them with the kagelets and manage_kagelet tools, on the owner's tasks only. Each rule has its why on the same line.

## When to make one

1. Make a kagelet when an owner job recurs and needs only web search and fetch. It runs without holding this session open.
2. Keep a job that needs files or shell on the schedule tool. A kagelet has no shell or file tools.
3. Keep a one-off task in this session. A kagelet only pays off on a repeat.
4. Save it with manage_kagelet save and a one-line why, then unschedule the old schedule if there was one. Two jobs doing the same check report twice.
5. Tell the owner in one line, in the thread where it was decided: the kagelet name, its job, when it runs, and that saying remove with its name stops it. The owner learns it exists and how to stop it in one place.

## What a kagelet may use

The code decides each tool's tier, so the model cannot raise one.

1. Grant read tools (WebSearch, WebFetch, db_read) at save, with no card. They change nothing.
2. db_read runs only the install's own read command (kagelets.dbRead.command, or one the owner approved before, named in read_command). A kagelet never brings a new command, because a command is code the owner did not review.
3. Every MCP tool that is not act counts as a write tool, a reading one too. The owner approves it on a card the first time, and that yes stands for every later kagelet that asks for the same tool. The owner sees the no-card grants in their daily note.
4. Never give a kagelet an act tool (prod, money, customers, access, deletes). The kagelet reports what it needs, and you ask the owner each time, because an act needs a person's yes per use.
5. When the owner says to revoke a tool, call manage_kagelet revoke with name set to that tool. Revoking by tool takes it from every kagelet at once.

## Looking after them

1. When the owner asks how your kagelets are doing, or a run needs something, read kagelets and act on what they need. A kagelet cannot ask the owner by itself.
