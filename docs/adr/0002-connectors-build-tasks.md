# 0002. Connectors build a `Task`. Core decides who may drive Kage

Status: Accepted. Known break: `src/connectors/voice.ts` decides the owner itself, from a one-time code (#105).

## Decision

A connector turns a message into a `Task` (`src/core/task.ts`) with `taskAsOwner`, `taskAsOther` or `taskFrom` from `src/core/gate.ts`, the only code that builds one (#273). Each `taskAsOwner` call is a claim a reviewer can find with one search. The rule that says who may drive Kage lives in `src/core/`: `src/core/gate.ts` for Slack, `src/core/email.ts` and `src/core/whatsapp.ts` for their channels. A connector never adds an access rule of its own. A connector that needs a special case gets a core rule first.

## How it is checked

`src/core/tests/gate.test.ts` and `src/core/tests/email.test.ts` test the rules. `tests/structure.test.ts` fails on a `Task` built outside `src/core/`. Nothing stops a connector from adding an access check of its own: review only.

## Connector rules

- A connector writes each message to the inbox before it acks. A failed write throws before the ack, so the sender resends. (`src/connectors/slack/connect.ts`, `src/connectors/github.ts`, `src/connectors/whatsapp.ts`, `src/connectors/job-hooks.ts`, `src/connectors/meeting.ts`)
- A source that resends by itself until handled (SQS mail) records its id only after handling, so a crash replays it. (`src/runtime/store.ts`, `src/connectors/email.ts`)
- A failed event stays unhandled, so the next start retries it. A mail that fails to process is logged and dropped. (`src/connectors/github.ts`, `src/connectors/whatsapp.ts`, `src/connectors/email.ts`)
- A replay after a restart or a usage-limit pause runs the task but never arms the WhatsApp stand-in. (`src/connectors/whatsapp.ts`)
- A webhook handler checks method, path and signature before it reads one byte of body. The HMAC is the only gate when the port faces a container. (`src/connectors/whatsapp.ts`)
- A connector reads the body as bytes and decodes once, so a split character cannot break a signature. (`src/connectors/webhook.ts`)
- Slack reaches the connector by Socket Mode or by HTTP, and both feed the same intake: ADR 0023.
- The hub allows one process per machine. The lock is a listening socket, because binding is atomic. (`src/hub/router.ts`, `src/runtime/hub-lock.ts`)
- The GitHub and meeting connectors run their tasks at teammate trust, because the event text comes from other people. (`src/connectors/github.ts`, `src/connectors/meeting.ts`)
- A Meet has no owner code. Everyone in the room hears the answers, so a meeting task is never the owner's. (`src/connectors/meeting.ts`)
- A Slack slash command checks the user type as well as the team id, because guests share the workspace id. (`src/connectors/slack/commands.ts`)
- The browser endpoints need a bearer token, so no web page the owner visits can drive them across origins. (`src/connectors/browser.ts`)
- Text from other people (GitHub titles, logins, channel posts) is escaped or quoted before it reaches Slack or a job. (`src/connectors/github.ts`, `src/connectors/slack/connect.ts`, `src/runtime/channel-watch.ts`)
- The voice slot check runs before a call starts, so a call never evicts or queues ahead of the owner's threads. (`src/connectors/voice.ts`, `src/hub/connectors.ts`, `src/core/sessions.ts`)
