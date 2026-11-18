# 0022. A stand-in that speaks as the owner is read-only and fails closed

Status: Accepted.

## Decision

- The AFK stand-in and the WhatsApp stand-in run as a separate Claude with read-only memory and read-only GitHub, no MCP, settings or CLAUDE.md. (`core/afk.ts`, `core/whatsapp.ts`, `runtime/claude-once.ts`)
- Every stand-in post passes the secret check, then a guard model that must answer exactly `SEND`. (`core/afk.ts`, `core/whatsapp.ts`)
- The AFK stand-in never starts a session. Guests, Slack Connect people, bots and shared channels never get an answer, and an unknown lookup counts as outside. (`connectors/slack-afk.ts`, `core/afk.ts`)
- A Jev outage never loses a P0. If Jev fails, the Claude triage runs, and the P0 call still goes out. (`connectors/jev.ts`, `connectors/slack-afk.ts`)
- A failed status read leaves the owner's Slack status alone, because the owner may have set it since. (`connectors/slack-afk.ts`)
- WhatsApp: only the owner's own `@kage` tag reaches a session. A forward's tag never starts a task. (`hub/connectors.ts`, `core/whatsapp.ts`)
- WhatsApp stand-in replies are capped per armed chat, to stop a loop with another bot. A session sends only to its own chat. (`core/whatsapp.ts`, `connectors/whatsapp.ts`)
- Every WhatsApp message from the owner's number ends with a footer, and history strips it so a model never copies it. (`core/whatsapp.ts`)
- The Meta bot (ADR 0020) needs `ourAppId` for `team` and `live`, or it reads its own echoes as a person. A redelivered webhook never answers twice. (`metabot/config.ts`, `metabot/store.ts`)
- A held Meta reply sends the owner's fixed line under the same mode gate and cap. A reply link must be a pack link, and a price must match the pack. (`metabot/reply.ts`, `metabot/prompt.ts`)
- Telemetry sends nothing before the owner's one DM. Turning it off forgets the cursor, so turning it on sends only what comes after. (`hub/telemetry.ts`)

## How it is checked

`core/tests/afk.test.ts`, `core/tests/whatsapp.test.ts`, `connectors/tests/whatsapp.test.ts` and the `metabot/tests/` files check each guard: a stand-in post without an exact `SEND` is held, a forward's tag starts nothing, and `dry` or `team` never sends to a lead.
