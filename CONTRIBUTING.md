# Change the code

## Check a change

```sh
npm ci              # once
npm test            # every *.test.ts under core/, connectors/, runtime/, cli/ and tests/
npm run typecheck   # tsc --noEmit
```

Tests live in a `tests/` folder inside the folder of the code they test: `core/gate.ts` is tested by `core/tests/gate.test.ts`.

`tests/structure.test.ts` checks the layout itself (ADR 0014): `core/` stays pure, nothing below the root imports a root file, no source file passes 300 lines, every `core/` and `runtime/` file is in the tables below, and no `core/` export goes unneeded. Each rule lists today's breaks as debt that may only shrink. The skill `.claude/skills/kage-change-code` has the rest of the clean-code rules.

The rules Kage follows, and why, are in [`docs/adr/`](docs/adr/). Read the ones that bind your change before you write code.

The Chrome extension (`extension/`) runs in a browser, so `npm test` cannot reach it. Its end-to-end check loads it into Chromium, pairs it the way `kage add browser` does, and attacks it with `extension/tests/e2e/page.html` (forged refs, overlays, mousemove traps, masked secrets). Run it after any change to `extension/`, `connectors/browser.ts` or `core/browser*.ts`:

```sh
uv run --with playwright python -m playwright install chromium        # once
uv run --with playwright python extension/tests/e2e/run.py               # 22 checks, exits 1 on a failure
```

One test calls a real model, so `npm test` skips it. It starts a real session with the sandbox and permission settings and checks that the token files, the settings and the hub code stay closed. Run it after any change to `protectConfig` in `core/guards.ts` or to the sandbox or permission settings of a session. It costs a few cents. It also runs one tmux pane (skipped without tmux) that unsets `KAGE_SESSION` and tries to write `config.json` and read `secrets.json`:

```sh
KAGE_LIVE_TESTS=1 node --test runtime/tests/sandbox.test.ts
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
| `config.ts` | Reads the settings files and makes the Slack clients. Only `router.ts`, `server.ts` and `cli/` import it; everything else logs through `runtime/log.ts`. |
| `core/` | Pure rules. See the table below. |
| `connectors/` | Where Kage hears from. Each turns a message into a `Task` (`core/task.ts`). Who may drive Kage is decided in `core/gate.ts`, not here. |
| `runtime/` | Where sessions run, and the hub's state. See the table below. |
| `cli/` | The commands behind `kage <command>`. They run from source. `cli/config.ts` reads and changes settings for the shell scripts and `kage set`. `cli/doctor/` is `kage doctor`: one file per check group, and `run.ts` prints their lines. |
| `setup.sh` | The `kage` command: setup steps, start, stop, logs. `doctor` calls `cli/doctor/run.ts`. |
| `service.sh` | The LaunchAgent (macOS) or systemd user unit (Linux) that keeps the hub running. A non-zero exit restarts it, and exit 0 leaves it down. |
| `hub.ts` | The hub's entry, run by the service: the log file's size, the boot count and the crash-loop DM, then `router.ts`. Node modules only, so a bad pull is still caught. `start.sh` only forwards old login items to `kage start`. |
| `docs/adr/` | One file per architecture decision: the rule, why, and how it is checked. |
| `tests/` | Tests of the repo as a whole: `structure.test.ts` (ADR 0014). |
| `docs/settings.md` | Every setting in the env file. |
| `AGENTS.md` | Setup steps for a coding agent. `CLAUDE.md` loads it and this file. |
| `extension/` | Kage's Chrome extension (#114): plain JS, no build. It polls the hub (`connectors/browser.ts`), reads tabs, and acts in them through Chrome's debugger, one action at a time; a major step waits for the owner's yes (core/browser-act.ts majorAct). |
| `meetbot/` | Kage's meeting bot (#63): its own package, run on any machine with a screen or Xvfb. It drives its own Chromium into a Google Meet and talks to the hub at the meeting webhook (`connectors/meeting.ts`). All of Meet's page knowledge is `meetbot/page.js`. |
| `skills/` | Skills every Kage session loads (the router passes the repo as a plugin, `router.ts`). Generic lessons only: no names, ids, customers, dates or quotes. |
| `.claude-plugin/`, `.mcp.json`, `hooks/` | Used only when Kage is installed as a Claude Code plugin (tmux panes on the plugin route). |

### core/

| File | Rule |
|---|---|
| `gate.ts` | Who may start a task, the task line Claude reads, quoting the thread, teammates. |
| `agents.ts` | Talking to another agent: the tag on every part of a post, the "no reply needed" marker, and the loop guard. |
| `doctor.ts` | What `kage doctor` decides from the facts `cli/doctor/` gathers: each ok, FAIL or note line, and the closing "All good" that the release soak gate reads. |
| `jev.ts` | Whether a listed agent's post needs a reply: the Jev settings, which agents it checks, the question, and how its score decides. The call is `connectors/jev.ts`, and `cli/jev-doctor.ts` is the doctor's line. |
| `config.ts` | The settings schema (one zod schema for config.json and secrets.json), the fixed table from old env names to its keys, the import and the flat env built back from it, and which changed keys apply live. |
| `registry.ts` | Who is listed besides the owner: people, agents and each agent's owner, as `people` in config.json. |
| `slack-message.ts` | What a Slack message event is, whether a person typed it, and the `@kage` tag. |
| `conversations.ts` | A conversation and its session key, both ways. |
| `sessions.ts` | The dispatcher: one session per key, the slot limit, idle close, eviction, holds for `kage attach`. |
| `outbound.ts` | What may go out: no crowd pings, no secrets in a thread, Slack-sized parts, code blocks narrow enough for the thread panel. |
| `guards.ts` | Hook rules: private sources, voice calls, the owner's memory, the config folder that holds the tokens (secrets.json and env files closed to every session, the owner's too; the rest owner-only, a thread's files folder excepted), Slack posts only through Kage's tools. |
| `ledgers.ts` | Reading the ledgers: questions waiting on the owner, what Kage posted, what turns cost, the daily note. |
| `events.ts` | The event log's row (what happened, never what was said), its 30 days, and a chain read back as `a > b > c` and where it stopped. |
| `kagelets.ts` | A kagelet file (thread, schedule or `after:`, grant, job), the grant check, the chain check (no cycle, no missing kagelet, at most 5 deep), standing approvals per write tool and their revoke, the cost caps (off unless set) and the cost flags. |
| `kagelet-message.ts` | The message one kagelet sends another (an `after:` handoff or `message_kagelet`): its fields, named after A2A's Message, its delivery states, and the check where it enters the hub. |
| `kagelet-view.ts` | What a terminal shows of kagelets: the `kage top` panel, its keys, and `kage logs <kagelet>`. |
| `access.ts` | The access tiers: whether a kagelet's tool is read, write or act, from its name. |
| `db-read.ts` | The check a `db_read` query passes: one read statement, capped. |
| `browser.ts` | What a session may see of the owner's Chrome (#114): the block list, tabs shown by id, and a page's text quoted as data. |
| `browser-act.ts` | Acting in the owner's Chrome: a page's controls as refs (labels quoted as data), which actions and keys are allowed, and the approval card's line, named from the page. |
| `meetbot.ts` | Kage's meeting bot (#63): which Meet links it may open, and the caption lines it posts, kept as data. |
| `browser-pair.ts` | Pairing the Chrome extension with no paste: its fixed id, the helper's folder in each Chromium browser, and Chrome's message framing. `cli/browser-pair.ts` is the helper Chrome starts. |
| `slack-scopes.ts` | The bot and user scopes the Slack app needs (the manifest writes them), which a granted list lacks, the doctor's lines, and whether the owner is told of a missing set. `runtime/slack-scopes.ts` asks Slack, and `cli/slack.ts` is `kage slack upgrade` (it names the scopes to add in the app's manifest page), and `cli/doctor/scopes.ts` is the doctor line. |
| `slack-files.ts` | Files attached to a Slack task: which the hub downloads (not canvases or quip docs, 25 MB each, 10 per task), the saved name, and the lines that list them in the task text. `runtime/slack-files.ts` downloads them with the user token into the thread's files folder. |
| `ssm.ts` | The relay's header line and its checks (instance id, port, region), and which session keys may hold a token. |
| `cron.ts` | Cron expressions, which schedules are due, and reading Claude Code's own cron jobs. |
| `email.ts` | Email as a way to tag Kage: who may (the provider's DKIM signature, not only DMARC), the ask in the new text, and the reply-all kept to the owner's domains. The SES, S3 and SQS calls are `connectors/email.ts`. |
| `whatsapp.ts` | The owner's WhatsApp: the owner's tag is the only way in, the armed-chat stand-in, and the guard that reads every message before it leaves as the owner. The WAHA webhook and calls are `connectors/whatsapp.ts`. |
| `afk.ts` | AFK mode: which threads the stand-in watches, when it posts or phones the owner, and what it may say. |
| `blocks.ts` | When the safety check stops a turn: the line in the thread, the owner's DM, and whether the thread closes. |
| `commands.ts` | Local slash commands (`connectors.commands`). |
| `auto-update.ts` | Whether the hub may move its own checkout to origin's `stable` tag, the link to what changed, and `soakGate`: whether a commit ran long enough on the owner's hub to be released. |
| `release.ts` | The next version and the release notes from merged PR titles. |
| `preview.ts` | How an approval shows the call it asks about. |
| `transcript.ts` | Turning a Claude Code transcript line into a line a person can follow. `runtime/transcript-tail.ts` reads the new lines from disk. |
| `task.ts` | `Task`: what a connector turns a message into, and what a runner takes (ADR 0002). |
| `text.ts` | Text helpers every rule shares: `oneLine`, and `quotedLine` for someone else's text (no `<channel>` tag survives). |
| `board.ts`, `loom.ts`, `hero.ts` | What `kage top` shows, its layout, and Kage's picture (generated by `cli/make-hero.ts`). |

### runtime/

| File | Holds |
|---|---|
| `sdk-sessions.ts` | The default runner: an Agent SDK session per key, inside the hub. `tests/fake-sdk.ts` is the fake SDK its tests drive. |
| `tmux-panes.ts` | The other runner: a Claude Code pane per key. |
| `kage-tools.ts` | A session's tools (reply, edit, delete, send a file, message people, post as Kage in another channel (owner only), waiting, prod log, schedules, away and back), its instructions, and the approval card. |
| `session-link.ts` | The local socket that panes and the `kage` commands connect to. |
| `protocol.ts` | The messages on that socket. |
| `transcript-tail.ts` | Reading the lines a session transcript gained since the last read (for `kage watch` and `kage top`). |
| `store.ts` | One SQLite file: conversations, their sessions, schedules, trust, the inbox of every message heard, and what connectors keep across a restart (AFK, GitHub and mail threads, each kagelet's `db_read` command and the standing approval of each write tool), and every kagelet message with its delivery state, stored before delivery so a restart replays it. The hub is the only writer of these tables. Old `.json` files move in once. |
| `ledger.ts` | The ledgers (waiting, posted, prod-actions, costs, runs, commands, reports, db-reads, grants) as rows in that file. The hub and every pane write them. Old `.tsv` files move in once. Also the event log (#94): one row per run start and end, kagelet tool call, report, grant (by card or standing approval), revoke, refusal, owner note, cost pause and cost flag, each on its run's trace. Rows older than 30 days fold into one summary row per day. |
| `ssm-relay.ts` | The SSM relay (#161): a unix socket where an owner thread's ssh asks the hub to run `aws ssm start-session`. `cli/ssm-proxy.ts` is the ssh ProxyCommand that connects to it. |
| `scheduler.ts` | Runs due schedules as tasks in their thread. |
| `limit-pause.ts` | The usage-limit pause: a turn that ends on the limit keeps its inbox message, its thread gets one notice, and the message replays at the reset. A kagelet message is never held here: it waits in the store. |
| `deferred-approvals.ts` | An approval card that waits outside its session (#177): the turn ends when the card posts, the store keeps the card across a restart, the first answer wins, and a yes is spent by one retry of the same call. |
| `closed-threads.ts` | A thread the safety check stopped: it starts on a new session, and a teammate's stays closed until the owner writes in it. |
| `hub-lock.ts` | One hub per machine: a listening socket the OS frees when the hub dies. |
| `hub-log.ts` | The hub log's rotation and the package check, shared by `hub.ts` and the hub. |
| `log.ts` | Kage's log line (stderr only) and the logger the Slack clients get. |
| `kagelets.ts` | The kagelets folder synced into schedules and grants (#57), the manager's tool, which grants by tier (read with no card, a write tool on the owner's first yes, which then stands for that tool, act never), and the cost-cap check on the job loop, and the one route a kagelet's output or message takes to another kagelet (#93), with the loop guard and the chain cap. |
| `config-files.ts` | config.json and secrets.json on disk (the schema and the env import table are `core/config.ts`): reading, changing, the first-start import of the old env file, and deleting that file after 7 days. |
| `code-stamp.ts` | When the code changed, so the hub knows to restart into it. |
| `auto-update.ts` | The version line, and the git calls that pull origin's `stable` tag (the decision is `core/auto-update.ts`). |
| `release.ts` | The git and gh calls of a release, and the owner hub's daily check (`kage release`, ADR 0013). |

## Add a connector

A connector touches more places than it should today. Copy `connectors/email.ts`, then update:

1. `Conversation['connector']` and the key prefix in `core/conversations.ts`.
2. `senderOf` in `core/gate.ts`, if its sender is not plainly the owner or a teammate.
3. The reply type in `runtime/protocol.ts`, `routeReply` in `runtime/session-link.ts`, and the `reply` tool in `runtime/kage-tools.ts`.
4. `replies` and `failed` in `router.ts`.
5. The inbox (`Inbox` in `runtime/store.ts`): `take` each message with a unique source id before you acknowledge it, and `handled` after. If the source does not resend by itself, add a `replay` to `replayers` in `router.ts`.
