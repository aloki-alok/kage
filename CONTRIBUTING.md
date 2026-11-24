# Change the code

## Check a change

```sh
npm ci              # once
npm test            # every *.test.ts under src/core/, src/connectors/, src/runtime/, src/cli/ and tests/
npm run typecheck   # tsc --noEmit
```

`npm run eval` checks behavior, not code paths (#489). CI runs it after `npm test`, and it takes about 2 seconds. It needs no model and no Slack. Each `evals/scenarios/*.json` file boots the real scheduler, dispatcher, SDK runner, Kage tools, kagelet manager, routes and incidents on the fake SDK, in a temp folder. The harness refuses to run against `~/.config/kage`. A scenario's `steps` move the clock (`at`), add a job or kagelet (`job`, `kagelet`), run the clock (`tick`), end a run (`end`), check for stalls (`stalls`), deliver a task (`task`) and call a Kage tool (`call`). Its `expect` lists every task delivered, every owner DM and every tool result, in order, as regexes. `evals/dream/cases.json` holds dream cases: fixture threads, the lessons a dream proposes, and which must be `learned` or `never`. `checkDream` scores them. Add a scenario when you fix behavior a unit test cannot show end to end. `npm run eval <word>` runs only the scenarios whose file name, or the dream cases whose name, contains that word.

`npm run eval:live` checks that Kage still does its work well, on the real model (#553). It costs real tokens, so CI never runs it. Each case in `evals/live/cases.json` writes fake files into a temp folder, gives a real Kage session (the SDK runner, Kage's tools and skills, the hub's guards, no owner settings) one or more tasks from the owner or a teammate, and grades what the session left: its replies, files, tool calls, approval cards, settings, schedules, the reports it would file to the Kage repo (a stand-in records them, nothing is sent) and the exit code of a check command. The owner says yes to a card in an owner task and no in a teammate task, inside the turn: the hub's deferred cards (`src/runtime/deferred-approvals.ts`) are not in the eval. Teammate threads get the default sandbox, the live config folder is walled as in the hub, and a `kage` command a session runs reads an empty eval config, so a run never changes the live Kage. Each case runs 3 times, and the table gives passes, tokens in per turn (median and range) and model steps. A run that ends on an API limit counts as neither a pass nor a fail, and the gate asks for the case to run again. A change that aims to save tokens runs the set before and after, and the gate fails it when a case fails in 2 or more of 3 runs after the change but in fewer before:

```sh
npm run eval:live -- --out before.json          # on main; add a word to run only the cases that contain it
npm run eval:live -- --out after.json           # on the branch
npm run eval:live -- --compare before.json after.json
```

`npm test` runs each test file in its own process and kills one still running after 5 minutes (`tests/run.ts`). A fake that a loop calls (`ask`, `sleep`) throws after a fixed number of calls, so a loop that never ends fails its test instead of hanging the run (#277).

Tests live in a `tests/` folder inside the folder of the code they test: `src/core/gate.ts` is tested by `src/core/tests/gate.test.ts`.

`tests/structure.test.ts` checks the layout itself (ADR 0014): `src/core/` stays pure, nothing below the root imports a root file, no source file passes 300 lines, every `src/core/` and `src/runtime/` file is in the tables below, and no export goes unneeded. Each rule lists today's breaks as debt that may only shrink. The `ks` CI job ([kagestack](https://github.com/aloki-alok/kagestack), pinned in `.github/workflows/ks.yml`) fails a pull request that adds a comment or a skipped test, or that pushes a function past 60 lines. Run it locally with `uvx --from git+https://github.com/aloki-alok/kagestack ks check`. The skill `.claude/skills/kage-change-code` has the rest of the clean-code rules.

The rules Kage follows, and why, are in [`docs/adr/`](docs/adr/). Read the ones that bind your change before you write code.

The Chrome extension (`extension/`) runs in a browser, so `npm test` cannot reach it. Its end-to-end check loads it into Chromium, pairs it the way `kage connect browser` does, and attacks it with `extension/tests/e2e/page.html` (forged refs, overlays, mousemove traps, masked secrets). Run it after any change to `extension/`, `src/connectors/browser.ts` or `src/core/browser*.ts`:

```sh
uv run --with playwright python -m playwright install chromium        # once
uv run --with playwright python extension/tests/e2e/run.py               # 31 checks, exits 1 on a failure
```

Seven tests call a real model, so `npm test` skips them. `sandbox.test.ts` starts real sessions with `harness.sandbox` on and checks that the token files, the settings and the hub code stay closed. It also runs one tmux pane (skipped without tmux) that unsets `KAGE_SESSION` and tries to write `config.json` and read `secrets.json`. `sandbox-off.test.ts` starts one with the sandbox off (`harness.sandbox false`, and the owner's own threads by default) and the hub's hook rules: the shell writes, binds a port and reaches the web and the SSM relay, and the token files and settings stay closed. Run these three after any change to `protectConfig` or `toolRefusal` in `src/runtime/path-guards.ts`, or to a session's sandbox or permission settings. `sandbox-teammates.test.ts` checks the default, `teammates`: a teammate's thread cannot read `secrets.json` with a reworded command, and the owner's own thread binds a local port. They cost a few cents:

```sh
KAGE_LIVE_TESTS=1 node --test src/runtime/tests/sandbox.test.ts src/runtime/tests/sandbox-off.test.ts src/runtime/tests/sandbox-teammates.test.ts
```

`src/runtime/tests/agent-allow-lines-live.test.ts` checks that an owner allow line and auto mode, which skip `canUseTool`, still cannot run a shell command on an agent's task, because the PreToolUse hook refuses it first (#518). Run it after an Agent SDK upgrade or any change to the session hook:

```sh
KAGE_LIVE_TESTS=1 node --test src/runtime/tests/agent-allow-lines-live.test.ts
```

The fifth, `src/runtime/kagelets/tests/all-live.test.ts`, runs a session set up as a `tools: all` kagelet: everyday git and web work runs, a forced push and a sending web request are held, and the tokens, the settings, its `job.md` and Kage's code stay closed. Run it after any change to `src/core/held.ts` or the kagelet grant check:

```sh
KAGE_LIVE_TESTS=1 node --test src/runtime/kagelets/tests/all-live.test.ts
```

Two more check goal-seeking kagelets (#427). `keep-watching-live.test.ts` gives a Kage session with the repo's skills the owner's "keep watching the open P1s", and checks it saves a kagelet with an objective, a measure and a target, and says its goal in the thread. `objective-live.test.ts` runs a kagelet three times as its number goes 7, 4, 4, and checks each report names the change and a next step. Run them after any change to `src/core/objective.ts`, the report tool, or the kagelets and watching-jobs skills:

```sh
KAGE_LIVE_TESTS=1 node --test src/runtime/kagelets/tests/keep-watching-live.test.ts src/runtime/kagelets/tests/objective-live.test.ts
```

`tests/upgrade-drill.sh` installs the previous release from a local copy of this repo, keeps an old env file, runs `kage update --stable` to your commit, starts the hub once (it stops at Slack, which refuses its fake tokens), and checks the settings and `kage doctor`. CI runs it on every pull request (`.github/workflows/upgrade.yml`), and `kage release` refuses a commit where it failed. Run it after a change to `install.sh`, `setup.sh`, the settings import or the packages. It upgrades to HEAD, so commit first:

```sh
tests/upgrade-drill.sh
```

`tests/setup-rehearsal.sh` lets you go through a first install and `kage setup` the way a new person does, from your working tree with uncommitted changes. It runs in a throwaway HOME. A stand-in Slack page on 127.0.0.1 hands out fake tokens, and stand-ins for `open`, `launchctl` and `tmux` keep your real Kage, its LaunchAgent and its tmux session untouched. Run it in a terminal on macOS after any change to what setup prints:

```sh
tests/setup-rehearsal.sh
```

There is no build. Node runs the TypeScript files as they are, so write only syntax it can strip (`erasableSyntaxOnly` in `tsconfig.json` enforces it). A running hub restarts into new code by itself once every session is quiet (`src/runtime/code-stamp.ts`).

Write logs to stderr only. In a tmux pane, stdout carries the channel protocol, so a stray `console.log` breaks it.

## Words

| Word | Means |
|---|---|
| conversation | Where a message lives: a Slack thread, an email thread, a WhatsApp chat, a voice call (`src/core/conversations.ts`). |
| session key | The stable id of a conversation's session, such as `C123:1730.55`, `dm`, `mail:<id>`, `voice:<id>`. Saved for good, so a thread always resumes its own Claude conversation. |
| session | One Claude Code conversation working on one session key. |
| runner | Where sessions run: an Agent SDK session inside the hub (default), or a tmux pane. |
| place | The label people read for a conversation, such as `#general` or `DM with Kage`. |
| lane | A second session on the same conversation (`@kage side: ...`). |
| hub | The long-running process (`src/hub/router.ts`) that owns Slack, the dispatcher and the store. |

## Where things are

| Folder or file | Holds |
|---|---|
| `hub.ts` | The hub's entry, run by the service: the log file's size, the boot count and the crash-loop DM, then `src/hub/router.ts`. Node modules only, so a bad pull is still caught. It stays at the root because every install's service runs this path. `start.sh` only forwards old login items to `kage start`, until 2026-12-15. |
| `src/hub/router.ts` | The hub, loaded by `hub.ts`: wires connectors, the dispatcher, the runner and the store. Its header names the few rules still in it. |
| `src/hub/config.ts` | Reads the settings files and makes the Slack clients. Only `src/hub/router.ts`, `plugin/server.ts` and `src/cli/` import it; everything else logs through `src/runtime/log.ts`. |
| `src/hub/updates.ts` | The hub's own code: the version it runs, the restart into newer code or changed settings, the auto-update to origin's stable tag, and the release the owner's hub makes. |
| `src/hub/owner-digests.ts` | What the owner gets on a clock: the daily note (questions waiting a day, grants with no card) and the Monday retro. |
| `src/hub/dreams.ts` | The nightly dreams: Kage's own over the day's threads, and each kagelet's over its runs. |
| `src/hub/connectors.ts` | The connectors the hub starts beside Slack (GitHub, meetings and the meeting bot, email, voice, WhatsApp, SMS), how a reply reaches each, and how a stored message replays through its own connector. |
| `src/hub/job-events.ts` | Jobs that an event wakes: it builds the channel watches and the job webhook server (`src/connectors/job-hooks.ts`) from the `tripwires.*` settings, rebuilds every watch from the stored triggers at start, and gives the router one place for `schedule`, `unschedule`, the Slack hooks and the webhook replay. |
| `src/hub/kagelets.ts` | Kagelets in the hub: the minute sync of their files into schedules and grants, the cost flags and caps, their memory, the manager's side, the owner's notes to one, and the chains between them. |
| `src/hub/telemetry.ts` | Telemetry in the hub (ADR 0019): the install id, the minute export job, Claude Code's telemetry env for every session, and the crash code written before exit. |
| `src/hub/owner-commands.ts` | What the owner asks from their terminal or DM: the status line, `kage tell`, `kage relay`, and `say` (an app on this Mac posts as the owner). |
| `src/hub/whatsapp-cards.ts` | An approval card sent to the owner on WhatsApp when they picked that channel, with a four-digit code, and their `yes` or `no` reply answering that card once. |
| `src/hub/phone-owner.ts` | Calling the owner: runs `connectors.call.command` with a one-time voice code and the reason, and says why when it cannot. |
| `src/hub/self-check.ts` | The hourly doctor run (`src/runtime/doctor-watch.ts`) wired to the owner DM, the event ledger and, on the repo owner's hub only, `fileFound` for a check that did not run. |
| `src/hub/startup.ts` | What the hub does once at start after it connects: adopts cron jobs exported from tmux panes, tells the owner about an update, unplaced settings or missing Slack scopes, and replays messages the last run heard but never handled. |
| `plugin/server.ts` | For tmux panes only: serves Kage's tools over MCP inside each pane and relays approvals. |
| `plugin/private-data-guard.ts` | The plugin hook (`hooks/hooks.json`) that runs the rules in `src/core/guards.ts` and `src/runtime/path-guards.ts` inside tmux panes. The SDK runner applies the same rules in process. |
| `plugin/turn-end.ts` | The plugin's Stop hook: marks the end of a pane's turn, so `src/runtime/pane-turn.ts` can give the owner's folded-in message its own turn with the owner's tools. |
| `src/core/` | Pure rules. See the table below. |
| `src/connectors/` | Where Kage hears from. Each turns a message into a `Task` (`src/core/task.ts`). Who may drive Kage is decided in `src/core/gate.ts`, not here. |
| `src/connectors/slack/` | The Slack connector, end to end: `connect.ts` (the socket, the gate's call, tasks and replies), `directory.ts` (names, places and the thread a task quotes), `task-text.ts` (the task's text: who asked, agent notes, trust), `socket.ts` (the Socket Mode link and its restarts), `commands.ts` (slash commands), `say.ts` (`kage say`), `afk.ts` (the AFK stand-in's Slack side) and `heard.ts` (the one-or-two-word ack). Slack's pure rules stay in `src/core/slack-*.ts`, the session's Slack tools in `src/runtime/tools/slack-tools.ts` and `src/runtime/slack-read-tools.ts`, and `kage slack` in `src/cli/slack.ts`. |
| `src/runtime/` | Where sessions run, and the hub's state. See the table below. |
| `src/cli/` | The commands behind `kage <command>`. They run from source. `src/cli/config.ts` reads and changes settings for the shell scripts and `kage set`. `src/cli/doctor/` is `kage doctor`: one file per check group, and `run.ts` prints their lines. |
| `setup.sh` | The `kage` command: setup steps, start, stop, logs. `doctor` calls `src/cli/doctor/run.ts`. |
| `service.sh` | The LaunchAgent (macOS) or systemd user unit (Linux) that keeps the hub running. A non-zero exit restarts it, and exit 0 leaves it down. |
| `docs/adr/` | One file per architecture decision: the rule, why, and how it is checked. |
| `tests/` | Tests of the repo as a whole: `structure.test.ts` (ADR 0014). |
| `docs/settings.md` | Every setting in config.json and secrets.json, with its default. |
| `CLAUDE.md` | The one file coding agents read first: setup steps, the commands that run Kage, and this file (loaded with `@CONTRIBUTING.md`). |
| `extension/` | Kage's Chrome extension (#114): plain JS, no build. It polls the hub (`src/connectors/browser.ts`), reads tabs, and acts in them through Chrome's debugger, one action at a time; a major step waits for the owner's yes (src/core/browser-act.ts majorAct). |
| `meetbot/` | Kage's meeting bot (#63): its own package, run on any machine with a screen or Xvfb. It drives its own Chromium into a Google Meet and talks to the hub at the meeting webhook (`src/connectors/meeting.ts`). All of Meet's page knowledge is `meetbot/page.js`. |
| `screen/` | Kage Screen (macOS 15 or later): a small ScreenCaptureKit app that records the screen or takes one picture of it, reads the front window's elements, and acts on the Mac for the `computer_look` and `computer_act` tools (a ref, clicks, keys, typing), drawing Kage's own cursor so the owner sees each step. CI type-checks it on macOS. It runs as its own app, so macOS asks the owner once to allow it, and the hub and its sessions never hold screen access. `src/runtime/screen.ts` builds and drives it. |
| `metabot/` | The Meta bot: answers strangers on a Facebook Page, in Instagram DMs and under Page comments, as its own process with no tools (ADR 0020). One model call, a fixed check, a guard, then a draft or a send by mode. Setup and settings are in `metabot/README.md`. |
| `waha/` | Kage's WhatsApp bridge (#351): `compose.yaml` runs WAHA in Docker, `up.sh` starts it on the ports in the settings, and `qr.sh` links the owner's phone. No keys: the container reads `waha/.env` in the config folder, which the hub writes from secrets.json. Steps are in docs/settings.md, "WhatsApp". |
| `skills/` | Skills every Kage session loads (the router passes the repo as a plugin, `src/hub/router.ts`). Generic lessons only: no names, ids, customers, dates or quotes. |
| `.claude-plugin/`, `.mcp.json`, `hooks/` | Used only when Kage is installed as a Claude Code plugin (tmux panes on the plugin route). |

### src/core/

| File | Rule |
|---|---|
| `gate.ts` | Who may start a task, the task line Claude reads, quoting the thread, teammates. |
| `agents.ts` | Talking to another agent: the tag on every part of a post that must reach it (only with `tag_agent`), and the loop guard. |
| `leftovers.ts` | What a session left running (#276): a process whose folder is gone, a test run past 10 minutes, a container its restart policy restarted within the hour, and the line that names the command that stops each. `src/cli/doctor/leftovers.ts` reads `ps`, `lsof` and Docker or Podman, and `src/cli/top-leftovers.ts` counts them each minute for the `kage top` banner. Kage only reports, and the owner decides. |
| `boots.ts` | Why the hub started (#255): the cause each start line in the `boots` file carries (update, settings, restart, crash with its error line, unknown, first), and the line `kage status` prints. `src/runtime/hub-log.ts` writes the cause on the way out and the line at start. |
| `doctor.ts` | What `kage doctor` decides from the facts `src/cli/doctor/` gathers: each ok, FAIL or note line, the closing "All good" that the release soak gate reads, and what the hub's hourly run tells the owner (`doctorNews`). |
| `jev.ts` | Whether a listed agent's post needs a reply: the Jev settings, which agents it checks, the question, and how its score decides. The call is `src/connectors/jev.ts`, and `src/cli/jev-doctor.ts` is the doctor's line. |
| `config.ts` | The settings schema (one zod schema for config.json and secrets.json), the fixed table from old env names to its keys, the import and the flat env built back from it, and which changed keys apply live. |
| `registry.ts` | Who is listed besides the owner: people, agents and each agent's owner, as `people` in config.json. |
| `slack-message.ts` | What a Slack message event is, whether a person typed it, and the `@kage` tag. |
| `conversations.ts` | A conversation and its session key, both ways. |
| `sessions.ts` | The dispatcher: one session per key, the slot limit, idle close, eviction, holds for `kage attach`. |
| `outbound.ts` | What may go out: no crowd pings, no secrets in a thread, Slack-sized parts, code blocks narrow enough for the thread panel, and a guard's SEND or HOLD on a message leaving as the owner. |
| `guards.ts` | Hook rules that need only the tool name and the sender: private sources, voice calls, agents' tasks (read and answer only), Slack posts only through Kage's tools. Where the two memory folders are. |
| `ledgers.ts` | Reading the ledgers: questions waiting on the owner, what Kage posted, what turns cost, the daily note. |
| `thread-delta.ts` | Which thread replies a task carries: only those after the last task when the same session resumes, the whole thread for a new or reset session, and how Slack `ts` values compare. A task names its thread's mark, and the mark moves only when the dispatcher hands that task to the thread's own session (`markDelivered`), so a task a stop drops while it waits is never counted as seen. A delta built for an older session never moves the new session's mark. A task sent into a running turn counts as seen once it is handed over, even if a cut ends that turn before the session reads it. |
| `thread-rotate.ts` | When a long thread starts a new session: the context its last turn read, the limit that makes it due, and the note the new session gets. |
| `events.ts` | The event log's row (what happened, never what was said), its 30 days, and a chain read back as `a > b > c` and where it stopped. |
| `kagelets/people.ts` | Who may ask a kagelet for work: its people and owners lines (one line of Slack ids each, at most 3 owners) and the check of an ask in its thread. |
| `kagelets/kagelet.ts` | A kagelet file (thread, schedule or `after:`, grant, job), the grant check, the chain check (no cycle, no missing kagelet, at most 5 deep), standing approvals per write tool and their revoke, the cost caps (off unless set) and the cost flags. |
| `kagelets/message.ts` | The message one kagelet sends another (an `after:` handoff or `message_kagelet`): its fields, named after A2A's Message, its delivery states, and the check where it enters the hub. |
| `kagelets/incidents.ts` | What a failed or stalled kagelet run leads to (#487): one retry with a first line saying why, then one DM to the owner with its last words and report as data and the fix when it is known. A failure a retry cannot fix goes to the owner at once, and `kagelets.incidentsPerHour` failures in an hour pause it. A run the owner stopped never counts. |
| `kagelets/view.ts` | What a terminal shows of kagelets: the `kage top` panel, its keys, and `kage logs <kagelet>`. |
| `held.ts` | The hub's check on a kagelet's shell (`tools: all`, ADR 0018): which commands are one-way steps (a deploy, a forced push, a DB write, a delete, a send), held for Kage. It stands behind the OS sandbox, never in place of it. |
| `held-review.ts` | The cheap reviewer of a held step: the low-stakes kinds it may let run (local deletes and its own branches), what it reads as data, and its RUN or HOLD verdict, which fails closed. Also the `card-verdicts` row (written and read here only) and the evidence a kind must earn before the reviewer may release it (#542). |
| `held-rules.ts` | The owner's `allow:` lines in a kagelet's `job.md`: which held step each releases, word by word with no model, and the kinds no rule ever releases. |
| `objective.ts` | A kagelet's objective (ADR 0016): the three lines in its file, the one `value: <n>` line a measure prints, the target check, and the scoreboard every run reads. |
| `access.ts` | The access tiers: whether a kagelet's tool is read, write or act, from its name. |
| `db-read.ts` | The check a `db_read` query passes: one read statement, capped. |
| `browser.ts` | What a session may see of the owner's Chrome (#114): the block list, tabs shown by id, and a page's text quoted as data. |
| `desktop-act.ts` | Acting on the owner's Mac (`computer_act`, by ref or by point): which acts and keys are allowed, and what each needs. Everyday steps run. A click, Enter or Space on a control that cannot be undone, or a one-way command sent in a terminal, asks the owner. Turning the Mac off, logging out, locking or erasing it is refused. A terminal takes one typed line at a time, and Return on a line Kage did not type asks. |
| `look.ts` | A look at the owner's front window (`computer_look`, #509): the answer Kage Screen gives, checked where it enters, and the text a session reads, one `[r12] button "Send"` line per element, with labels and values quoted as data. |
| `browser-act.ts` | Acting in the owner's Chrome: a page's controls as refs (labels quoted as data), which actions and keys are allowed, and the approval card's line, named from the page. |
| `meetbot.ts` | Kage's meeting bot (#63): which Meet links it may open, and the caption lines it posts, kept as data. |
| `browser-pair.ts` | Pairing the Chrome extension with no paste: its fixed id, the helper's folder in each Chromium browser, and Chrome's message framing. `src/cli/browser-pair.ts` is the helper Chrome starts. |
| `slack-scopes.ts` | The bot and user scopes the Slack app needs (the manifest writes them), which a granted list lacks, the doctor's lines, and whether the owner is told of a missing set. `src/runtime/slack-scopes.ts` asks Slack, and `src/cli/slack.ts` is `kage slack upgrade` (it adds the missing scopes to the app's manifest with a configuration token, or prints the lines to paste), and `src/cli/doctor/scopes.ts` is the doctor line. |
| `slack-files.ts` | Files attached to a Slack task: which the hub downloads (not canvases or quip docs, 25 MB each, 10 per task), the saved name, and the lines that list them in the task text. `src/runtime/slack-files.ts` downloads them with the user token into the thread's files folder. |
| `ssm.ts` | The one call the SSM relay runs for a session (the arguments aws gives `session-manager-plugin`: operation, region, stream and endpoint hosts), and which session keys may hold a token. |
| `cron.ts` | Cron expressions, which schedules are due (an `@event` job never is), and reading Claude Code's own cron jobs. |
| `email.ts` | Email as a way to tag Kage: who may (the provider's DKIM signature, not only DMARC), the ask in the new text, the reply-all, and the guard on a reply that leaves the owner's domains. The SES, S3 and SQS calls are `src/connectors/email.ts`. |
| `whatsapp.ts` | The owner's WhatsApp: the owner's tag is the only way in, the armed-chat stand-in, the guard that reads every message before it leaves as the owner, and what a look at the WAHA bridge means: the problem line with its fix, and the hub's one DM down and one back. The WAHA webhook, calls and the bridge look are `src/connectors/whatsapp.ts`, and `src/cli/doctor/whatsapp.ts` is the doctor line. |
| `tripwire.ts` | Tripwires: the pure rules of a probe that wakes a session only when its output changes, or when its last line says to (#516). How output is normalized and fingerprinted, the words of a command, the temp paths a job may not name (the OS clears them), which ignore patterns are safe, whether a pin changed, what one run does to a job's state (a wake, a failure ping), the hash kept of a job webhook's token, and when a hook needs the owner's card. |
| `shadow.ts` | Self-swap (ADR 0017): a twin's link to the job it shadows, and the pairing of that job's acts (own-thread posts and prod writes) with the twin's verdicts into matches and misses, and when a swap is due. |
| `afk.ts` | AFK mode: which threads the stand-in watches, when it posts or phones the owner, and what it may say. |
| `job-needs.ts` | The tools a job names in `needs`: which are live (each connected MCP server's tools, named as a session sees them, and nothing known while one still connects; for a job whose runs get a teammate's trust, none of the owner's), and the owner's one DM when one goes missing and one when all are back. Also which of a job's needs a twin woken by events can never load, because its runs get a teammate's trust (#641). |
| `pane-turn.ts` | Who a tmux pane's turn runs for: the lowest sender in it, the owner's message marked when it joins someone else's turn and run again on its own once that turn ends, and a message that came after the turn's last step kept for the next turn. |
| `owner-channel.ts` | Where a message to the owner goes: the app in `owner.channel`, and the Slack DM when that app is not running or its send fails. |
| `blocks.ts` | When the safety check stops a turn: the line in the thread, the owner's DM, and whether the thread closes. |
| `commands.ts` | Local slash commands (`connectors.commands`). |
| `auto-update.ts` | Whether the hub may move its own checkout to origin's `stable` tag, the link to what changed, and `soakGate`: whether a commit ran long enough on the owner's hub to be released. |
| `release.ts` | The next version and the release notes from merged PR titles. |
| `preview.ts` | How an approval shows the call it asks about. |
| `transcript.ts` | Turning a Claude Code transcript line into a line a person can follow. `src/runtime/transcript-tail.ts` reads the new lines from disk. |
| `telemetry.ts` | What an event row may tell the world (ADR 0019): fixed words and numbers per kind, the crash fingerprint, the OTLP body, whether telemetry is on, and the session env that never sends content. |
| `stats.ts` | What `kage stats` shows: spend per day, per connector and per model, tokens per turn by kind of thread, runs, refusals, turn time, hub starts and the outcomes of reports to the Kage repo, from rows Kage already keeps (no content). `src/cli/stats.ts` reads them. |
| `task.ts` | `Task`: what a connector turns a message into, and what a runner takes (ADR 0002). |
| `instructions.ts` | What every session reads first: who it is (Kage, a kagelet, or a kagelet's nightly dream), whom it serves, how it answers, and each kind of task's limits. A kagelet reads Kage's door rules word for word. |
| `secret-commands.ts` | A token in secrets.json that names a command (#158): which tokens do, by dotted path, the settings where reading such a token runs its command, and each failed command named. `src/runtime/config-files.ts` runs each command at most once per process, only when its token is read, and `src/runtime/path-guards.ts` refuses them inside sessions. |
| `secret-prompt.ts` | A hidden token prompt's rules: what each key does to the line, whether a paste is the token asked for (and which one it is when not), and how a saved token is shown. `src/runtime/terminal-secret.ts` draws the prompt, and `src/cli/ask-secret.ts` is its entry for `setup.sh`. |
| `away.ts` | What bare `kage` says happened since the owner last looked: replies and threads, kagelet runs, kept lessons and spend from the ledgers, the asks still waiting on them, and how many kagelets are on. `src/cli/home-screen.ts` draws it beside the wordmark and saves the time of the look. |
| `voice.ts` | How the `kage` command speaks and looks: one color for Kage and its work, a warm one only for what needs the owner, the marks (✦ • ◆ ◌), the wait flicker, the wordmark with its cast shadow, and a session step in Kage's words for `kage logs`. `setup.sh` repeats the colors, marks and flicker, and the test checks they match. `src/cli/voice.ts` turns color on only at a terminal without `NO_COLOR`. |
| `messages.ts` | Every fixed line Kage writes to the owner on its own (a held reply, a failed event, a release, a settings refusal), one function per line. A call site never writes the words itself (#241). |
| `text.ts` | Text helpers every rule shares: `oneLine`, and `quotedLine` for someone else's text (no `<channel>` tag survives). |
| `setting-docs.ts` | What `kage set` says with no value: every setting from `docs/settings.md` by section with its value and default, one setting in full, and the closest key to a typo. |
| `cli-help.ts` | The closest real `kage` command to a mistyped one. |
| `dream.ts` | The nightly dream job: what it reads for lessons, how it tidies Kage's memory, which lessons may leave this machine, and `checkDream`, the check a lesson passes before it reaches memory (#488): two threads or more with exact quotes, enough confidence, a nightly cap. A knowledge flag (`flags` ledger) from a working session lets one thread prove a lesson, quoted from that thread or the flag, and the dream closes each flag as fixed, merged or dismissed (#541). |
| `connect.ts` | Whether each connector is on (#551): one table, from the settings, that `kage connect`, the tunnel and the doctor read. A connector is on, turned off by the owner, or unset with the settings it still needs, and the one step left for each. `src/cli/connect.ts` is `kage connect`: the list, the Chrome extension's pairing, and on or off for the connectors with an on setting. `kage connect github` makes the Kage GitHub App (`src/cli/github-app.ts`), adds an org with `--org`, and turns it off. |
| `tunnel.ts` | One tunnel for every Kage port another machine needs (#492): the route each connector that is on gets (public by path on Kage's own port 8443 for what the internet calls, the tailnet for the meeting bot), the Tailscale commands that open and close only the routes Kage recorded as its own, each route's state read back from `tailscale serve status`, and the doctor's lines. `src/cli/tunnel.ts` is `kage tunnel`, `src/cli/tailscale.ts` finds and asks Tailscale, and `src/cli/doctor/tunnel.ts` is the doctor line. |
| `sms.ts` | Texts (SMS) to US numbers: the STOP, START and HELP keywords, the 2pm to 8pm Eastern send window, billed segments, a US number in E.164, the order a text's status moves in, a campaign's legal steps and its report, and the task line for a stranger's text. |
| `sms-providers.ts` | What an SMS provider's webhook means (Twilio and Telnyx), and the check of its signature before the body is trusted. |
| `signature.ts` | A webhook body signed with a shared secret (`X-Hub-Signature-256`), as GitHub and Meta sign. |
| `github.ts` | Which GitHub events wake Kage (#552): only a tag of the Kage app, in a comment, an inline review comment, a review, or a new issue or pull request, from someone the repo lists as owner, member or collaborator, and never from a bot. A tag is heard only from the person who acted, and it is the owner's only when that person's user id is the saved one. `githubOwner` picks the login and user id at setup. The installations Kage acts on (those on the accounts the owner allowed), and the manifest of the app `kage connect github` asks GitHub to make. `src/connectors/github-app.ts` signs the app's token and lists its installations, and `src/cli/github-app.ts` is the page that makes the app. |
| `kagelets/memory.ts` | A kagelet's own memory folder (#98): what its prompt reads, and the one path into the folder. |
| `log-repeats.ts` | One log line for a burst of the same line, with its count. |
| `meeting.ts` | A finished meeting's transcript as one task: notes, decisions, owners, open questions, and proposed actions that wait for the owner's yes. |
| `quiet.ts` | `kage stop` and `kage restart`: drain the hub, then wait for every thread to end its turn, naming each one. |
| `retro.ts` | The weekly retro: what Kage's own ledgers say to change. It proposes; the owner decides. |
| `settings.ts` | The old env file read once for import, the answer `kage reload` gives, and which settings apply without a restart. |
| `issue-report.ts` | A report to the Kage repo (#543): the repo from the checkout's origin or `report.repo`, the scrub (names, ids, emails, paths, tokens, addresses, hosts, quotes), the fingerprint that finds a duplicate, the body for the Report from Kage or Idea form, the prefilled link, and today's count against `report.perDay`. `src/runtime/issue-report.ts` runs git and `gh`, and `src/runtime/tools/report-tools.ts` is the tool. |
| `skill-lessons.ts` | The check a lesson passes before the dream shares it with every install: nothing that tells whose Kage learned it. |
| `connector-health.ts` | What `kage status` says of each connector (#256): on or off from the hub's own start lines, when it last heard something, its failures in the past hour, and Jev's calls today. The hub feeds it every log line (`tapLog` in `src/runtime/log.ts`) and keeps it in memory only. |
| `socket-watch.ts` | When to restart the Slack socket by hand, because its own reconnect can stay down. |
| `board.ts`, `top-layout.ts` | What `kage top` shows: each thread's state and row (`board.ts`), and where its panes go for a terminal size, the list scroll, the state marks and the chart math (`top-layout.ts`). `src/cli/top.ts` reads the hub and the store and takes keys and the mouse, `src/cli/top-feeds.ts` follows each thread's transcript, `src/cli/top-hub.ts` asks the hub for the board over its socket, `src/cli/top-draw.ts` draws the header, the ask banner, the tabbed panes, the charts and the dialogs, and `src/cli/top-screen.ts` is its grid of cells. |

### src/runtime/

| File | Holds |
|---|---|
| `sdk-sessions.ts` | The default runner: an Agent SDK session per key, inside the hub. `src/runtime/tests/fake-sdk.ts` is the fake SDK its tests drive. |
| `long-output.sh` | Every shell command an SDK session runs goes through it (`CLAUDE_CODE_SHELL_PREFIX`). Output past twice `harness.commandOutputChars` bytes shows only its start and end, with the path of a file that holds all of it, and the exit code stays the command's own. Permission rules still see the command as written. Claude Code starts MCP servers and hooks through the same prefix, so anything that is not a Bash tool call (which always ends in `&& pwd -P >| <file>`) runs untouched. |
| `sdk-permissions.ts` | What a session on the Agent SDK may run: the tools that need no card, the owner's card (live in the turn, or deferred), a kagelet's grant, and the PreToolUse hook that runs the refusal chain in `src/runtime/path-guards.ts` and holds a kagelet's one-way shell step. |
| `sdk-stream.ts` | Reading one Agent SDK session's messages: the turn's state, a refusal or a hook that drops a prompt, a usage limit, each result and who the turn was for, and the restart that carries unread tasks into the next process. |
| `owner-claude.ts` | The owner's own Claude Code setup as a lean session needs it (#506): the model and effort in `~/.claude/settings.json` and the user MCP servers in `~/.claude.json`, read when each session opens. |
| `sdk-inbox.ts` | A session's input on the Agent SDK: the tasks waiting for its process, read as one stream. |
| `tmux-panes.ts` | The other runner: a Claude Code pane per key. |
| `job-needs.ts` | The MCP tools jobs need, on the hub's clock: a session with no prompt reads the SDK's MCP server status with no model turn (every 10 minutes, only while a job names `needs`), each owner session adds its own status at start, and the owner gets one DM per miss and one when it is back. The miss shows in `kage schedules` as `blocked:`. |
| `pane-turn.ts` | Who a tmux pane's turn runs for: the sender file the plugin hook reads, and Kage's owner-only tools in that pane. |
| `kage-tools.ts` | A session's tools (about 28): the state they share about its tasks (where each came from, who sent it, what Kage posted), and the approval card. The instructions every session reads are `src/core/instructions.ts`. |
| `src/runtime/tools/slack-tools.ts` | The Slack tools every session gets, in order: edits and deletes of Kage's own posts, attaching a file, the waiting list, the prod log, and a post as Kage where no task came from. |
| `src/runtime/tools/slack-reply.ts` | The `reply` tool: its refusals (secrets, other agents, unseen mentions, a private DM link), one table for each connector that answers outside Slack (voice, SMS, WhatsApp, email), and the Slack post with its waiting line and reaction. |
| `src/runtime/tools/slack-people.ts` | `message_people`: a group DM from the owner's account with Kage's footer, and the owner's card when the ask came from WhatsApp. |
| `src/runtime/tools/slack-canvas.ts` | A canvas the bot makes in the task's channel and keeps current. |
| `src/runtime/tools/schedule-tools.ts` | A thread's schedules in the hub, and AFK mode on and off. |
| `src/runtime/tools/kagelet-tools.ts` | A kagelet's tools (report, message another, db_read), its dream's (propose_memory), and the manager's. |
| `src/runtime/tools/browser-tools.ts` | The owner's Chrome, named after the Playwright MCP tools: `browser_tabs` (list, or open a new tab), `browser_read`, `browser_take_screenshot`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press_key` and `browser_navigate`, a major step on the owner's yes. |
| `src/runtime/tools/screen-tools.ts` | The owner's Mac: `computer_act` by point, shaped after Anthropic's computer use tool (clicks, a drag, a scroll, typing and keys), which acts by the rules in `src/core/desktop-act.ts`, the picture `computer_look` takes on ask, and `computer_record`, a recording that starts, runs while the session works, and stops into the thread's files folder. |
| `src/runtime/tools/computer-look.ts` | `computer_look`, the front window as lines with refs (#509), and `computer_act` on a ref: press, set or type, checked by `desktopVerdict` on the element behind the ref, refused by Kage Screen when the look is old or the window changed. |
| `src/runtime/tools/dream-tools.ts` | The nightly dream's `dream_lessons`: every lesson goes through the hub's check before it reaches memory, and a flag the dream finds wrong is dismissed with its reason. |
| `src/runtime/tools/owner-tools.ts` | Only the owner's own Slack task: the meeting bot, changing a setting, and flagging a note or skill that proved missing, wrong or stale for the nightly dream (#541). |
| `src/runtime/tools/report-tools.ts` | `report_issue`: a bug, an idea or feedback about Kage, scrubbed, shown to the owner on a card, then filed with `gh` or given as a prefilled link. A report whose fingerprint matches an open issue becomes one seen again comment on it. Never on an agent's task or a voice call, at most `report.perDay` a day, and one `issue-reports` ledger row per outcome. |
| `src/runtime/tools/sms-tools.ts` | Only the owner's own task: text campaigns to US numbers. A draft from numbers or a CSV in the thread's files folder, a launch on the owner's yes, pause, resume, cancel, the report and the list. |
| `screen.ts` | Kage Screen seen from the hub: it builds `screen/KageScreen.swift` into an app only when the source changed, and signs it with Kage's own self-signed certificate (a keychain file next to the app, closed to every session), so a rebuild keeps the owner's Screen Recording and Accessibility grants. Only a new certificate resets them. It writes the one job into the config folder, opens the app, reads the JSON lines it prints, and stops a recording with SIGINT. One recording at a time. To act, one Kage Screen stays open and reads commands from a pipe in that folder, answering each by id, until it sits idle for 5 minutes. Each pipe and log names the process that made it, and a new recorder removes those whose process is gone. |
| `session-link.ts` | The local socket that panes and the `kage` commands connect to. |
| `terminal-secret.ts` | The hidden token prompt at a terminal: a dot per character and the length while typing, the kind and length once taken, and a retry on the wrong token. Piped input is read whole. |
| `hub-client.ts` | The client end of that socket: one question to the running hub, one answer. Node modules only, because the shell scripts read settings through `src/cli/home.ts`, which imports it. |
| `protocol.ts` | The messages on that socket. |
| `slack-read-tools.ts` | The two Slack read tools the owner's own task gets (`slack_search`, `slack_read`): a Slack task, or an owner-verified voice call, where they load up front so a live call skips tool discovery. |
| `claude-once.ts` | One isolated `claude -p` answer for the guards and stand-ins (WhatsApp, Slack AFK): no MCP, no settings, nothing saved, run in an empty folder. |
| `transcript-tail.ts` | Reading the lines a session transcript gained since the last read (for `kage watch` and `kage top`). |
| `store.ts` | One SQLite file: conversations, their sessions, schedules, trust, the inbox of every message heard, and what connectors keep across a restart (AFK, GitHub and mail threads, each kagelet's `db_read` command and the standing approval of each write tool), and every kagelet message with its delivery state, stored before delivery so a restart replays it. The hub is the only writer of these tables. Old `.json` files move in once. |
| `sms-store.ts` | The SMS tables in kage.db: people by number, campaigns and their contacts, every text in and out with its provider id, status, error code and segments (never its words), and opt-outs. A contact is claimed before its send, so a crash never texts anyone twice. |
| `ledger.ts` | The ledgers (flags, issue-reports, waiting, posted, prod-actions, costs, runs, commands, reports, db-reads, grants, verdicts, card-verdicts) as rows in that file. The hub and every pane write them. Old `.tsv` files move in once. Also the event log (#94): one row per run start and end, kagelet tool call, report, grant (by card or standing approval), revoke, refusal, owner note, cost pause and cost flag, each on its run's trace. Rows older than 30 days fold into one summary row per day. |
| `ssm-relay.ts` | The SSM relay (#161): a unix socket where an owner thread's stand-in `session-manager-plugin` (`src/cli/ssm-plugin-shim/`, first on that session's PATH) asks the hub to run the real plugin. |
| `scheduler.ts` | Runs due schedules as tasks in their thread. |
| `schedule-edits.ts` | Changing a thread's schedules: add (a clock job, a watch, an event job, a probe or a twin), tune a probe, move a job to another thread, and adopt Claude Code's own cron jobs, each with the refusal it gives. |
| `limit-pause.ts` | The usage-limit pause: a turn that ends on the limit keeps its inbox message, its thread gets one notice, and the message replays at the reset. A kagelet message is never held here: it waits in the store. |
| `wa-cards.ts` | The 4-digit codes that let the owner answer an approval card from WhatsApp: one per open card, used once, gone after a day. |
| `deferred-approvals.ts` | An approval card that waits outside its session (#177): the turn ends when the card posts, the store keeps the card across a restart, the first answer wins, and a yes is spent by one retry of the same call. Each answer, and each card that goes stale unanswered, writes one `card-verdicts` row (#542): the thread, the tool, the step kind, a fingerprint of the input (never the input), the owner's verdict and the reviewer's when it ran. A no also holds that exact step on that thread for `kagelets.denyHoldDays`, and `kage top` `h` lifts a kagelet's holds. |
| `closed-threads.ts` | A thread the safety check stopped: it starts on a new session, and a teammate's stays closed until the owner writes in it. |
| `thread-rotate.ts` | Moving a long thread to a new session before its next task, reading only the transcript's tail, and never moving a task built as a delta for the old session. |
| `hub-lock.ts` | One hub per machine: a listening socket the OS frees when the hub dies. |
| `hub-log.ts` | The hub log's rotation and the package check, shared by `hub.ts` and the hub. |
| `path-guards.ts` | Hook rules that follow real paths on disk: the config folder that holds the tokens (secrets.json and env files closed to every session, the owner's too; the rest owner-only, a thread's files folder excepted), the sandbox and file rules each session starts with, and the owner's memory: every session may write people notes (`user_<name>.md`) and edit the index, the owner's own task may also edit or overwrite any note that exists, and a side lane (the dream, a kagelet) never does. A new note that is not about a person stays in Kage's own memory. |
| `log.ts` | Kage's log line (stderr only) and the logger the Slack clients get. |
| `kagelets/files.ts` | The kagelets folder on disk: one folder per kagelet (`<name>/job.md`, ADR 0018), the paused line, and the one-time move from the old `<name>.md` layout. |
| `kagelets/sync.ts` | The folder synced into schedules and grants each minute (#57), and the prompt each run reads first. |
| `kagelets/manager.ts` | The manager's tool (save, pause, resume, run, remove, revoke) and which tools each kagelet is granted: read with no card, a write tool on the owner's first yes, which then stands for that tool, act never. |
| `kagelets/incidents.ts` | Kagelet incidents on the hub: each run's end from `kagelets/routes.ts`, a lane with no step for `kagelets.turnStallMinutes` cut on the minute sync, the owner's stops, and the state kept in the store across a restart. |
| `kagelets/cost-cap.ts` | The cost caps on the hub's job loop: a kagelet over a cap is paused and flagged, and the owner is told once a day. |
| `kagelets/notes.ts` | The owner's words typed in a kagelet's thread, and Kage's answers (`tell_kagelet`), carried to its next run. |
| `kagelets/needs.ts` | A kagelet's needs to Kage in its thread (ADR 0018): kept in the store until Kage's session there is free, a repeat folded, and past `kagelets.needsPerDay` or a day unhandled, the owner's waiting list. |
| `kagelets/measures.ts` | Each kagelet's measure on the hub's clock, with no model: pinned like a probe, run only on the owner's yes when Kage wrote it, and the last readings kept for the scoreboard. The value never goes to the event log. |
| `kagelets/review.ts` | The reviewer on the hub at `kagelets.release` review: one isolated model call per low-stakes held step of a `tools: all` kagelet, at most `kagelets.reviewsPerDay` releases a day each, and one `held` event row per verdict. At `shadow` it never releases: its run or hold call rides on the owner's card into the `card-verdicts` ledger, and every ask counts toward the daily cap. |
| `kagelets/routes.ts` | The one route a kagelet's output or message takes to another kagelet (#93), with the loop guard and the chain cap. |
| `config-files.ts` | config.json and secrets.json on disk (the schema and the env import table are `src/core/config.ts`): reading, changing, the first-start import of the old env file, the one-time rewrite of the three old teammate lists into one, and deleting the old copies after 7 days. |
| `code-stamp.ts` | When the code changed, so the hub knows to restart into it. |
| `auto-update.ts` | The version line, and the git calls that pull origin's `stable` tag (the decision is `src/core/auto-update.ts`). |
| `config-watch.ts` | Watching config.json and secrets.json: a `people` change applies now, any other key restarts the hub once it is quiet, and a wrong file is refused and DMed. |
| `hold-keys.ts` | Taking `sessionKeys` out of the environment before the router loads, so no session copies one (#182). |
| `jobs.ts` | The hub's timed work on one clock: each job on its own period, retried next period when it fails. |
| `kagelets/memory.ts` | A kagelet's memory folder on disk and the proposals waiting on Kage's review. |
| `key-proxy.ts` | The key proxy (#182): a unix socket that adds a held key to requests for its one host, so the session never sees it. |
| `dream-lessons.ts` | Applying the dream's checked lessons to Kage's memory: a kept one becomes a note with an index line, a retired note moves to `.archive/`, and every drop is a ledger line. |
| `memory-snapshot.ts` | A copy of Kage's memory before a dream, so `kage dream undo` restores it. |
| `memory-listing.ts` | The files in Kage's memory and in the owner's, with size and last change. The dream task carries them, so the dream needs no listing tool. |
| `issue-report.ts` | The repo of this Kage checkout (`git remote get-url origin`), `fileFound` for a bug the hub found itself (a seen again comment on a fingerprint match, else a new issue), and the `gh` calls that file a report, find an open issue by its fingerprint and comment on it, each body on stdin. |
| `doctor-watch.ts` | The hub's own doctor (#153): it runs `kage doctor` 5 minutes after start and then hourly, DMs the owner the lines that failed on two runs in a row (a secret in a line is masked), again only when they change, says when all is good again, skips WhatsApp and Slack scopes (the hub already DMs those), treats a run past 120 s as a failure, files a check that did not run (or a run that timed out or printed nothing) as a bug on the repo owner's hub, once, through `fileFound`, and writes one `doctor` event per run with the count only. |
| `repo-access.ts` | Whether this install may push to the Kage repo, which marks the repo owner's hub. |
| `channel-watch.ts` | Jobs that watch a Slack channel (tripwire rung 2): which jobs a post is for (channel, match, bots allowed), the recent post ids seen per channel, the catch-up cursor, the quoted posts held until the job takes them, and the catch-up after a socket gap, one channel at a time. The hub wires it to `channelPost` and `channelCatchUp` in `src/connectors/slack/connect.ts`. |
| `job-events.ts` | The rules between an event and its job (tripwire rung 2): a refused unsafe match, the watch set and removed with its job, a post or a catch-up turned into a wake of the job's lane, the capped catch-up repeated until the channel is read, one ping per failing channel, and one `tripwire` event row per step (ids and counts only). |
| `probes.ts` | The runtime of a tripwire probe: best-effort pins of every swappable file a command names (except its `reads`, `writes` and redirect targets), and one run with a timeout, an output cap (the fingerprint still covers all output) and a refusal when a pin changed or an ignore pattern is unsafe. |
| `probe-jobs.ts` | Probe jobs (tripwire rung 1): when a probe job is due, the hub runs its command with no model (with `KAGE_JOB_ID` and a private `KAGE_JOB_STATE_DIR` that lasts between runs and goes away with the job), wakes the job only when the output changed (the wake goes out before the new state is saved), pings the job's thread on repeated failures or a refusal, and writes one `tripwire` event row per step. `scheduler.ts` calls it, and `src/runtime/tools/schedule-tools.ts` sets and tunes the jobs. |
| `shadow-swap.ts` | Self-swap on the hub's clock (ADR 0017): grades each twin from the ledgers, tells the owner once per miss, holds a twin that could never load the owner's tools its job needs (one DM), swaps a proven twin in (saves the old job, makes the twin live, then removes the old job), finishes a swap a crash cut short, and the owner's restore. `src/hub/job-events.ts` wires it. |
| `telemetry-export.ts` | The minute export of gated event rows: a cursor that starts at the newest row, at most 500 a batch, kept on a failed send, and a 410 that stops it. |
| `release.ts` | The git and gh calls of a release, and the owner hub's daily check (`kage release`, ADR 0013). |

## Add a connector

A connector touches more places than it should today. Copy `src/connectors/email.ts`, then update:

Build its `Task` with `taskAsOther()` from `src/core/gate.ts`. Use `taskAsOwner()` only when a core rule proves the owner sent it, and name that rule in the PR.

1. Its key prefix and kind in `OFF_SLACK` in `src/core/conversations.ts`. The connector type, session keys both ways, `answersInThread` and the `kage top` counts follow from it.
2. `senderOf` in `src/core/gate.ts`, if its sender is not plainly the owner or a teammate.
3. The reply type in `src/runtime/protocol.ts`, `routeReply` in `src/runtime/session-link.ts`, and the `reply` tool in `src/runtime/kage-tools.ts`.
4. `replies` in `src/hub/connectors.ts`, and its row in `OFF_SLACK_REPLIES` in `src/runtime/tools/slack-reply.ts`.
5. If it listens on a port, use `listen()` in `src/connectors/webhook.ts`: a taken port then turns off this connector, not the hub.
6. The inbox (`Inbox` in `src/runtime/store.ts`): `take` each message with a unique source id before you acknowledge it, and `handled` after. If the source does not resend by itself, add its `replay` to `replayOf` in `src/hub/connectors.ts`.
