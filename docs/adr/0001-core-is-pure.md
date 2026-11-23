# 0001. `src/core/` holds pure rules

Status: Accepted, with known debt

## Decision

Files in `src/core/` do no file, network or process I/O. They import nothing from `src/runtime/`, `src/connectors/` or `src/cli/`. Callers pass in what a rule needs, such as a path or a clock.

- A rule that needs data takes it as an argument, so its test needs no fixtures on disk.
- Code that must read a file goes in `src/runtime/` or `src/cli/`, even when it feels like a rule.
- The path guards follow links on disk, so they live in `src/runtime/path-guards.ts`. `src/core/guards.ts` keeps the rules that read only the tool name and the sender.

## How it is checked

`tests/structure.test.ts` (ADR 0014) fails `npm test` when a `src/core/` file does I/O, reads `process.env`, sets a timer, or imports outside `src/core/`. The files that still do are its `impureCore` debt list.
