# 0002. Connectors build a `Task`. Core decides who may drive Kage

Status: Accepted. Known break: `connectors/voice.ts` decides the owner itself, from a one-time code (#105).

## Decision

A connector turns a message into a `Task` (`core/task.ts`) and sets `fromOwner`. The rule that says who may drive Kage lives in `core/`: `core/gate.ts` for Slack, `core/email.ts` and `core/whatsapp.ts` for their channels. A connector never adds an access rule of its own. A connector that needs a special case gets a core rule first.

## How it is checked

`core/tests/gate.test.ts` and `core/tests/email.test.ts` test the rules. Nothing stops a connector from adding a check: review only.
