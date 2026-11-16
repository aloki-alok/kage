# 0009. Every post goes through Kage's tools and the outbound checks

Status: Accepted

## Decision

A session posts only through Kage's tools (`reply`, `message_people`). Any other Slack server's send, post, schedule or reply tool is refused (`slackSendRefusal`, `core/guards.ts`). Every post passes the outbound checks in `core/outbound.ts`: `secretRefusal`, `layoutRefusal` and `safeReply`, called from `runtime/kage-tools.ts`.

- A reply goes only where the task came from, or to the owner's DM with the bot.
- A crowd mention is defused, and a secret shape is sent back to the model.
- A new channel type gets its own tool and checks first.

## How it is checked

`core/tests/guards.test.ts` (`slackSendRefusal`) and `core/tests/outbound.test.ts`. The tmux route runs the same rules in `plugin/private-data-guard.ts`.
