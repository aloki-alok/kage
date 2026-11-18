# 0005. One ceiling per kind of sender, enforced by the harness where it can

Status: Accepted, not yet built (#105, #116)

## Decision

Kage decides a ceiling for each kind of sender: what an owner, a teammate, an agent and a voice caller may do. The harness enforces it where it can, by compiling the ceiling into `disallowedTools`, because an `allow` rule in the owner's Claude Code settings is decided before Kage's `canUseTool`. Kage's own hook covers what the harness cannot say, such as paths and the sender's identity.

- A harness rule never lifts a non-owner above their ceiling.
- Kage owns only the per-sender ceiling. It does not copy the owner's general tool rules.

Today the ceiling is code in the hook: `runtime/sdk-sessions.ts` chains `privateToolRefusal`, `voiceToolRefusal`, `slackSendRefusal` and `configRefusal`. `disallowedTools` carries only the cron tools.

## How it is checked

The hook rules have tests in `core/tests/guards.test.ts`. The harness half is not built.

## Ceilings in code today

- A voice call gets the reply tool and nothing else: no shell, files, web, posting, schedules or other MCP tools. The session holds the owner's memory, and a URL can carry it out. (`core/guards.ts`)
- An agent's task may read and answer only. It gets no web, no other MCP tool, no subagent, no schedule, no posting as the owner, and no approval card. (`core/guards.ts`, `runtime/sdk-sessions.ts`)
- Any MCP server is the owner's unless listed in `sharedTools`, so a server added later stays closed. A claude.ai connector cannot be shared. (`core/guards.ts`)
- Private sources (mail, drive, calendar, meeting notes, browser) are read only by the owner's own task. No sender file reads as not the owner. (`core/guards.ts`, `plugin/private-data-guard.ts`)
- A failed hook check blocks the call. (`runtime/sdk-sessions.ts`)
- An MCP tool's name cannot prove it only reads, so only listed built-ins count as `read`. (`core/access.ts`)
- A kagelet's `act` tier is never granted. A `write` tool takes the owner's first yes, which stands for every kagelet. A shell is never a standing approval. (`core/access.ts`, `runtime/kagelet-manager.ts`)
- Only the owner's own Slack task may use the browser tools, the meeting bot, `set_setting`, the kagelet manager, AFK, and twin creation. (`runtime/tools/browser-tools.ts`, `runtime/tools/owner-tools.ts`, `runtime/tools/kagelet-tools.ts`, `runtime/tools/schedule-tools.ts`)
- `set_setting` treats an unlisted key as `power`, so a new key starts closed. A session may not loosen the Jev bar past 0.3. (`core/config.ts`, `runtime/tools/owner-tools.ts`)
- A voice call counts as the owner only after the one-time code, and an agent's post with the owner's token never counts. (`runtime/tools/slack-tools.ts`)
- A job reads its channel and identity from the hub's row, never from tool arguments the model writes. (`runtime/tools/schedule-tools.ts`)
- A run woken by a job may not change its own trigger at all. It reports the change instead. (`runtime/tools/schedule-tools.ts`)
- A browser step that spends, deletes, speaks as the owner, grants access or ships waits for a card. The hub decides this from the page, never from the model. (`core/browser-act.ts`)
- A browser card names the site first and the control as the page labels it. It strips links, fences and hidden characters. The action re-checks the same site and control. (`core/browser-act.ts`, `runtime/tools/browser-tools.ts`)
- A browser read checks the final address, so a redirect into a blocked host is refused. A block entry that matches no host is reported at start. (`core/browser.ts`)
- A kagelet message is untrusted input. It never reaches a kagelet that holds more tools than its sender. (`runtime/kagelet-routes.ts`, `core/kagelet-message.ts`)
- An approval card's text defuses `<url|text>` and is capped, so a model's link cannot rename what is approved. The card is asked last, after every refusal. (`runtime/kage-tools.ts`, `runtime/tools/slack-tools.ts`)
