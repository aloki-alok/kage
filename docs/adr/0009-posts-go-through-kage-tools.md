# 0009. Every post goes through Kage's tools and the outbound checks

Status: Accepted

## Context

A Slack server's own send tool posts as the owner with no sign of Kage. A model can be tricked into posting a secret, a crowd ping or a message in the wrong place.

## Decision

A session posts only through Kage's tools (`reply`, `message_people`). Any other Slack server's send, post, schedule or reply tool is refused (`slackSendRefusal`, `core/guards.ts`). Every post passes the outbound checks in `core/outbound.ts`: `secretRefusal`, `layoutRefusal` and `safeReply`, called from `runtime/kage-tools.ts`.

## Consequences

- Replies may go only where the task came from, or to the owner's DM with the bot.
- Mentions of a crowd are defused, and secret shapes are sent back to the model.
- Cost: a new channel type needs its own tool and checks first.

## How it is checked

`core/tests/guards.test.ts` (`slackSendRefusal`) and `core/tests/outbound.test.ts`. The tmux route runs the same rules in `plugin/private-data-guard.ts`.
