# 0025. A read route is safe because of its database login, and a teammate's yes covers it

Status: Accepted.

## Decision

The owner names read routes in `dbRead.routes`: a route name and a command. The hub runs the command, never the session, so the session sees names and rows and never the command, its host or its credentials (ADR 0004, ADR 0006). Every Slack session gets `db_read` when a route exists. A kagelet keeps its own `db_read` and its grant (ADR 0018).

A route is safe because its command connects as a read-only database role. Kage's check (one `SELECT` or `WITH ... SELECT`, capped rows, 30 s) is a second wall and does not read functions, so Kage keeps no list of dangerous ones. A route whose role can write is the owner's setting error, and the docs say so.

The gate uses the trust record (ADR 0024). The owner reads any route. A teammate reads a route only in `trust.mode` `on`, with a live `prod-read` line whose reach is the route name and whose who is the Slack id in the hub's task line. With no line the tool refuses and tells the session to post a typed ask, and the owner's plain yes saves the line. In `shadow` and `off` a teammate reads only in a turn the owner started, and shadow logs what `on` would have done. A meeting, an outsider, any listed agent, a text, a call, an email and the owner's DM job a meeting made read nothing (ADR 0004, ADR 0022). The SSM relay stays a never-learn kind: no line opens it.

Each read writes one `db-reads` row (who, route, a hash of the query, rows, time, outcome) and one counts-only event (ADR 0010, ADR 0019). Neither holds the query or the rows.

## How it is checked

`src/core/tests/db-read.test.ts` (the gate and who reads nothing), `src/runtime/tests/kage-tools.test.ts`, "named read routes" (a covered teammate reads, an uncovered route and a teammate with no line are refused, shadow, meetings, outsiders and bots, the command never reaches the session, the ledger row, the row cap, a never-learn line).
