# 0003. The hub is the only writer of the store

Status: Accepted

## Context

The store is one SQLite file that holds every conversation, the Claude session id for each, the inbox and connector state. Two writers would need locks and a merge story. Sessions and panes are separate processes that may crash.

## Decision

Only the hub process writes the store tables (`runtime/store.ts`). Sessions, panes and the CLI read, or ask the hub to write. One exception: tmux panes also write the `ledger` table in the same file (`runtime/ledger.ts`).

## Consequences

- Writes stay in one process, so there are no cross-process write races on conversations, sessions or the inbox.
- A new table that a pane must write needs its own ADR, not a quiet exception.
- Cost: a pane cannot save its own state directly. It must go through the hub.

## How it is checked

`runtime/tests/store.test.ts` covers the store. The single-writer rule is not yet enforced: review only.
