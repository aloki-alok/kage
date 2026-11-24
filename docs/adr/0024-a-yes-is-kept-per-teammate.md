# 0024. A yes from the owner is kept per teammate, kind and reach

Status: Accepted. Cards for a teammate's tool call and a kagelet's approvals are not on the record yet.

## Decision

The hub keeps one trust record: lines of `who` (the Slack id in the hub's task line, never the model's words), `kind`, `reach`, `yes` or `no`, `once`, a link to the answer and a time. Only a task the owner typed writes a line: the answer to an open typed ask in that thread. A scheduled run, a job, a teammate, an agent and a voice call never do. Only one open typed ask in a thread can be answered, and only by a short, explicit yes or no. The posted ask names the teammate, kind and reach a yes will save. The SSM relay and the key proxy stay behind `kage relay allow` (or an owner-only thread) whatever the mode.

`src/core/trust.ts` decides. A live yes for the same teammate, kind and reach covers an ask. A no always wins. A `once` yes covers nothing. The kinds money, delete, send-outside, prod-deploy, prod-write, prod-shell, secret, product and owner-shell always ask, and a kind the record does not know always asks. Revoking a line is the only way to take a yes back, and it is an owner write: it needs the owner key, and a session's shell is refused (ADR 0004).

`trust.mode` is `off`, `shadow` or `on`. In shadow the ask still posts and the record only keeps what it would have decided next to the owner's answer. Telemetry carries the mode and the decision word, never the teammate, kind or reach (ADR 0019).

## How it is checked

`src/core/tests/trust.test.ts` (the decision and the lines the owner's words make), `src/runtime/tests/kage-tools.test.ts` (a covered ask posts nothing, a teammate with no line asks, a never-learn kind asks, the same ask posts once), `src/hub/tests/trust.test.ts` (only the owner's typed words write a line), `src/runtime/tests/session-link-owner-key.test.ts` and `src/runtime/tests/path-guards.test.ts` (revoke needs the owner).
