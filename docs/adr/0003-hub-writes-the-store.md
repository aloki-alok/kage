# 0003. The hub is the only writer of the store

Status: Accepted

## Decision

Only the hub process writes the store tables (`runtime/store.ts`). Sessions, panes and the CLI read, or ask the hub to write. One exception: tmux panes also write the `ledger` table in the same file (`runtime/ledger.ts`). A new table that a pane must write needs its own ADR.

## How it is checked

`runtime/tests/store.test.ts` covers the store. The single-writer rule is review only.
