# 0005. One ceiling per kind of sender, enforced by the harness where it can

Status: Accepted, not yet built (#105, #116)

## Decision

Kage decides a ceiling for each kind of sender: what an owner, a teammate, an agent and a voice caller may do. The harness enforces it where it can, by compiling the ceiling into `disallowedTools`, because an `allow` rule in the owner's Claude Code settings is decided before Kage's `canUseTool`. Kage's own hook covers what the harness cannot say, such as paths and the sender's identity.

- A harness rule never lifts a non-owner above their ceiling.
- Kage owns only the per-sender ceiling. It does not copy the owner's general tool rules.

Today the ceiling is code in the hook: `runtime/sdk-sessions.ts` chains `privateToolRefusal`, `voiceToolRefusal`, `slackSendRefusal` and `configRefusal`. `disallowedTools` carries only the cron tools.

## How it is checked

The hook rules have tests in `core/tests/guards.test.ts`. The harness half is not built.
