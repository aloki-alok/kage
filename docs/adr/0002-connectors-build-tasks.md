# 0002. Connectors build a `Task`. Core decides who may drive Kage

Status: Accepted

## Context

Kage hears from Slack, email, voice, WhatsApp, GitHub and meetings. If each connector held its own access rule, the rules would drift and one would be weaker than the rest.

## Decision

A connector turns a message into a `Task` (`core/task.ts`) and sets `fromOwner`. The rule that says who may drive Kage lives in `core/`: `core/gate.ts` for Slack, `core/email.ts` and `core/whatsapp.ts` for their channels. A connector never adds an access rule of its own.

## Consequences

- Changing who may drive Kage means editing one file in `core/` and its test.
- Connectors stay thin. Most set `fromOwner: false` (`connectors/github.ts:68`, `connectors/email.ts:45`, `connectors/meeting.ts:55`).
- Cost: a connector cannot special-case a sender, even for a good reason. It needs a core rule first.

## How it is checked

`core/tests/gate.test.ts` and `core/tests/email.test.ts` test the rules. Nothing stops a connector from adding a check: not yet enforced, review only.
