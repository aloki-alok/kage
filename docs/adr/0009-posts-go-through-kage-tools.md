# 0009. Every post goes through Kage's tools and the outbound checks

Status: Accepted

## Decision

A session posts only through Kage's tools (`reply`, `message_people`). Any other Slack server's send, post, schedule or reply tool is refused (`slackSendRefusal`, `src/core/guards.ts`). Every post passes the outbound checks in `src/core/outbound.ts`: `secretRefusal`, `layoutRefusal` and `safeReply`, called from `src/runtime/kage-tools.ts`.

- A reply goes only where the task came from, or to the owner's DM with the bot.
- A crowd mention is defused, and a secret shape is sent back to the model.
- A new channel type gets its own tool and checks first.

## How it is checked

`src/core/tests/guards.test.ts` (`slackSendRefusal`) and `src/core/tests/outbound.test.ts`. The tmux route runs the same rules in `plugin/private-data-guard.ts`.

## Post rules

- Where the bot is not a member, Kage posts as the owner with Kage's footer. These posts carry no `client_msg_id`, so the gate never reads them as tasks. (`src/runtime/kage-tools.ts`)
- A footer marks an owner-account post. The gate reads the footer's block id to know it later. A reply copied back with its footer is stripped. (`src/core/outbound.ts`, `src/core/gate.ts`)
- A teammate's task never lets a secret into a thread. The owner may, by asking. A file with a secret is refused for everyone. (`src/core/outbound.ts`, `src/runtime/tools/slack-reply.ts`, `src/runtime/tools/slack-tools.ts`)
- A guard model fails closed. Only a first line of exactly `SEND` (or `RUN`) lets the action go. (`src/core/outbound.ts`, `src/core/held-review.ts`, `metabot/prompt.ts`)
- A reply goes only where a live task came from, or to the owner's DM. A voice reply is spoken and goes nowhere else. (`src/runtime/kage-tools.ts`, `src/runtime/tools/slack-reply.ts`, `src/runtime/session-link.ts`)
- A session edits or deletes only posts it made, tracked in the posted ledger. `message_people` posts carry a `people` row that other sessions never match. (`src/runtime/kage-tools.ts`)
- An ack line is never posted from the owner's account, because the pickup reaction already says it. (`src/runtime/kage-tools.ts`)
- The status line goes to the owner's DM only, because it names their other conversations. (`src/connectors/slack/connect.ts`)
- A split post tags the agent in every part, because an agent hears only posts that tag it. A tag in a code block is no mention. (`src/core/agents.ts`)
- Quoted text from others can never close the `<channel>` tag or start a task line. Quote with `quotedLine`. (`src/core/gate.ts`, `src/core/text.ts`, `src/core/meeting.ts`)
- Hidden characters (tag letters, zero-width, direction marks) are stripped before Claude reads text. (`src/core/gate.ts`)
- `send_file` sends only files written in the thread's own folder. A file from another thread's task never goes out. (`src/runtime/kage-tools.ts`)
- A post's Slack-only text (crowd pings, `<!channel>`, fake links) is defused. A person mention stays as `<@U>`. (`src/core/outbound.ts`)
