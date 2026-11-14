# 0010. The event log stores what happened, never what was said

Status: Accepted (#94)

## Context

The dream and learning jobs read the event log to find patterns. A log that held message text, query rows or secrets would be a second copy of private data with weaker care.

## Decision

An event row names the kind, who, the trace and chain ids, and a short detail. It holds no message text, query rows or secrets. A run's text stays in its transcript, and the row keeps only the path (`core/events.ts:2`).

## Consequences

- Events are safe to group, show and keep for 30 days (`EVENT_DAYS`).
- To learn from content, a job must open the transcript, under the transcript's own rules.
- Cost: a row alone cannot explain what a session said.

## How it is checked

`core/tests/events.test.ts` tests the row. The "no content" rule is a header comment and review only.
