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

One test calls a real model, so `npm test` skips it. It starts a real session with the sandbox and permission settings and checks that the token files, the settings and the hub code stay closed. Run it after any change to `protectConfig` in `runtime/path-guards.ts` or to the sandbox or permission settings of a session. It costs a few cents. It also runs one tmux pane (skipped without tmux) that unsets `KAGE_SESSION` and tries to write `config.json` and read `secrets.json`:

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
| hub | The long-running process (`hub/router.ts`) that owns Slack, the dispatcher and the store. |

## Where things are

| Folder or file | Holds |
|---|---|
| `hub.ts` | The hub's entry, run by the service: the log file's size, the boot count and the crash-loop DM, then `hub/router.ts`. Node modules only, so a bad pull is still caught. It stays at the root because every install's service runs this path. `start.sh` only forwards old login items to `kage start`, until 2026-12-15. |
| `hub/router.ts` | The hub, loaded by `hub.ts`: wires connectors, the dispatcher, the runner and the store. Its header names the few rules still in it. |
| `hub/config.ts` | Reads the settings files and makes the Slack clients. Only `hub/router.ts`, `plugin/server.ts` and `cli/` import it; everything else logs through `runtime/log.ts`. |
| `hub/updates.ts` | The hub's own code: the version it runs, the restart into newer code or changed settings, the auto-update to origin's stable tag, and the release the owner's hub makes. |
| `hub/owner-digests.ts` | What the owner gets on a clock: the daily note (questions waiting a day, grants with no card) and the Monday retro. |
| `hub/dreams.ts` | The nightly dreams: Kage's own over the day's threads, and each kagelet's over its runs. |
| `hub/connectors.ts` | The connectors the hub starts beside Slack (GitHub, meetings and the meeting bot, email, voice, WhatsApp), how a reply reaches each, and how a stored message replays through its own connector. |
| `hub/job-events.ts` | Jobs that an event wakes: it builds the channel watches and the job webhook server (`connectors/job-hooks.ts`) from the `tripwires.*` settings, rebuilds every watch from the stored triggers at start, and gives the router one place for `schedule`, `unschedule`, the Slack hooks and the webhook replay. |
| `hub/kagelets.ts` | Kagelets in the hub: the minute sync of their files into schedules and grants, the cost flags and caps, their memory, the manager's side, the owner's notes to one, and the chains between them. |
| `hub/owner-commands.ts` | What the owner asks from their terminal or DM: the status line, `kage tell` and `kage relay`. |
| `plugin/server.ts` | For tmux panes only: serves Kage's tools over MCP inside each pane and relays approvals. |
| `plugin/private-data-guard.ts` | The plugin hook (`hooks/hooks.json`) that runs the rules in `core/guards.ts` and `runtime/path-guards.ts` inside tmux panes. The SDK runner applies the same rules in process. |
| `core/` | Pure rules. See the table below. |
| `connectors/` | Where Kage hears from. Each turns a message into a `Task` (`core/task.ts`). Who may drive Kage is decided in `core/gate.ts`, not here. |
| `runtime/` | Where sessions run, and the hub's state. See the table below. |
| `cli/` | The commands behind `kage <command>`. They run from source. `cli/config.ts` reads and changes settings for the shell scripts and `kage set`. `cli/doctor/` is `kage doctor`: one file per check group, and `run.ts` prints their lines. |
| `setup.sh` | The `kage` command: setup steps, start, stop, logs. `doctor` calls `cli/doctor/run.ts`. |
| `service.sh` | The LaunchAgent (macOS) or systemd user unit (Linux) that keeps the hub running. A non-zero exit restarts it, and exit 0 leaves it down. |
| `docs/adr/` | One file per architecture decision: the rule, why, and how it is checked. |
| `tests/` | Tests of the repo as a whole: `structure.test.ts` (ADR 0014). |
| `docs/settings.md` | Every setting in config.json and secrets.json, with its default. |
| `CLAUDE.md` | The one file coding agents read first: setup steps, the commands that run Kage, and this file (loaded with `@CONTRIBUTING.md`). |
| `extension/` | Kage's Chrome extension (#114): plain JS, no build. It polls the hub (`connectors/browser.ts`), reads tabs, and acts in them through Chrome's debugger, one action at a time; a major step waits for the owner's yes (core/browser-act.ts majorAct). |
| `meetbot/` | Kage's meeting bot (#63): its own package, run on any machine with a screen or Xvfb. It drives its own Chromium into a Google Meet and talks to the hub at the meeting webhook (`connectors/meeting.ts`). All of Meet's page knowledge is `meetbot/page.js`. |
| `skills/` | Skills every Kage session loads (the router passes the repo as a plugin, `hub/router.ts`). Generic lessons only: no names, ids, customers, dates or quotes. |
| `.claude-plugin/`, `.mcp.json`, `hooks/` | Used only when Kage is installed as a Claude Code plugin (tmux panes on the plugin route). |

### core/

| File | Rule |
|---|---|
| `gate.ts` | Who may start a task, the task line Claude reads, quoting the thread, teammates. |
| `agents.ts` | Talking to another agent: the tag on every part of a post that must reach it (only with `tag_agent`), the "no reply needed" marker, and the loop guard. |
| `doctor.ts` | What `kage doctor` decides from the facts `cli/doctor/` gathers: each ok, FAIL or note line, and the closing "All good" that the release soak gate reads. |
| `jev.ts` | Whether a listed agent's post needs a reply: the Jev settings, which agents it checks, the question, and how its score decides. The call is `connectors/jev.ts`, and `cli/jev-doctor.ts` is the doctor's line. |
| `config.ts` | The settings schema (one zod schema for config.json and secrets.json), the fixed table from old env names to its keys, the import and the flat env built back from it, and which changed keys apply live. |
| `registry.ts` | Who is listed besides the owner: people, agents and each agent's owner, as `people` in config.json. |
| `slack-message.ts` | What a Slack message event is, whether a person typed it, and the `@kage` tag. |
| `conversations.ts` | A conversation and its session key, both ways. |
| `sessions.ts` | The dispatcher: one session per key, the slot limit, idle close, eviction, holds for `kage attach`. |
| `outbound.ts` | What may go out: no crowd pings, no secrets in a thread, Slack-sized parts, code blocks narrow enough for the thread panel, and a guard's SEND or HOLD on a message leaving as the owner. |
| `guards.ts` | Hook rules that need only the tool name and the sender: private sources, voice calls, Slack posts only through Kage's tools. Where the two memory folders are. |
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
| `ssm.ts` | The one call the SSM relay runs for a session (the arguments aws gives `session-manager-plugin`: operation, region, stream and endpoint hosts), and which session keys may hold a token. |
| `cron.ts` | Cron expressions, which schedules are due (an `@event` job never is), and reading Claude Code's own cron jobs. |
| `email.ts` | Email as a way to tag Kage: who may (the provider's DKIM signature, not only DMARC), the ask in the new text, the reply-all, and the guard on a reply that leaves the owner's domains. The SES, S3 and SQS calls are `connectors/email.ts`. |
| `whatsapp.ts` | The owner's WhatsApp: the owner's tag is the only way in, the armed-chat stand-in, and the guard that reads every message before it leaves as the owner. The WAHA webhook and calls are `connectors/whatsapp.ts`. |
| `tripwire.ts` | Tripwires: the pure rules of a probe that wakes a session only when its output changes. How output is normalized and fingerprinted, the words of a command, which ignore patterns are safe, whether a pin changed, what one run does to a job's state (a wake, a failure ping), the hash kept of a job webhook's token, and when a hook needs the owner's card. |
| `shadow.ts` | Self-swap (ADR 0017): a twin's link to the job it shadows, and the pairing of that job's acts (own-thread posts and prod writes) with the twin's verdicts into matches and misses, and when a swap is due. |
| `afk.ts` | AFK mode: which threads the stand-in watches, when it posts or phones the owner, and what it may say. |
| `blocks.ts` | When the safety check stops a turn: the line in the thread, the owner's DM, and whether the thread closes. |
| `commands.ts` | Local slash commands (`connectors.commands`). |
| `auto-update.ts` | Whether the hub may move its own checkout to origin's `stable` tag, the link to what changed, and `soakGate`: whether a commit ran long enough on the owner's hub to be released. |
| `release.ts` | The next version and the release notes from merged PR titles. |
| `preview.ts` | How an approval shows the call it asks about. |
| `transcript.ts` | Turning a Claude Code transcript line into a line a person can follow. `runtime/transcript-tail.ts` reads the new lines from disk. |
| `stats.ts` | What `kage stats` shows: spend per day and per connector, runs, refusals, turn time and hub starts, from rows Kage already keeps (no content). `cli/stats.ts` reads them. |
| `task.ts` | `Task`: what a connector turns a message into, and what a runner takes (ADR 0002). |
| `instructions.ts` | What every Kage session reads first: who it is, whom it serves, how it answers, and each kind of task's limits. |
| `text.ts` | Text helpers every rule shares: `oneLine`, and `quotedLine` for someone else's text (no `<channel>` tag survives). |
| `cli-help.ts` | The closest real `kage` command to a mistyped one. |
| `dream.ts` | The nightly dream job: what it reads for lessons, how it tidies Kage's memory, and which lessons may leave this machine. |
| `github.ts` | Which GitHub events are the owner's business (a review or failed checks on their PR, an issue or review request given to them, a mention). |
| `kagelet-memory.ts` | A kagelet's own memory folder (#98): what its prompt reads, and the one path into the folder. |
| `log-repeats.ts` | One log line for a burst of the same line, with its count. |
| `meeting.ts` | A finished meeting's transcript as one task: notes, decisions, owners, open questions, and proposed actions that wait for the owner's yes. |
| `quiet.ts` | `kage stop` and `kage restart`: drain the hub, then wait for every thread to end its turn, naming each one. |
| `retro.ts` | The weekly retro: what Kage's own ledgers say to change. It proposes; the owner decides. |
| `settings.ts` | The old env file read once for import, the answer `kage reload` gives, and which settings apply without a restart. |
| `skill-lessons.ts` | The check a lesson passes before the dream shares it with every install: nothing that tells whose Kage learned it. |
| `socket-watch.ts` | When to restart the Slack socket by hand, because its own reconnect can stay down. |
| `board.ts`, `loom.ts`, `hero.ts` | What `kage top` shows, its layout, and Kage's picture (generated by `cli/make-hero.ts`). `cli/top.ts` runs it, `cli/top-screen.ts` is its grid of cells, and `cli/top-art.ts` draws Kage and the strings. |

### runtime/

| File | Holds |
|---|---|
| `sdk-sessions.ts` | The default runner: an Agent SDK session per key, inside the hub. `runtime/tests/fake-sdk.ts` is the fake SDK its tests drive. |
| `tmux-panes.ts` | The other runner: a Claude Code pane per key. |
| `kage-tools.ts` | A session's tools (about 28): the state they share about its tasks (where each came from, who sent it, what Kage posted), and the approval card. The instructions every session reads are `core/instructions.ts`. |
| `runtime/tools/slack-tools.ts` | Replies, edits and deletes of Kage's own posts, telling people, attaching a file, the waiting list, the prod log, and a post as Kage where no task came from. |
| `runtime/tools/schedule-tools.ts` | A thread's schedules in the hub, and AFK mode on and off. |
| `runtime/tools/kagelet-tools.ts` | A kagelet's tools (report, message another, db_read), its dream's (propose_memory), and the manager's. |
| `runtime/tools/browser-tools.ts` | The owner's Chrome: list, read, capture, snapshot and act, a major step on the owner's yes. |
| `runtime/tools/owner-tools.ts` | Only the owner's own Slack task: the meeting bot and changing a setting. |
| `session-link.ts` | The local socket that panes and the `kage` commands connect to. |
| `hub-client.ts` | The client end of that socket: one question to the running hub, one answer. Node modules only, because the shell scripts read settings through `cli/home.ts`, which imports it. |
| `protocol.ts` | The messages on that socket. |
| `voice-slack-tools.ts` | The two Slack read tools only an owner-verified voice call gets (`slack_search`, `slack_read`), loaded up front so a live call skips tool discovery. |
| `claude-once.ts` | One isolated `claude -p` answer for the guards and stand-ins (WhatsApp, Slack AFK): no MCP, no settings, nothing saved, run in an empty folder. |
| `transcript-tail.ts` | Reading the lines a session transcript gained since the last read (for `kage watch` and `kage top`). |
| `store.ts` | One SQLite file: conversations, their sessions, schedules, trust, the inbox of every message heard, and what connectors keep across a restart (AFK, GitHub and mail threads, each kagelet's `db_read` command and the standing approval of each write tool), and every kagelet message with its delivery state, stored before delivery so a restart replays it. The hub is the only writer of these tables. Old `.json` files move in once. |
| `ledger.ts` | The ledgers (waiting, posted, prod-actions, costs, runs, commands, reports, db-reads, grants) as rows in that file. The hub and every pane write them. Old `.tsv` files move in once. Also the event log (#94): one row per run start and end, kagelet tool call, report, grant (by card or standing approval), revoke, refusal, owner note, cost pause and cost flag, each on its run's trace. Rows older than 30 days fold into one summary row per day. |
| `ssm-relay.ts` | The SSM relay (#161): a unix socket where an owner thread's stand-in `session-manager-plugin` (`cli/ssm-plugin-shim/`, first on that session's PATH) asks the hub to run the real plugin. |
| `scheduler.ts` | Runs due schedules as tasks in their thread. |
| `limit-pause.ts` | The usage-limit pause: a turn that ends on the limit keeps its inbox message, its thread gets one notice, and the message replays at the reset. A kagelet message is never held here: it waits in the store. |
| `deferred-approvals.ts` | An approval card that waits outside its session (#177): the turn ends when the card posts, the store keeps the card across a restart, the first answer wins, and a yes is spent by one retry of the same call. |
| `closed-threads.ts` | A thread the safety check stopped: it starts on a new session, and a teammate's stays closed until the owner writes in it. |
| `hub-lock.ts` | One hub per machine: a listening socket the OS frees when the hub dies. |
| `hub-log.ts` | The hub log's rotation and the package check, shared by `hub.ts` and the hub. |
| `path-guards.ts` | Hook rules that follow real paths on disk: the config folder that holds the tokens (secrets.json and env files closed to every session, the owner's too; the rest owner-only, a thread's files folder excepted), the sandbox and file rules each session starts with, and the owner's memory taking only people notes. |
| `log.ts` | Kage's log line (stderr only) and the logger the Slack clients get. |
| `kagelet-files.ts` | The kagelets folder on disk: where it is, its `.md` files, and the paused line. |
| `kagelet-sync.ts` | The folder synced into schedules and grants each minute (#57), and the prompt each run reads first. |
| `kagelet-manager.ts` | The manager's tool (save, pause, resume, run, remove, revoke) and which tools each kagelet is granted: read with no card, a write tool on the owner's first yes, which then stands for that tool, act never. |
| `kagelet-cost-cap.ts` | The cost caps on the hub's job loop: a kagelet over a cap is paused and flagged, and the owner is told once a day. |
| `kagelet-notes.ts` | The owner's words typed in a kagelet's thread, carried to its next run. |
| `kagelet-routes.ts` | The one route a kagelet's output or message takes to another kagelet (#93), with the loop guard and the chain cap. |
| `config-files.ts` | config.json and secrets.json on disk (the schema and the env import table are `core/config.ts`): reading, changing, the first-start import of the old env file, and deleting that file after 7 days. |
| `code-stamp.ts` | When the code changed, so the hub knows to restart into it. |
| `auto-update.ts` | The version line, and the git calls that pull origin's `stable` tag (the decision is `core/auto-update.ts`). |
| `config-watch.ts` | Watching config.json and secrets.json: a `people` change applies now, any other key restarts the hub once it is quiet, and a wrong file is refused and DMed. |
| `hold-keys.ts` | Taking `sessionKeys` out of the environment before the router loads, so no session copies one (#182). |
| `jobs.ts` | The hub's timed work on one clock: each job on its own period, retried next period when it fails. |
| `kagelet-memory.ts` | A kagelet's memory folder on disk and the proposals waiting on Kage's review. |
| `key-proxy.ts` | The key proxy (#182): a unix socket that adds a held key to requests for its one host, so the session never sees it. |
| `memory-snapshot.ts` | A copy of Kage's memory before a dream, so `kage dream undo` restores it. |
| `repo-access.ts` | Whether this install may push to the Kage repo, which marks the repo owner's hub. |
| `channel-watch.ts` | Jobs that watch a Slack channel (tripwire rung 2): which jobs a post is for (channel, match, bots allowed), the recent post ids seen per channel, the catch-up cursor, the quoted posts held until the job takes them, and the catch-up after a socket gap, one channel at a time. The hub wires it to `channelPost` and `channelCatchUp` in `connectors/slack.ts`. |
| `job-events.ts` | The rules between an event and its job (tripwire rung 2): a refused unsafe match, the watch set and removed with its job, a post or a catch-up turned into a wake of the job's lane, the capped catch-up repeated until the channel is read, one ping per failing channel, and one `tripwire` event row per step (ids and counts only). |
| `probes.ts` | The runtime of a tripwire probe: best-effort pins of every swappable file a command names (except its `reads`, `writes` and redirect targets), and one run with a timeout, an output cap (the fingerprint still covers all output) and a refusal when a pin changed or an ignore pattern is unsafe. |
| `probe-jobs.ts` | Probe jobs (tripwire rung 1): when a probe job is due, the hub runs its command with no model, wakes the job only when the output changed (the wake goes out before the new state is saved), pings the job's thread on repeated failures or a refusal, and writes one `tripwire` event row per step. `scheduler.ts` calls it, and `runtime/tools/schedule-tools.ts` sets and tunes the jobs. |
| `shadow-swap.ts` | Self-swap on the hub's clock (ADR 0017): grades each twin from the ledgers, tells the owner once per miss, swaps a proven twin in (saves the old job, makes the twin live, then removes the old job), finishes a swap a crash cut short, and the owner's restore. `hub/job-events.ts` wires it. |
| `release.ts` | The git and gh calls of a release, and the owner hub's daily check (`kage release`, ADR 0013). |

## Add a connector

A connector touches more places than it should today. Copy `connectors/email.ts`, then update:

1. `Conversation['connector']` and the key prefix in `core/conversations.ts`.
2. `senderOf` in `core/gate.ts`, if its sender is not plainly the owner or a teammate.
3. The reply type in `runtime/protocol.ts`, `routeReply` in `runtime/session-link.ts`, and the `reply` tool in `runtime/kage-tools.ts`.
4. `replies` in `hub/connectors.ts` and `failed` in `hub/router.ts`, and the connector names written out in `core/blocks.ts`, `core/loom.ts` and the reply tool in `runtime/kage-tools.ts` (one connector table is planned).
5. The inbox (`Inbox` in `runtime/store.ts`): `take` each message with a unique source id before you acknowledge it, and `handled` after. If the source does not resend by itself, add its `replay` to `replayOf` in `hub/connectors.ts`.
