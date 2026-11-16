# 0010. The event log stores what happened, never what was said

Status: Accepted

## Decision

An event row names the kind, who, the trace and chain ids, and a short detail. It holds no message text, query rows or secrets. A run's text stays in its transcript, and the row keeps only the path (`core/events.ts`). Rows are kept for 30 days (`EVENT_DAYS`). A job that learns from content opens the transcript, under the transcript's own rules.

## How it is checked

`core/tests/events.test.ts` tests the row. The "no content" rule is review only.
