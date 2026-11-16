# 0001. `core/` holds pure rules

Status: Accepted, with known debt

## Decision

Files in `core/` do no file, network or process I/O. They import nothing from `runtime/`, `connectors/` or `cli/`. Callers pass in what a rule needs, such as a path or a clock.

- A rule that needs data takes it as an argument, so its test needs no fixtures on disk.
- Code that must read a file goes in `runtime/` or `cli/`, even when it feels like a rule.
- The path guards follow links on disk, so they live in `runtime/path-guards.ts`. `core/guards.ts` keeps the rules that read only the tool name and the sender.

## How it is checked

`tests/structure.test.ts` (ADR 0014) fails `npm test` when a `core/` file does I/O, reads `process.env`, sets a timer, or imports outside `core/`. The files that still do are its `impureCore` debt list.
