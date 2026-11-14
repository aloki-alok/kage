# 0005. One ceiling per kind of sender, enforced by the harness where it can

Status: Accepted (direction agreed in #105 and #116). Not yet built.

## Context

Kage sessions load the owner's Claude Code settings. An `allow` rule there is decided before Kage's `canUseTool` callback (`runtime/sdk-sessions.ts:67`). So Kage's callback cannot lower a voice caller below what the owner's settings allow.

## Decision

Kage decides a ceiling for each kind of sender: what an owner, a teammate, an agent and a voice caller may do. The harness enforces it where it can, by compiling the ceiling into `disallowedTools`. Kage's own hook is the fallback for what the harness cannot say, such as paths and the sender's identity.

## Consequences

- A harness rule can never lift a non-owner above their ceiling.
- Kage does not copy the owner's general tool rules. It owns only the per-sender ceiling.
- Today the ceiling is code in the hook: `runtime/sdk-sessions.ts:136` chains `privateToolRefusal`, `voiceToolRefusal`, `slackSendRefusal` and `configRefusal`. `disallowedTools` carries only the cron tools (`runtime/sdk-sessions.ts:116`).

## How it is checked

Not yet enforced: issue #105 (agent tasks read-only) and #116 (`senders` in `config.json`). The hook rules have tests in `core/tests/guards.test.ts`.
