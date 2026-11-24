# 0010. The event log stores what happened, never what was said

Status: Accepted

## Decision

An event row names the kind, who, the trace and chain ids, and a short detail. It holds no message text, query rows or secrets. A run's text stays in its transcript, and the row keeps only the path (`src/core/events.ts`). Rows are kept for 30 days (`EVENT_DAYS`). A job that learns from content opens the transcript, under the transcript's own rules.

## How it is checked

`src/core/tests/events.test.ts` tests the row. The "no content" rule is review only.

## Other places that hold no content

- An error message never goes to the log or telemetry. It may quote what Kage read, so use a code or the class and first frame. (`src/core/telemetry.ts`, `src/core/ssm.ts`)
- Do not log `String(e)` of a failed command. It quotes the command line, which may hold a host or password. (`src/runtime/tools/kagelet-tools.ts`)
- The `db_read` ledger keeps who, line count, time and outcome, never the rows. The key proxy log keeps host, method and status, never the path. (`src/runtime/tools/db-read-tools.ts`, `src/runtime/key-proxy.ts`)
- The Jev log carries the score and reason, never the key or the post. (`src/connectors/jev.ts`)
- A config diff event names JSON paths, never values. An env import names unplaced keys, never values. (`src/core/config.ts`, `src/runtime/config-watch.ts`)
- A kagelet's measured value goes to the woken run only, never to the event log. A sandbox tool call logs name and refusal, never input. (`src/runtime/kagelets/measures.ts`, `src/runtime/sdk-sessions.ts`)
- A probe failure reason is a code (`exit-<n>`, `timeout`), never output. (`src/runtime/probes.ts`)
- A ledger write is a side record: a failed write is logged and never blocks a task or reply. (`src/runtime/ledger.ts`)
