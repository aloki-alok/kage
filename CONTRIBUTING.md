# Change the code

## Check a change

```sh
npm ci              # once
npm test            # every *.test.ts in core/, connectors/ and runtime/
npm run typecheck   # tsc --noEmit
```

There is no build. Node runs the TypeScript files as they are, so write only syntax it can strip (`erasableSyntaxOnly` in `tsconfig.json` enforces it). A running hub restarts into new code by itself once every session is quiet (`runtime/code-stamp.ts`).

Write logs to stderr only. In a tmux pane, stdout carries the channel protocol, so a stray `console.log` breaks it.

## Words

| Word | Means |
|---|---|
| conversation | Where a message lives: a Slack thread, an email thread, a WhatsApp chat, a voice call (`core/conversations.ts`). |
| session key | The stable id of a conversation's session, such as `C123:1730.55`, `dm`, `mail:<id>`, `voice:<id>`. Saved for good, so a thread always resumes its own Claude conversation. |
| session | One Claude Code conversation working on one session key. |
| runner | Where sessions run: an Agent SDK session inside the hub (default), or a tmux pane. |
| place | The label people read for a conversation, such as `#general` or `DM with Kage`. |
| lane | A second session on the same conversation (`@kage side: ...`). |
| hub | The long-running process (`router.ts`) that owns Slack, the dispatcher and the store. |

## Where things are

| Folder or file | Holds |
|---|---|
| `router.ts` | The hub, loaded by `hub.ts`: wires connectors, the dispatcher, the runner and the store. Its header names the few rules still in it. |
| `server.ts` | For tmux panes only: serves Kage's tools over MCP inside each pane and relays approvals. |
| `private-data-guard.ts` | The plugin hook (`hooks/hooks.json`) that runs the rules in `core/guards.ts` inside tmux panes. The SDK runner applies the same rules in process. |
| `config.ts` | Reads the env file and makes the Slack clients. |
| `core/` | Pure rules, each with a `*.test.ts` beside it. See the table below. |
| `connectors/` | Where Kage hears from. Each turns a message into a `Task` (`runtime/protocol.ts`). Who may drive Kage is decided in `core/gate.ts`, not here. |
| `runtime/` | Where sessions run, and the hub's state. See the table below. |
| `cli/` | The commands behind `kage <command>`. They run from source. |
| `setup.sh` | The `kage` command: setup steps, doctor, start, stop, logs. |
| `service.sh` | The LaunchAgent (macOS) or systemd user unit (Linux) that keeps the hub running. A non-zero exit restarts it, and exit 0 leaves it down. |
| `hub.ts` | The hub's entry, run by the service: the log file's size, the boot count and the crash-loop DM, then `router.ts`. Node modules only, so a bad pull is still caught. `start.sh` only forwards old login items to `kage start`. |
| `docs/settings.md` | Every setting in the env file. |
| `AGENTS.md` | Setup steps for a coding agent. `CLAUDE.md` loads it and this file. |
| `.claude-plugin/`, `.mcp.json`, `hooks/` | Used only when Kage is installed as a Claude Code plugin (tmux panes on the plugin route). |

### core/

| File | Rule |
|---|---|
| `gate.ts` | Who may start a task, the task line Claude reads, quoting the thread, teammates. |
| `agents.ts` | Talking to another agent: the tag on every part of a post, the "no reply needed" marker, and the loop guard. |
| `registry.ts` | Who is listed besides the owner: people, agents and each agent's owner, as two lines of the env file. |
| `slack-message.ts` | What a Slack message event is, whether a person typed it, and the `@kage` tag. |
| `conversations.ts` | A conversation and its session key, both ways. |
| `sessions.ts` | The dispatcher: one session per key, the slot limit, idle close, eviction, holds for `kage attach`. |
| `outbound.ts` | What may go out: no crowd pings, no secrets in a thread, Slack-sized parts, code blocks narrow enough for the thread panel. |
| `guards.ts` | Hook rules: private sources, voice calls, the owner's memory, Slack posts only through Kage's tools. |
| `ledgers.ts` | Reading the ledgers: questions waiting on the owner, what Kage posted, what turns cost, the daily note. |
| `events.ts` | The event log's row (what happened, never what was said), its 30 days, one day's events grouped by kagelet and chain for the dream job, and a chain read back as `a > b > c` and where it stopped. |
| `kagelets.ts` | A kagelet file (thread, schedule or `after:`, grant, job), the grant check, the chain check (no cycle, no missing kagelet, at most 5 deep), standing approvals per write tool and their revoke, the cost caps (off unless set) and the cost flags. |
| `kagelet-message.ts` | The message one kagelet sends another (an `after:` handoff or `message_kagelet`): its fields, named after A2A's Message, its delivery states, and the check where it enters the hub. |
| `kagelet-view.ts` | What a terminal shows of kagelets: the `kage top` panel, its keys, and `kage logs <kagelet>`. |
| `access.ts` | The access tiers: whether a kagelet's tool is read, write or act, from its name. |
| `db-read.ts` | The check a `db_read` query passes: one read statement, capped. |
| `cron.ts` | Cron expressions, which schedules are due, and reading Claude Code's own cron jobs. |
| `afk.ts` | AFK mode: which threads the stand-in watches, when it posts or phones the owner, and what it may say. |
| `blocks.ts` | When the safety check stops a turn: the line in the thread, the owner's DM, and whether the thread closes. |
| `commands.ts` | Local slash commands (`KAGE_COMMANDS`). |
| `auto-update.ts` | Whether the hub may move its own checkout to origin's `stable` tag, and the link to what changed. |
| `preview.ts` | How an approval shows the call it asks about. |
| `transcript.ts` | Turning a Claude Code transcript line into a line a person can follow. |
| `board.ts`, `loom.ts`, `hero.ts` | What `kage top` shows, its layout, and Kage's picture (generated by `cli/make-hero.ts`). |

### runtime/

| File | Holds |
|---|---|
| `sdk-sessions.ts` | The default runner: an Agent SDK session per key, inside the hub. `fake-sdk.ts` is the fake SDK its tests drive. |
| `tmux-panes.ts` | The other runner: a Claude Code pane per key. |
| `kage-tools.ts` | A session's tools (reply, edit, delete, send a file, message people, waiting, prod log, schedules, away and back), its instructions, and the approval card. |
| `session-link.ts` | The local socket that panes and the `kage` commands connect to. |
| `protocol.ts` | The messages on that socket. |
| `store.ts` | One SQLite file: conversations, their sessions, schedules, trust, the inbox of every message heard, and what connectors keep across a restart (AFK, GitHub and mail threads, each kagelet's `db_read` command and the standing approval of each write tool), and every kagelet message with its delivery state, stored before delivery so a restart replays it. The hub is the only writer of these tables. Old `.json` files move in once. |
| `ledger.ts` | The ledgers (waiting, posted, prod-actions, costs, runs, commands, reports, db-reads, grants) as rows in that file. The hub and every pane write them. Old `.tsv` files move in once. Also the event log (#94): one row per run start and end, kagelet tool call, report, grant (by card or standing approval), revoke, refusal, owner note, cost pause and cost flag, each on its run's trace. Rows older than 30 days fold into one summary row per day. |
| `scheduler.ts` | Runs due schedules as tasks in their thread. |
| `limit-pause.ts` | The usage-limit pause: a turn that ends on the limit keeps its inbox message, its thread gets one notice, and the message replays at the reset. A kagelet message is never held here: it waits in the store. |
| `closed-threads.ts` | A thread the safety check stopped: it starts on a new session, and a teammate's stays closed until the owner writes in it. |
| `hub-lock.ts` | One hub per machine: a listening socket the OS frees when the hub dies. |
| `hub-log.ts` | The hub log's rotation and the package check, shared by `hub.ts` and the hub. |
| `kagelets.ts` | The kagelets folder synced into schedules and grants (#57), the manager's tool, which grants by tier (read with no card, a write tool on the owner's first yes, which then stands for that tool, act never), and the cost-cap check on the job loop, and the one route a kagelet's output or message takes to another kagelet (#93), with the loop guard and the chain cap. |
| `code-stamp.ts` | When the code changed, so the hub knows to restart into it. |
| `auto-update.ts` | The version line, and the git calls that pull origin's `stable` tag (the decision is `core/auto-update.ts`). |

## Add a connector

A connector touches more places than it should today. Copy `connectors/email.ts`, then update:

1. `Conversation['connector']` and the key prefix in `core/conversations.ts`.
2. `senderOf` in `core/gate.ts`, if its sender is not plainly the owner or a teammate.
3. The reply type in `runtime/protocol.ts`, `routeReply` in `runtime/session-link.ts`, and the `reply` tool in `runtime/kage-tools.ts`.
4. `replies` and `failed` in `router.ts`.
5. The inbox (`Inbox` in `runtime/store.ts`): `take` each message with a unique source id before you acknowledge it, and `handled` after. If the source does not resend by itself, add a `replay` to `replayers` in `router.ts`.
