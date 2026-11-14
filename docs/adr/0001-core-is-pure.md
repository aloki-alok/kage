# 0001. `core/` holds pure rules

Status: Accepted, with known debt

## Context

Rules such as who may start a task, what may go out, and when a thread closes decide what a session can do. A rule that reads a file or calls a network is hard to test and easy to bend. Pure functions in one folder let a test drive each rule with plain inputs.

## Decision

Files in `core/` do no file, network or process I/O. They import nothing from `runtime/`, `connectors/` or `cli/`. Callers pass in what a rule needs, such as a path or a clock.

## Consequences

- A rule that needs data takes it as an argument, so its test needs no fixtures on disk.
- Code that must read a file goes in `runtime/` or `cli/`, even when it feels like a rule.
- Known debt: `core/guards.ts` imports `node:fs` (`realpathSync`, `readdirSync`) and reads `process.env.HOME`. `tests/structure.test.ts` lists it as `impureCore` debt.

## How it is checked

`tests/structure.test.ts` (ADR 0014) fails `npm test` when a `core/` file does I/O, reads `process.env`, sets a timer, or imports outside `core/`. The files that still do are its `impureCore` debt list.
