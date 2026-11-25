# Settings

Settings live in `~/.config/kage/config.json`, and the tokens in `~/.config/kage/secrets.json` (mode 600). One schema checks both files, so a misspelled key is refused with its name. Kage watches both files. A change to `people.teammates` or `people.agents` applies at once and cuts no session. Any other key restarts Kage by itself once every session is quiet. A file with a wrong key or value is refused: Kage keeps the last good settings and DMs you the bad key. `kage config reload` checks now, and `kage config set <key> <value>` changes one key of `config.json`. `KAGE_ENV` points Kage at a different config folder (its dirname), which is how one machine runs two Kages.

A key that is absent has its default. A dotted name such as `harness.maxSessions` is a nested key: `{ "harness": { "maxSessions": 6 } }`. Keys marked "secrets.json" go in that file. A list is a JSON array, an on or off setting is `true` or `false`.

An older install had one `~/.config/kage/env` file. On its first start with this version, Kage reads it with a fixed table, writes both JSON files, and renames it to `env.imported-<time>`. It deletes that file 7 days after a clean start. A line the table does not know goes under `unknown` in `config.json` (a secret-looking one keeps its value in `secrets.json`), and Kage DMs you its name.

To list every key:

```sh
node -e "import('./core/config.ts').then(m => console.log(m.KEYS.map(k => k.path).join('\n')))"
```

## Who may change a setting

Only your own terminal runs `kage config set`: it refuses inside a Kage session. No session reads `secrets.json` or an env file, and none writes `config.json`. In your own task, a session changes a setting with `set_setting`. Limits, models, AFK, Jev thresholds (0.3 or more) and ports (1024 to 65535) apply at once. People, any `command`, a connector turned on, the browser block list, and every other `harness` key wait for your yes on a card. Tokens cannot be set that way.

## Slack and identity

| Setting | Default | Effect |
|---|---|---|
| `slack.app` | required in Socket Mode | secrets.json. The `xapp-` token for Socket Mode. `kage slack save` writes it. |
| `slack.signing` | required over HTTP | secrets.json. The app's signing secret (Basic Information > App Credentials). Over HTTP, Kage refuses every request Slack did not sign, and every request whose timestamp is more than 5 minutes from now. |
| `slack.transport` | `auto` | How Slack reaches Kage: `socket` (Socket Mode, a connection Kage opens, so it needs no public address), `http` (Slack calls Kage's `/slack` route on port 8796), or `auto`: HTTP when `slack.signing` is set and the hub has a public HTTPS route (`slack.publicUrl`, or the Slack route `kage tunnel on` opened), otherwise Socket Mode. Over HTTP, a delivery Slack retries makes one task, and Kage reads the channels it watches again at each start. |
| `slack.publicUrl` | none | The public HTTPS URL that reaches Kage's `/slack` route, when something other than `kage tunnel` serves it (a reverse proxy on a server). With `slack.signing` set, it makes `auto` take HTTP. |
| `slack.user` | required | secrets.json. The `xoxp-` token. Its owner is Kage's owner: the only person with full access. Others drive Kage only with the limits below (`people`, email, voice). |
| `slack.bot` | required | secrets.json. The `xoxb-` token Kage posts with. |
| `name` | `kage` | The word you tag (`@kage`), the tmux session name, and the label on posts. |
| `owner.channel` | `slack` | Where Kage's messages to you go: `slack` (the DM with Kage) or `whatsapp` (your own "message yourself" chat, which needs the WhatsApp bridge). If a WhatsApp send fails, or the message holds something that looks like a key, it goes to Slack instead. Each approval card also comes to WhatsApp with a code: reply `yes 4821` or `no 4821` in that chat, or answer the card in Slack, and the first answer counts. Your commands stay in the Slack DM. |
| `people.teammates` | empty | Everyone besides you who may task Kage, one entry each: `{ "user": "<Slack user id>", "email": "<address>", "trusted": true }`. An entry needs a `user`, an `email`, or both. A `user` may tag Kage in Slack. An `email` may write to Kage's address. `trusted` (only with a `user`) lets their tasks, and their agents' tasks, use your claude.ai connectors and other MCP tools. Secrets, your memory, your browser and one-way steps stay as for any teammate. Use `kage person add <person>`, with `--trusted` to trust them. |
| `people.agents` | empty | A list of agents. Each is `{ "app": "<app id>", "owner": "<owner id>", "tag": "<user id>" }`. The `tag` is the agent's own Slack user id, set when Kage knows it: Kage tags the agent with it on every part of a reply. The owner is a listed person, or a listed agent. Use `kage person add <app id> <owner>`. A tagged post from the app, made with its owner's token, counts as that person's task. It never counts as the owner's. An app id with no owner counts with any listed teammate's token. |

## Agent replies (Jev classifier)

An agent that always answers can keep a thread going with posts that ask for nothing: "done", "thanks", "posted it". With a Jev key, Kage asks [TypeSafe's Jev classifier](https://typesafe.ai) about each tagged post from a listed agent before it starts a task, and drops the post when Jev scores it as needing no reply. The loop guard (4 agent turns in a row in one thread, 20 a minute) still applies on top.

Only a listed agent's post goes to Jev, at most its first 4,000 characters, with the tag taken out. Your posts and your teammates' never do. If Jev times out (4 s) or errors, the post is answered as before. `kage logs` shows each decision as an `answering` or `dropped` line with Jev's score, never the post or the key. `kage doctor` checks the key with one fixed test sentence. A change needs `kage restart`.

| Setting | Default | Effect |
|---|---|---|
| `jevKey` | none | secrets.json. Turns Jev on. A key for `api.typesafe.ai`, kept in secrets.json only. |
| `jev.agents` | every listed agent | A list of the app ids Jev checks, or `["all"]`. Each must also be in `people.agents`. |
| `jev.threshold` | `0.5` | The needs-reply score, between 0 and 1, that a post needs to start a task. Higher drops more. |
| `jev.model` | `jev-latest` | The Jev model, such as `jev-1.14.0` to pin one. |
| `jev.ackWords` | `on` | Under a post that needs no work, Kage posts one or two words that fit it, such as "Dropped" or "Anytime": a listed agent's post Jev says needs no reply, and a person's tag Jev's triage answers with a reaction (the reaction stays too). It costs one small model call, and "Noted" stands in if that call fails. `off` leaves only a green tick on an agent's post and only the reaction on a person's tag. A session may change this one. |
| `jev.url` | `https://api.typesafe.ai/v1/systemone` | The Jev endpoint. Change it only to use another Jev host. |

## Sessions

| Setting | Default | Effect |
|---|---|---|
| `claudeToken` | your own Claude login | secrets.json. Kage's own Claude login, so its sessions use its own seat and you see its usage apart from yours. `kage login` saves it. It wins over an `ANTHROPIC_API_KEY` in the hub's environment. A session can print it, so use a login that holds nothing but Kage's work. |
| `harness.maxSessions` | `4` | Sessions that run at once. A tag over the limit gets ⏳. |
| `kagelets.max` | `10` | Kagelets that may run on this install. Past it, by name order, one runs nothing. Kage makes no new one while this many files exist, paused ones included. |
| `kagelets.ownersMax` | `3` | Owners one kagelet may have besides you. A save with more is refused. |
| `kagelets.needsPerDay` | `5` | Needs one kagelet may send Kage in a day. A need goes to Kage in the kagelet's thread, which answers it or asks you once. Past this many, or after a day with no free session there, a need goes on your waiting list instead. The same need again within a day counts once. |
| `kagelets.askRunsPerHour` | `4` | Runs that asks from people on a kagelet's `people:` line may start in an hour, per kagelet. An ask while the kagelet is busy, or past this many, waits as a note for its next run. `0` lets asks start no run. |
| `kagelets.notesKept` | `10` | Notes one kagelet keeps for its next run, per list: the owner's words and Kage's answers in one list, asks from its `people:` line in another. Past this many, the oldest goes. |
| `kagelets.noteChars` | `2000` | Characters kept of each such note. |
| `kagelets.measureMinutes` | `60` | How often Kage runs each kagelet's measure, with no model. Each run reads the latest number. |
| `kagelets.release` | `rules` | Who answers a held shell step of a `tools: all` kagelet that no `allow:` line covers. `rules`: you, each time. `shadow`: you still answer each one, and a cheap model also gives its own run or hold call on the low-stakes ones, saved next to your answer in the `card-verdicts` ledger, so you can see how often it agrees with you before you let it act (#542). `review`: that model may let a low-stakes one run (a local delete, a forced push to a branch that is not protected, a git step that drops work), but only for a kind of step where its run calls earned your agreement (the three `kagelets.review*` settings below). Every prod, customer, money or access step still comes to you. |
| `kagelets.reviewsPerDay` | `10` | At `review`, the most run calls the reviewer makes per kagelet a day: steps it lets run, and run calls on a kind it has not earned yet. A hold call does not count. Past it, they come to you. At `shadow`, the most it reviews per kagelet a day. |
| `kagelets.reviewModel` | `haiku` | The model the reviewer asks. |
| `kagelets.reviewMinVerdicts` | `20` | At `review`, the reviewer may let a kind of step run only after you answered at least this many of its run calls on that kind. Until then each of its run calls goes to your card, so your answer becomes the next piece of evidence (#542). |
| `kagelets.reviewMinAgreement` | `0.95` | At `review`, how often you must have agreed with its run calls on a kind, counted with a margin for small samples (a one-sided 95% Wilson bound). At `0.95`, 52 agreeing calls of 52 is the least that passes, one no needs about 87 calls, and `1` never passes. |
| `kagelets.reviewEvidenceDays` | `30` | When your newest answer on a kind is older than this, the kind goes back to cards by itself. A released step makes no card, so this is a spot check: the next card renews the evidence. |
| `kagelets.denyHoldDays` | `7` | When you say no to a kagelet's held step, it may not ask about that exact step again for this many days: a retry is refused with the date, with no card and no reviewer call. `0` turns holds off. In `kage top`, `h` on a kagelet lifts its holds (#542). |
| `kagelets.trendRuns` | `5` | How many past measures a run sees as its trend. |
| `kagelets.turnStallMinutes` | `20` | A kagelet run that takes no step for this many minutes is ended and counts as a failure. |
| `kagelets.incidentsPerHour` | `5` | A failed kagelet run is retried once, with a first line saying why. If the retry fails too, you get one DM with the kagelet's last words and last report, and the fix when it is a known one (a sign-in, a cost cap, a missing tool). A failure with a known fix gets no retry, and neither does a kagelet that runs only after another (`after:`). This many failures of one kagelet in an hour pause it, with one DM. At most one failure DM per kagelet per hour. A run you stopped is never counted. |
| `kagelets.dailyUsd` | none (no cap) | What one kagelet may spend in a day, in dollars. Unset, no kagelet is ever paused for cost. To turn the cap on, set a number such as `2`. `0` is a cap of $0, which pauses every kagelet: leave the line out for no cap. At the cap the kagelet is paused (its file says so), and you get a DM and a waiting line. At 80% you get one DM that day. It stays paused until you resume it, and from then it counts only what it spends after the resume. A run in progress stops at the cap. A value that is not a number of dollars leaves the cap off, and the hub log says so at start. |
| `kagelets.totalDailyUsd` | none (no cap) | What all kagelets together may spend in a day, in dollars. Unset, there is no total cap. Set, every running kagelet is paused at it, and you get one DM that day. At 80% you get one DM that day. Each kagelet counts what it spent since midnight, or since its last resume. Only you set or raise a cap: a standing approval never covers it. With or without caps, Kage watches cost: a kagelet that spends over 3 times its 7-day daily average (and over $0.50), or a run that wrote no cost row, gets one line a day in Kage's reports, which Kage's kagelet list shows. |
| `kagelets.chainUsd` | none (no cap) | What one chain of kagelets (`after:` steps and kagelet messages, started by one scheduled or person-started run) may spend, in dollars. At the cap the hub starts no further step, and the stop goes on your waiting list. A value that is not a number of dollars leaves the cap off, and the hub log says so at start. |
| `sharedTools` | none | The MCP tools a task not from you may use (a teammate's, their agent's, or an email), as name prefixes such as `mcp__slack__slack_read_`. Kage's own tools are always allowed. Any other MCP server stays yours alone, so a server you add later is closed to others until you list it. Mail, Drive, Calendar, meeting notes, your browser and every claude.ai connector (`mcp__claude_ai_`, which logs in as you) stay closed to others even when listed. On the default runner (the Agent SDK), a thread that a task not from you starts does not load your browser tools or claude.ai connectors at all. Your own message in that thread reopens its session with them, on the same conversation, after its current turn. A voice call keeps one session, so it is not reopened mid-call. Only you change it. |
| `askOtherAgents` | on | On, a session may tag another person's listed agent to ask it for work: listing that agent is the opt-in, its own Kage still decides whether to answer, and the loop guard caps the turns. `false` turns it off: the reply tools refuse such a tag, the agent is left out of the list a session reads, and a session that cannot do a task tells you instead. Your own agents, and answering an agent that tagged Kage, are never blocked. A tmux pane reads this setting and the list of agents when the pane starts. |
| `autoUpdate` | on | `false` stops Kage updating itself. On, every 6 hours the hub fetches the `stable` tag from origin, runs `git merge --ff-only` to it, and restarts into the new code once every session is quiet. It follows the tag, not the newest commit on `main`, so a merge reaches no install until the tag moves. With no `stable` tag on origin, it does not update. It does this only in a git checkout on branch `main` with no uncommitted changes and no commits the tag lacks, so a tag moved back is never followed. Anything else gets one `auto-update did nothing` line in `kage logs` with the reason. A release is a `vX.Y.Z` tag with a GitHub Release, and `stable` sits on it. The repo owner's own hub makes it by itself, checking hourly, after the commit has run on that hub for 24 hours (a change to docs or tests alone does not restart the clock) with `kage doctor` at `All good` and no crash-loop DM. `kage release` does it at once, and `kage release --dry-run` prints the version and notes and changes nothing. After an update you get a DM that names the old and new version and links to what changed. The install line makes a git checkout when git is installed, and run again it turns an older tarball install into one. Without git it installs a tarball, which updates only when you run the install line again. `kage doctor` says when an install cannot update itself, and why. Releases are not signed yet (#58). |
| `kagelets.dbRead.command` | none | The command `db_read` runs, for a kagelet you granted `db_read`. Point it at the read command this install already uses: a script that runs one query in a read-only transaction and prints the rows, one per line. Kage passes the query as the last argument, quoted, so `my-db-read --flag` runs as `my-db-read --flag '<query>'`. Kage holds no database login of its own, so a kagelet never reads more than this command can. Never create a new database login for Kage. Unset, a kagelet's `db_read` uses a read command you approved on a card before tiers (kept in `kage.db`, also after you remove the kagelet that brought it), and with none kept a kagelet gets no `db_read`. Set, this one wins. |
| `kagelets.dbRead.maxRows` | `200` | The most rows one `db_read` query returns. Kage wraps the query as `select * from (<query>) limit <rows>`. |
| `harness.idleMinutes` | `30` | A quiet session closes after this long. Its next tag resumes it. |
| `harness.jobModel` | the sessions' own default | The model a scheduled run uses. Each schedule runs in its own lane beside its thread, so a run never replays the thread's history. Unset, a run keeps the model every session uses, so a job only moves to a smaller model when you or Kage choose it. A schedule may also name its own model (the `schedule` tool's `model`, such as `haiku` for a job that only checks and reports), which comes first. `kage schedule list` shows it. A teammate's task may only pick `haiku`. A twin that swaps in keeps its own model. A session may change this one. |
| `harness.jobFreshEvery` | `20` | After this many runs on one schedule's lane, the next run starts a new session, so a job's own history stays small. `0` always resumes. A session may change this one. |
| `harness.jobCarry` | `5` | When a lane starts a new session, its first task quotes the text of this many of the job's latest posts, read from the old session's own transcript (their place, when that transcript is gone), so the job does not report the same thing twice. `0` lists none. A session may change this one. |
| `harness.jobCarryChars` | `500` | The most characters kept of each post a new lane session is told about. A session may change this one. |
| `harness.rotateTokens` | `200000` | When a thread's last turn read this many tokens of context or more, its next task starts a new session. That task holds the whole thread, the old transcript's path, and Kage's last posts in it (`harness.jobCarry` of them, each cut to `harness.jobCarryChars`), so a long thread stops re-reading its full history on every turn. A busy session is never cut. Side lanes keep their session. `0` never rotates. A session may change this one. |
| `harness.commandOutputChars` | `3000` | A shell command whose output runs longer than twice this many bytes shows a session only its first and last this many, with one line between them that names the file holding all of it. A failed command's error, which comes last, stays in view, and long output stops riding along in every later step. The first part shows live, and a command that keeps printing past it says where its output is being saved. Output that fits shows whole. MCP servers and hooks run untouched. `0` turns it off. Agent SDK sessions only. If the hub's environment already sets `CLAUDE_CODE_SHELL_PREFIX`, that one is kept and this does nothing. |
| `harness.sandbox` | `teammates` | Runs a session's shell in the OS sandbox, where it cannot read the token files or write Kage's settings, code or start files. `teammates` walls every thread a teammate or an agent started, and leaves your own threads free. A thread you write in later reopens unwalled, and a teammate who writes in a thread you started works in your unwalled session, with a teammate's tools. `true` walls every thread, yours too. `false` walls none: the token files and settings then stay closed to the file tools, and a hook refuses a shell command that names the config folder, but a reworded command gets past the hook. The sandbox needs `/usr/bin/sandbox-exec` on macOS, or `bubblewrap` and `socat` on Linux; without them a walled thread cannot start, and `kage doctor` names the fix. tmux panes do not know who started a thread, so there only `true` walls them. |
| `harness.jobLaneDefault` | `on` | A new schedule runs in its own lane, so a run never replays the thread's history. `off` runs new schedules in the thread. The `schedule` tool's `lane` argument sets one schedule either way. A schedule made before lanes keeps running in its thread. A session may change this one. |
| `harness.jobCatchUpHours` | `12` | A clock run that came due while Kage was off (the Mac asleep, the hub stopped) still runs once when Kage is back, if it is at most this many hours late. Only the newest missed run goes in, and its first line says when it was due and how many runs were missed. A run only minutes behind, such as one that waited for a busy thread, is not marked late. An older one runs nothing, and `kage logs` shows one `missed` line with the count. `0` runs only what is at most 10 minutes late. A session may change this one. |
| `harness.jobCatchUpStaggerSeconds` | `15` | Late runs found at the same moment start at least this many seconds apart (in practice one per 20-second tick), so a wake does not start every job at once. A session may change this one. |
| `harness.leanSessions` | `on` | A thread you did not start (a teammate's, an agent's or a kagelet's) skips your own Claude Code setup: your `~/.claude/CLAUDE.md`, skills, plugins, hooks and permission rules. It keeps your model and effort, and a kagelet still gets each MCP server from `~/.claude.json` that its grant names. A trusted teammate's thread and your own keep everything. This saves about 14,000 tokens on every turn of those threads. `off` gives every thread your whole setup, as before. |
| `harness.pluginsOff` | none | Claude Code plugins to turn off in Kage sessions only, by their `name@marketplace` id, for example `["cache-tax@claude-code-mods"]`. Use it for a plugin made for your own terminal, such as one that holds back a message until you send it again: nobody is there to send it again in a Kage session. Your own Claude Code keeps the plugin. If a hook still stops a task before it runs, Kage says so in the thread, or DMs you once per thread when nobody is there to read it. With `harness.runtime` set to SDK only. |
| `harness.runtime` | SDK | `tmux` runs each thread as a Claude Code pane instead of an Agent SDK session in the hub. |
| `harness.route` | `dev` | With `harness.runtime` set to `tmux` only. `plugin` starts panes with no warning screen, once your org approves the channel. |
| `harness.cwd` | your home folder | The folder sessions start in. |
| `harness.memory` | `~/.config/kage/memory` | Kage's own memory folder. |
| `harness.ownerMemory` | your Claude Code memory for the home folder | The memory Kage reads, and where it may write notes about people (`user_*.md`) only. |

## ssh to hosts behind AWS SSM

With `harness.sandbox` on, a session's shell runs in an OS sandbox. `aws ssm start-session` makes its API call through the sandbox's proxy, then starts `session-manager-plugin`, which opens its own websocket and ignores that proxy. So it hangs inside a session. Kage fixes this for every host, account and region with no setup: whatever `ssh` does in your terminal also works in an owner thread, and `~/.ssh/config` needs nothing from Kage.

Only a Slack session you have written in gets a relay token (`KAGE_SSM_TOKEN`), the socket path (`KAGE_SSM_SOCK`) and a PATH that starts with Kage's own folder `src/cli/ssm-plugin-shim`. That folder holds a stand-in `session-manager-plugin`. The aws CLI runs it, and it sends aws's arguments to the hub over a unix socket (`ssm.sock` in the config folder, mode 600). A session only teammates or agents have written in gets none, unless its thread is on the `kage relay allow` list below. Email, WhatsApp, voice and kagelet sessions get none either. The hub refuses them.

The hub then runs the real `session-manager-plugin` outside the sandbox with exactly those arguments, and passes the bytes both ways. It runs only a `StartSession` call whose stream URL is `wss://ssmmessages.<region>.amazonaws.com` (or the `.com.cn` host) and whose endpoint is `https://ssm.<region>.amazonaws.com`. It allows 8 relays at once. It logs the region, the instance id and the exit of each, never the token, the stream URL or the traffic. The hub finds the real plugin once at start in its own PATH, so install it where the hub's PATH sees it. `kage doctor` notes when it is missing. The stand-in needs `node` on the session's PATH.

Your own message opens the relay in any Slack thread, a teammate's included. While a turn runs for you alone, the hub lets its relays through. Once a teammate's message joins that turn, the hub refuses the next relay, and a relay already open runs to the end of the turn. When the turn ends, the hub cuts every relay that turn opened, so a tunnel left in the background never reaches a teammate's later turn. A turn that carries a teammate's message runs at their trust and gets no relay. To let a thread use the relay on a teammate's turns too, run `kage relay allow <place or key>` in your own terminal. `kage relay deny <same>` removes it and cuts its live token, and `kage relay list` shows the keys. The list holds thread keys. A listed thread's scheduled jobs, which run in their own job lanes, use the relay too. A kagelet, any other lane of the thread and every non-Slack session stay refused. The hub checks the list again on every connection. A session that is already running keeps its old env: it gets the token at its next start.

## Database reads by named route

A read of your database needs no SSM relay. Name each database in `config.json` under `dbRead.routes`, with your read command as its value:

```json
{ "dbRead": { "routes": { "prod": "/path/to/prod-read" }, "maxRows": 200 } }
```

`dbRead.routes` names each route (lowercase letters, digits and `-`, up to 31 characters) and the command that reads that database. Each command is like `kagelets.dbRead.command`: it runs one query and prints the rows, with the query as its last argument. With a route named, every Slack session gets `db_read` with a `db` argument. The session sees the route names and never the commands. Only you set routes: a session's change needs your yes on a card. `dbRead.maxRows` (default `200`) is the most rows one routed read returns.

Name only a command that connects as a read-only database role. The role is the wall: Kage refuses anything but one `SELECT` or `WITH ... SELECT` statement, caps the rows and stops a read after 30 s, but it does not read functions, so a role that can write can still write.

Who reads a route:

| Asker | Reads |
|---|---|
| You, in any thread | Every route. |
| A teammate, with `trust.mode` set to `on` | A route only when you said yes to it for that teammate (a live `prod-read` line whose reach is the route name). With no line, `db_read` refuses and tells the session to post an ask. Your plain yes saves the line, and the next read goes through. `kage trust revoke <id>` takes it back. |
| A teammate, with `trust.mode` at `shadow` or `off` | Nothing, unless you answer in the thread: a read runs only in a turn that you started. Shadow logs what `on` would have done. |
| A meeting, a GitHub tag from outside the repo, any listed agent, a text, a call, an email, a WhatsApp chat | Nothing. |
| A kagelet | Nothing here. It reads through `kagelets.dbRead.command` and its own grant. |

Each read writes one `db-reads` row: who (your own thread shows `owner`), the route, a hash of the query, the row count, the time and the outcome. It never holds the query or the rows. A read that a line covered also writes a `trust-steps` row, which the daily receipt lists. A failed read shows the session only the database's own `ERROR`, `DETAIL`, `HINT` and `LINE` lines, so a connection error never leaks a host.

## Keys that stay out of sessions

A key in `session.env` reaches every session as a plain environment variable, so a session can print it. To keep a key out, name it in `config.json` under `sessionKeys` and keep its value in `session.env`, then run `kage restart`. The hub holds the value in memory and removes it from the environment before any session starts.

```json
{ "sessionKeys": { "EXAMPLE_API_KEY": { "host": "api.example.com", "header": "x-api-key", "prefix": "" } } }
```

`host` is one host name, with no port or path. `header` defaults to `authorization` and `prefix` to `Bearer `. A session reaches the key through the hub's socket, with the token in its env:

```sh
curl --unix-socket "$KAGE_KEYS_SOCK" "http://kage/$KAGE_KEYS_TOKEN/api.example.com/v1/things"
```

The hub fetches `https://api.example.com/v1/things` and adds the key in the header. A request for any other host gets a 403 and no key. The hub does not follow redirects, so a key never leaves its host. Who gets a token follows the SSM relay: your own turns in any Slack thread, and a thread run with `kage relay allow`. `kage doctor` lists each key by name, host and header, never its value. A tool that reads the key from an environment variable no longer finds it, and a tmux pane has no proxy token, so panes lose these keys too.

## Tokens from a password manager

Any token in `secrets.json` may name a command instead of holding the value, the way Claude Code's `apiKeyHelper` does. Kage runs the command and uses what it prints, so the token can stay in 1Password, pass or the macOS Keychain:

```json
{ "slack": { "bot": { "command": "op read op://kage/slack-bot" } }, "jevKey": { "command": "security find-generic-password -w -s kage-jev" } }
```

- Kage runs a command with `/bin/sh` only when it needs that token, at most once per process, and keeps the output in memory only. The hub runs them at start. `kage doctor` runs them to check them, the Slack tokens and `jevKey` twice, so a password manager may ask more than once. It never writes the output to disk, a log or a session's environment. `claudeToken` is the one exception: it reaches every session as its Claude login, as a plain value does.
- If a command fails, times out after 30 seconds or prints nothing, the token is unset until the next start. The hub log and `kage doctor` name the token and the command, never what the command printed. Run the command in a terminal to see why, fix it, then run `kage restart`.
- A command that writes one token, such as `kage connector on browser`, keeps every other token as it is, commands included. `kage slack save` writes all three Slack tokens, so it replaces their commands with the values you paste.
- While any token names a command, no session may run that command or a secret helper: `op read`, `op inject`, `op run`, `op item`, `op document`, `security find-*-password`, `security dump-keychain`, `pass show`, `pass otp`, `pass <name>/...`, `gopass`, `lpass show`, `secret-tool lookup` and `bw get`. This includes your own threads. Kage looks only where a command starts (a new line, after `;`, `|`, `&` or `$(`, or inside `sh -c` and `eval`), so a commit message or a search that mentions `op read` still runs. It is a word check behind the sandbox, so `secrets.json` (mode 600) stays the safer default: the sandbox closes that file to every session.
- `waha` keys stay plain values, because Kage writes them into `waha/.env` for the WhatsApp container.

## The nightly dream

Each night, while every session is quiet, Kage reads the day's threads for lessons. It sends each lesson to the hub with quotes from the threads that show it. The hub keeps a lesson only when it passes the checks below, writes it into Kage's memory, and logs each lesson it drops, with the reason, in `.dream-ledger.tsv` in that folder. Threads run as tmux panes skip the check, and the dream writes its own notes.

| Setting | Default | Effect |
|---|---|---|
| `dream.minChats` | `2` | A lesson needs exact quotes from at least this many different threads. One thread is not a pattern. |
| `dream.minConfidence` | `0.7` | A lesson the dream rates below this confidence, from 0 to 1, is dropped. |
| `dream.maxNew` | `6` | The most new lessons kept in one night, the most confident first. |
| `dream.maxOutdated` | `5` | The most notes retired in one night. A retired note is copied to `.archive/` and taken out of the index. |

## Reports to the Kage repo

A session can file a bug, an idea or feedback about Kage itself to the GitHub repo of this Kage checkout, the `origin` remote, so a fork files to the fork. Kage removes the names of people it knows, the words in `report.redact`, Slack ids, mentions, channel names, links, emails, phone numbers, home paths, tokens, addresses, hostnames and quotes first, and refuses a body over 2,000 characters so the card shows all of it. Then you get a card with the exact title and body, and nothing is sent without your yes. A teammate's task asks you the same way, and an agent's task never files. If `gh` is signed in, Kage files the issue and posts its link. If not, it posts a prefilled link that you open and submit.

If an open issue already has the same fingerprint, the card offers one `seen again on <version> <system>` comment on that issue instead of a new one. The fingerprint is a crash's fingerprint when the session has one, or else a hash of the kind and the title's words. Only the fingerprint goes to GitHub for that search, before the card. The match is best effort: GitHub search takes a moment to see a new issue, so two reports a few seconds apart can still open two.

| Setting | Default | Effect |
|---|---|---|
| `report.enabled` | `true` | `false` removes the tool from every session. |
| `report.perDay` | `3` | The most filings and seen again comments a day. One you said no to does not count. |
| `report.repo` | origin of the checkout | The repo to file to, as `owner/name`. |
| `report.failureRepeats` | `3` | When one kind of failure happens this many times in a day (a failed hub job, the meeting bot losing the hub, a failed probe, a failed tool step), the hourly check DMs you once that day with the count. |
| `report.redact` | none | Words and phrases to take out of every report, such as customer and company names, which Kage cannot tell apart from other words. Each phrase comes out whole and becomes `[name]`. Set it as a JSON list: `kage config set report.redact '["Acme Corp","Bank of America"]'`. |

## Questions waiting on you

| Setting | Default | Effect |
|---|---|---|
| `waiting.expireHours` | `72` | A question that waited this long with no answer is dropped. The next daily note names it once under "Dropped", and a reply in its thread opens it again. |

## Trust record

Kage keeps each yes you give a teammate, so it stops asking the same thing again. A line holds one teammate, one kind of step and one reach. A reach has one form, so a reworded ask still meets its line: a site is its host in lowercase, a repo is `host/owner/name` in lowercase (a bare `owner/name` means GitHub), and a database read is a route name from `dbRead.routes`. An ask for a route that is not set is refused. Only your own typed words write a line. `kage trust list` shows the lines, and `kage trust revoke <id>` takes one back. Money, deletes, sends to people outside the team, production deploys and writes, a production shell, the SSM relay, secrets, product calls and the owner-only shell kinds always ask, and one yes covers the whole job.

| Setting | Default | Effect |
|---|---|---|
| `trust.mode` | `shadow` | `shadow` skips no ask. It writes your lines, shows each typed ask with the line a yes will save, and logs what Kage would have done next to your real answer. `on` skips an ask that a line covers and folds the same open ask into one. A no line stops the step. `off` does nothing. |

## AFK mode

| Setting | Default | Effect |
|---|---|---|
| `afk.on` | on | `false` turns AFK mode off. On, tell Kage you are stepping away in any words ("cover for me, lunch for an hour"). It watches threads that mention or DM you and stays quiet unless you are mentioned again or it is urgent. A P0 phones you through `connectors.call.command`. Say you are back in any words for the summary. Threads run as tmux panes cannot switch it yet. |
| `afk.model` | `sonnet` | The model the stand-in uses. |

## Screen

How Kage sees and acts on your Mac (the `computer_look`, `computer_act` and `computer_record` tools, macOS only).

| Setting | Default | Effect |
|---|---|---|
| `screen.lookElements` | `60` | The most elements one `computer_look` lists. Text fields come first, then controls, then text. A look with `find` keeps only matching elements, so a big window still fits. |
| `screen.shotLongSide` | `1280` | The longest side, in pixels, of a picture `computer_look` takes of your Mac. The model sees a larger picture shrunk, and aims worse on it, so Kage keeps pictures this size and maps each `computer_act` point back to the screen. |

## Kage top

What `kage top` shows.

| Setting | Default | Effect |
|---|---|---|
| `top.threadCostBar` | `5` | Dollars. A thread that cost this much or more today shows its cost in the warning color in `kage top`. |

## Telemetry

Counts and failure codes from this install, sent to an OpenTelemetry (OTLP) endpoint so the people who build Kage see what breaks. Message text, prompts, replies and tool input are never sent. Kage's own records hold no names, ids or paths. Claude Code's records also carry the signed-in account's email and ids, and the Kage receiver drops them before storing (ADR 0019). `kage telemetry` says whether it is on, and `kage telemetry show` prints the exact next batch.

| Setting | Default | Effect |
|---|---|---|
| `telemetry.endpoint` | `https://monitor.omnidim.io/kage` | The OTLP/HTTP base URL: the Kage team's receiver, which keeps only counts and codes. Point it at your own collector to keep the data yourself. Kage posts to `<endpoint>/v1/logs`, and each session's Claude Code sends its own logs there too. |
| `telemetry.on` | on | You get one DM before anything is sent. `false` sends nothing. `KAGE_TELEMETRY=off` or `DO_NOT_TRACK=1` in the hub's environment does the same. |

## Reach Kage from other machines

One tunnel serves every Kage port another machine needs (#492). Public routes use port 8443, which Kage keeps to itself: Funnel publishes a whole port, so `kage tunnel on` refuses while something Kage did not make is served there, and it never touches your other ports. `kage tunnel on` opens a route for each connector that is on, and closes the route of each one that is off. `kage tunnel off` closes them all. `kage doctor` shows each route. It needs [Tailscale](https://tailscale.com/download) running on this machine. A public route also needs Funnel allowed for this machine in the Tailscale admin page, once.

| Route | Who calls it | Reach |
|---|---|---|
| github | the Kage GitHub App's webhook, once `kage connector on github` made the app | public at `https://<machine>.<tailnet>.ts.net:8443/github` |
| voice | the voice agent, when `voiceToken` is set | public at `/mcp` and `/voice` |
| hooks | job webhooks, when `tripwires.hookPort` is set | public at `/hook/<job>` |
| meeting | the meeting bot, when `meetingToken` is set | your tailnet only, at `<machine>.<tailnet>.ts.net:<port>` |
| slack | Slack, when `slack.signing` is set and `slack.transport` is not `socket` | public at `/slack` |

Each public route still checks its own secret or token, so the URL alone lets nobody in.

| Setting | Default | What it does |
|---|---|---|
| `tunnel.provider` | `off` | `tailscale` once `kage tunnel on` ran, and `off` again after `kage tunnel off`. `kage doctor` checks the routes only while it is `tailscale`. |
| `tunnel.targets` | none | Set by `kage tunnel`: each local address a path on port 8443 points at that Kage made. Kage closes or changes only these, so a handler you made there is never touched. Do not edit it. |

## Tripwires

A tripwire runs a shell command on a clock and wakes a session only when the command's output changes. The first good run records the baseline and wakes nothing. A command that edits itself, or a file it names that you could change, is refused when that file changes, until you approve it again. Pinning is best effort: the approval card lists the files a probe reads as data, and those are the only files whose change does not stop it.

| Setting | Default | Effect |
|---|---|---|
| `tripwires.on` | on | `false` turns every tripwire off. A probe job then runs as a plain clock run: a model polls on its schedule, so nothing goes silent. |
| `tripwires.timeoutSec` | `60` | A command that runs longer is killed, with its child processes. |
| `tripwires.maxKb` | `64` | Output text past this size is cut and marked as truncated. A change in the cut part still wakes the session. |
| `tripwires.failPing` | `3` | After this many failed runs in a row, you get one note. The tripwire keeps running. |
| `tripwires.env` | `["PATH","HOME","LANG","USER","TMPDIR","SSH_AUTH_SOCK"]` | The variables of Kage's environment that a probe sees. Nothing else passes, so a probe never gets a token. A name that is not set is skipped. Add a name only when a probe needs it: it widens what a probe can read, so a session needs your yes to change it. |
| `tripwires.patternMax` | `200` | The longest `ignore` pattern a probe may have. A longer one, an invalid one, or one with a nested repeat such as `(a+)+` is refused when the probe is made. |
| `tripwires.lineMax` | `2000` | An output line longer than this is never dropped by an `ignore` pattern. |
| `tripwires.maxPosts` | `20` | The most channel posts a job that watches a Slack channel keeps until it runs. The oldest go first. |
| `tripwires.catchUpMax` | `1000` | The most posts Kage reads per watched channel in one catch-up after the Slack socket was down. It reads the oldest missed posts first, so a bigger backlog only waits for the next catch-up: no post is skipped. |
| `tripwires.seenMax` | `500` | How many recent post ids Kage remembers per watched channel, so a post that arrives twice wakes a job once. |
| `tripwires.hookPort` | `0` | The port of the webhook that wakes a job (`POST /hook/<job id>` with the job's bearer token). `0` leaves the server off. Any other value must be from 1024 to 65535. |
| `tripwires.hookHost` | `127.0.0.1` | Where the job webhook listens. Reach it through a tunnel, and keep the port off the internet unless the tunnel is the only way in. |
| `tripwires.hookPerHour` | `60` | The most calls per hour one job's webhook accepts. Past it, the webhook answers 429. |
| `tripwires.swapAfter` | `3` | A twin job swaps in by itself once it agrees with the job it shadows on this many real events, with no miss (ADR 0017). |
| `tripwires.shadowWindowMin` | `30` | How many minutes apart the old job's act and the twin's verdict may be and still pair. |
| `tripwires.swapUndoDays` | `7` | How long a swapped-out job is kept, so "undo the swap" can bring it back. |

## Email

Email is on when `connectors.email.address`, `connectors.email.queue` and `connectors.email.ownerEmail` are set, unless `connectors.email.on` is `false`. It also needs the AWS keys.

| Setting | Default | Effect |
|---|---|---|
| `connectors.email.address` | none | The address people write to. |
| `connectors.email.queue` | none | The SQS queue that receives that address's mail. |
| `connectors.email.ownerEmail` | none | Your address. Its domain is the only one Kage replies to. |
| `aws.accessKeyId`, `aws.secretAccessKey` | none | secrets.json. AWS keys for SQS and SES. |
| `connectors.email.region` | `us-west-1` | Their region. |
| `connectors.email.on` | on | `false` is the kill switch. |

## Voice and calls

| Setting | Default | Effect |
|---|---|---|
| `voiceToken` | none | secrets.json. Turns voice on: an MCP endpoint with one tool, `ask_kage`, behind `Authorization: Bearer <token>`. |
| Hang-up webhook | same voice port | Send `POST /voice/ended` with the same Bearer `voiceToken` and JSON with `call_id` or `session_id` set to the MCP session id (or pass the `mcp-session-id` header) when the caller hangs up. Ends that call at once. Unknown or repeated ids do nothing and return 204; a bad token gets 401. |
| `connectors.github.app.id` | none | Your Kage GitHub App's id. `kage connector on github` sets it when you create the app. With `githubAppKey`, `githubSecret`, `connectors.github.app.slug`, `connectors.github.login` and `connectors.github.userId`, it turns GitHub on: a tag of `@<slug>` in an issue, a pull request, a review or an inline comment wakes Kage, and nothing else does. |
| `connectors.github.app.slug` | none | The app's name on GitHub, the one people tag. `kage connector on github` sets it. |
| `githubAppKey` | none | secrets.json. The app's private key. Kage signs short-lived tokens with it to list the app's installations. `kage connector on github` saves it, and it never leaves this machine. |
| `githubSecret` | none | secrets.json. The app's webhook secret. Every delivery is checked against it. `kage connector on github` saves it. |
| `connectors.github.login` | none | Your GitHub username. The app is named for it, and it is the first account Kage acts on. |
| `connectors.github.userId` | none | Your GitHub user id, the number that stays when a name changes. `kage connector on github` saves it. A tag from this user runs as you, and every write still waits for your yes on a card. A tag from anyone else GitHub lists as owner, member or collaborator on the repo may only read and answer. Anyone else is ignored. |
| `connectors.github.accounts` | your login | The GitHub accounts (you and your orgs) whose installations of the app Kage acts on. An install on any other account is ignored, and its events are dropped. `kage connector on github --org <name>` adds an org. |
| `connectors.github.port` | `8789` | The local port the GitHub webhook listens on. Only the webhook uses it. |
| `connectors.github.perHour` | `20` | At most this many GitHub events start work in an hour; past it, you get one note and the rest are skipped until the hour is up. |
| `meetingToken` | none | secrets.json. Turns meeting notes on: a webhook at `127.0.0.1:<port>/meeting` behind `Authorization: Bearer <token>`. Post a finished transcript as JSON: `{"title", "link", "segments": [{"speaker", "text", "start"}]}`, the shape Vexa's `GET /transcripts/...` returns. Each meeting gets a thread in your DM with Kage: notes, decisions, owners, open questions, and follow-ups Kage does only after your yes. |
| `connectors.meeting.port` | `8790` | The local port the meeting webhook listens on. |
| `connectors.meeting.perHour` | `10` | At most this many transcripts start work in an hour. |
| Kage's meeting bot | none | Uses `meetingToken` and the same port. The bot long-polls `/meetbot/next` for a join and posts caption lines to `/meetbot/segments`. A line that says Kage's name starts one session for the call at the voice-call limits, one question at a time, and the bot speaks the reply. When the call ends, the bot posts the transcript to `/meeting`, and the notes start as above. Your own Slack task sends it into a call: `@kage join https://meet.google.com/abc-defg-hij`. Teammates, agents, voice callers and kagelets cannot. Setup and the bot's own settings: [meetbot/README.md](../meetbot/README.md). |
| `voiceAgentKey` | none | secrets.json. The API key for `connectors.meeting.agent`. |
| `connectors.meeting.agentApi`, `connectors.meeting.agentId` | none | A voice agent platform (its API base URL) and one of its agents: the agent hears and speaks for Kage in a Meet, and asks Kage through `ask_kage`. Everyone in a Meet hears the answers and may speak, so a Meet call gets the voice-call limits, never your access, even when you sent Kage in. With none, the bot reads captions and answers in the Meet chat, or through the bot's `speak` command (meetbot/README.md). |
| `browserToken` | none | secrets.json. Turns Kage in Chrome on: your own tasks can list your open tabs, read one, capture the front tab, and act in a tab (click, type, press a key, go to an address, open a tab in a Kage tab group). Steps run on their own, sending and posting as you included. Only a step that cannot be undone (paying or ordering, deleting, emptying a trash, terminating, granting or revoking access, closing or leaving an account, merging or deploying, decided from the control's label) waits for your yes on a card in your DM with Kage, which names the site and the control as the page labels it, with a screenshot of the control. Kage opens its tabs in front in your current window, in a Kage tab group. `kage connector on browser` sets it, pairs every Chromium browser it finds (Chrome, Brave, Edge, Arc, Chromium, Vivaldi) so the extension fetches the token itself, and opens `chrome://extensions` and a Finder window with the `extension` folder highlighted, so the steps left are Developer mode and a drag of that folder onto the page. It prints the token only with `--show-token`: paste it in the Kage toolbar icon of a browser it did not pair. `kage doctor` says whether the extension is connected. Teammates, agents, voice callers and kagelets never reach your browser. |
| `connectors.browser.port` | `8791` | The local port the extension connects to. |
| `connectors.browser.block` | none | A list of sites Kage never reads (`["bank.example.com", "1password.com"]`). A site also blocks its subdomains. Pages that are not http or https are never read. |
| `connectors.voice.port` | `8787` | It listens on `127.0.0.1:<port>/mcp`. Put a tunnel in front of it. |
| `connectors.voice.max` | `1` | Calls at a time. A call never takes a slot from your threads. |
| `connectors.voice.perHour` | `20` | New calls per hour. |
| `connectors.voice.model` | none | The model a call's session uses, such as `sonnet` or `haiku` for faster spoken answers. With none, calls use the same model as your threads. |
| `connectors.voice.on` | on | `false` turns voice off. |
| `connectors.call.command` | none | The command `kage call` and an AFK P0 run to phone you. It gets a one-time code in `$KAGE_CALL_CODE`, and for a P0 the reason in `$KAGE_CALL_REASON`. |

## Approve pull requests as the GitHub App

Kage can approve your team's pull requests as its GitHub App, so a branch that requires a review unblocks without a second paid seat. People still merge, except a pull request a `merge` rule covers, such as a bot's release. Turn it on with `"connectors": { "github": { "approve": {} } }` in `config.json`. Kage's own settings hold no rules. The rules live in a policy file, the way Palantir's policy-bot keeps them:

```json
{
  "people": ["<login>", "<login>"],
  "rules": [
    { "name": "Release pull requests", "author": ["github-actions[bot]"], "branch": ["release-please--*"], "onlyFiles": ["CHANGELOG.md", ".release-please-manifest.json", "package.json"], "then": "merge" },
    { "name": "Other bot pull requests", "author": ["github-actions[bot]"], "then": "person" },
    { "name": "Releases", "targets": ["Production"], "then": "person" },
    { "name": "High-risk paths", "anyFile": ["**/migrations/**", "**/*payment*/**"], "then": "person" },
    { "name": "Big changes", "moreLinesThan": 2000, "then": "person" },
    { "name": "Everything else", "then": "approve" }
  ]
}
```

For each pull request, Kage reads `.github/kage-approve.json` from the repo at the pull request's target branch. With no such file, it reads `kage-approve.json` from the org's policy repo (`connectors.github.approve.policyRepo`, `.github` by default; keep it private if the names in it are). A pull request cannot change the rules it is judged by. With neither file, Kage approves nothing there. A broken file approves nothing and DMs you once. The first shape, `{ "authors": [...], "needsPerson": [...] }`, still reads as `people`, a high-risk rule and a catch-all.

Kage judges a pull request in this order:

1. Its author is in `people`. Otherwise Kage leaves it alone: no approval, no check, no message.
2. It is open, not a draft, not from a fork, has no `hold` label, and its base branch is protected.
3. Every push to its branch since the branch was made, a pull request merged into it included, came from someone in `people`, read from GitHub's push history. Commit authors do not count, because a commit can name anyone. When the history does not show the head commit yet, Kage waits.
4. No policy file changed, and it has at most 3000 files.
5. The first rule whose conditions all hold decides. `targets` matches the base branch, `anyFile` matches any changed file or the old name of a moved one, and `moreLinesThan` counts added plus deleted lines. `author` lists logins (any case), `branch` matches the pull request's own branch, and `onlyFiles` holds only when every changed file matches it. A rule with no conditions always holds. `then` is `approve`, `merge` or `person`. With no matching rule, Kage approves nothing.
6. For `approve` and `merge`, every check the base branch requires passed on the head commit, whether branch protection or a ruleset requires it. Checks the branch does not require are ignored, so a branch with no required checks gets its approval, and its merge, before CI ends.
7. For `merge`, Kage approves and then merges the head commit it judged, by squash when the repo allows it, else a merge commit, else rebase. The merge comes from the app, so workflows that run on a push to the base branch (a release tag, a deploy) still run. When GitHub refuses the merge, you get one DM with the reason and the link. The app needs Contents: Read and write, which approving already needs.

Globs match case-sensitively, and a folder whose name starts with a dot counts like any other. A `person` verdict gets you one DM per commit. The approval names the policy file and the rule, and holds for that commit only. When a verdict on the head is anything but approve or waiting, Kage dismisses its own approvals, so GitHub blocks the merge again. Converting the pull request to a draft, or adding the `hold` label, is the way to stop it.

When GitHub answers a 5xx or cannot be reached, Kage tells you nothing and checks that pull request again after 1, 5 and 15 minutes. New events for it wait for that retry, so an outage costs GitHub no extra calls. If the last retry still fails, you get one DM for the whole outage, naming the pull requests not approved. A 4xx still reaches you at once, because a retry cannot fix it.

### Read the verdict from an agent

Every pull request Kage judges gets a `Kage policy` check on its head commit, and agents read it like any other check (`gh pr checks`, or `gh api repos/<owner>/<repo>/commits/<sha>/check-runs`). The check passes when Kage approved, runs while required checks run, and ends neutral otherwise, so it never blocks a merge by itself. Its text holds the verdict as JSON:

```json
{ "verdict": "person", "code": "rule", "rule": "High-risk paths", "commit": "<sha>", "why": "Rule \"High-risk paths\" asks for a person: it changes db/migrations/1.sql.", "fix": "A person other than the author approves it on GitHub.", "policy": "<org>/<repo> kage-approve.json" }
```

Each `verdict` comes with one of these `code` values:

- `approve`: `approved`. Kage approved the head commit.
- `wait`: `checks-pending` or `push-history-behind`. A required check has not finished, or GitHub has not logged the last push yet.
- `stop`: `checks-failed`, `draft`, `fork`, `base-unprotected` or `no-rule`. Kage will not approve until the `fix` is done.
- `person`: `rule`, `hold`, `pusher-not-listed`, `pushes-unseen`, `policy-change` or `too-many-files`. A person reviews it.

### Pull requests already open

Kage checks every open pull request on each installation when the hub starts, every hour, and as soon as it reads a changed policy file. This round never approves anything. It judges again only the pull requests Kage approved, and drops an approval that no longer holds: an outside push, a check that failed while Kage was down, a draft, or a new rule that asks for a person. New approvals come only from a push or a finished check on the pull request itself. So a pull request whose events Kage missed waits for its next push or check. The pull requests one round sends to a person come to you as one DM.

### Permissions

The app needs more access than `kage connector on github` gives it: Contents set to Read and write (GitHub counts an approval only from an account that can write, and the push history needs Contents), Checks set to Read and write (for the `Kage policy` check), Commit statuses set to Read, and the Check suite and Status events. Change them on the app's settings page, then accept them on each installation. Without Checks write, Kage still approves and DMs you once that the check is missing.

## Fix your stuck pull requests

`connectors.github.fix.mode` is `off` by default. Set to `on`, Kage starts a fix when one of your own pull requests cannot move:

- A check suite fails or times out on the pull request's head commit.
- A person the repo lists as owner, member or collaborator asks for changes in a review. A review from anyone else starts nothing.

Kage starts nothing for a draft, a fork, a closed pull request, one with the `hold` label, or one somebody else opened. A failure on a commit the branch has moved past is ignored. Each commit gets one fix per reason, and each pull request gets `connectors.github.fix.perPr` fixes in all (3 by default), and closing it clears the count. After that Kage tells you once and stops.

The fix runs as your own task, in that pull request's thread in your DM. The session may push to the pull request's branch without asking. It never merges, never force-pushes and never pushes to another branch. A review's text reaches it as quoted data, cut to 2,000 characters, not as instructions. A fix that could not start, because the hourly cap was full or the session failed to start, uses up no try and starts on the next event for that commit.

Kage waits `connectors.github.fix.graceMinutes` (20 by default) before it starts a fix, so a session that is already working on the pull request gets there first. After the wait it starts the fix only if that commit is still the head and, for failed checks, a check suite on it is still red, or, for a review, that reviewer still asks for changes. A fix the hourly cap or a failed start held back is tried again each minute, for an hour. A push, a green rerun or closing the pull request during the wait ends it. Set `0` to start at once.

Start with `kage config set connectors.github.fix.mode shadow`. Kage then starts nothing and waits the same way and writes one line per fix it would have started: `kage logs | grep "github fix"`. Set `on` when those lines match what you would want fixed.

The app needs the Check suite and Pull request review events, the same ones approving uses.

## WhatsApp

**Ban risk first:** WhatsApp's terms do not allow unofficial clients, so the number you link can be banned. Use it at your own risk, and link only a number you can afford to lose.

WhatsApp runs through [WAHA](https://github.com/devlikeapro/waha), an unofficial WhatsApp Web bridge linked to your own number. The bridge runs in Docker from the files in `waha/` in the Kage folder.

When it is on, you type `@kage <task>` in any chat to hand Kage a task. The chat is also armed for an hour: a stand-in answers new messages there as you, until you type in the chat yourself. A guard reads every message before it leaves, and holds anything internal for you in your Slack DM.

A group chat is never armed. Your tag in a group still hands Kage the task, but no stand-in answers the group as you. In a group, anyone could steer a stand-in that writes as you, and only the guard model would stand between their words and a message sent from your number.

| Setting | Default | Effect |
|---|---|---|
| `connectors.whatsapp.on` | on | WhatsApp starts when secrets.json holds `waha` with `WAHA_API_KEY` and `WHATSAPP_HOOK_HMAC_KEY`: the WhatsApp container's env, name to value. Kage writes `~/.config/kage/waha/.env` from it for the container at each start, and a `waha/.env` made by hand moves into secrets.json once. After a key changes, restart the container. `false` turns it off. |
| `connectors.whatsapp.memory` | `~/.config/kage/wa-notes` | The only folder the stand-in can read. Put notes there on how you write and what it may know. Never point it at your full memory, and put no symlinks to other folders in it: anyone in an armed chat can ask about what it reads. |
| `connectors.whatsapp.model` | `sonnet` | The model the stand-in and the guard use. |
| `connectors.whatsapp.wahaUrl` | `http://127.0.0.1:3198` | Where WAHA's API listens. `waha/up.sh` publishes the container on this URL's port. |
| `connectors.whatsapp.hookHost` | `127.0.0.1` | Where Kage listens for WAHA's signed webhook. Use `0.0.0.0` only when WAHA runs in a container that reaches the host through a VM gateway, and keep the port off the internet. |
| `connectors.whatsapp.hookPort` | `3199` | The webhook port. `waha/up.sh` points WAHA at `http://host.docker.internal:<port>/waha`. |
| `connectors.whatsapp.checkMinutes` | `5` | How often the hub checks the bridge, in minutes. |

`waha/compose.yaml` takes its ports and its config folder from `waha/up.sh`, which reads them from these settings and from `KAGE_ENV`. After you change `wahaUrl` or `hookPort`, run `waha/up.sh` again. It remakes the container on the new ports and keeps the linked session. If you start the bridge with `docker compose` yourself, set `WAHA_PORT`, `WAHA_HOOK_PORT` and `WAHA_CONF` to match, or the hub and the container use different ports.

### Set up WhatsApp

Run the commands from the Kage folder: the git checkout, or `~/.local/share/kage` for an install from the install line.

1. Install Docker: Docker Desktop on macOS, Docker Engine on Linux. Check: `docker compose version` prints a version.
2. Make two random keys. Run `openssl rand -hex 32` two times and keep both lines.
3. Add the keys to `~/.config/kage/secrets.json`, with the first key as `WAHA_API_KEY` and the second as `WHATSAPP_HOOK_HMAC_KEY`. Keep the other keys in the file, and keep the file at mode 600.
   ```json
   "waha": { "WAHA_API_KEY": "<first key>", "WHATSAPP_HOOK_HMAC_KEY": "<second key>" }
   ```
4. If you run Linux, let the container reach Kage's webhook: `kage config set connectors.whatsapp.hookHost 0.0.0.0`. If a firewall such as ufw is on, allow only Docker's networks: `sudo ufw allow from 172.16.0.0/12 to any port 3199 proto tcp` (use your `hookPort` if you changed it). Keep that port closed to the internet.
5. Run `kage restart`. At its start, Kage writes the keys to `~/.config/kage/waha/.env` for the container.
6. Start the bridge: `waha/up.sh`. On an ARM machine, such as a Mac with Apple silicon, run `WAHA_TAG=gows-arm-2026.10.1 waha/up.sh` instead. If you already run WAHA, do the steps in "Move an existing WAHA to Kage's bridge" below first.
7. Link your phone: `waha/qr.sh`. It repeats the ban risk and asks you to type `yes`. Then it shows a QR code. On your phone, open WhatsApp > Settings > Linked devices > Link a device, and scan the code.
8. Check: `kage doctor` shows `ok    WhatsApp bridge up, session WORKING`.
9. Try it: in any chat, type `@kage` and a task.

### Move an existing WAHA to Kage's bridge

`waha/compose.yaml` makes a new container (`kage-waha`) with a new volume for the session. Your old container's session does not move into it.

1. Find the old container: `docker ps -a --filter ancestor=devlikeapro/waha`.
2. Stop and remove it: `docker rm -f <name>`. This frees its port. Its volume stays, so you can go back to it.
3. Do steps 6 and 7 above. You scan the QR code again, because the new volume holds no session.

The GOWS engine applies only to a session WAHA makes. A session you bring over by hand keeps its old engine, and Kage then loses the forwarded and edited flags.

To keep your own compose file instead, skip these steps and make it match Kage's: the `wahaUrl` port published to 3000, `WHATSAPP_HOOK_URL` at `http://host.docker.internal:<hookPort>/waha`, `WHATSAPP_HOOK_EVENTS: message.any`, `WHATSAPP_DEFAULT_ENGINE: GOWS`, and the keys from `~/.config/kage/waha/.env`. The doctor and the DM name the container `kage-waha`, so their fix lines then need your container's name.

### When the bridge stops

If the bridge stops or the phone unlinks, Kage hears no `@kage` tag from WhatsApp. `kage doctor` then prints a FAIL line with the fix, such as `docker start kage-waha` or `waha/qr.sh`. The hub checks the bridge every `connectors.whatsapp.checkMinutes` (5 by default). It DMs you once when the bridge goes down, and once more when it is back. A session seen STARTING once is not down, because every container restart passes through it. It is down if it is still STARTING on the next check. If Slack refuses the DM, the hub sends it again on the next check. A `docker stop` keeps the container down until you start it again.

## SMS

Kage texts US numbers through Telnyx (the default) or Twilio. You start a campaign from a Slack thread: Kage loads the numbers, shows you the count and the text on a card, and sends only after your yes. Each campaign posts its report in that thread: sent, delivered, failed, replies and opt-outs. A reply from a person becomes a task with the most limited rights (read and answer), and each text back waits for your yes on a card.

Every send obeys these rules. A number that texted STOP never gets another text until it texts START. Campaign texts go out only from 2pm to 8pm Eastern. A crash never texts anyone twice: each contact is claimed before its send. Kage stores the status, error code and segment count of each text, never its words. If the provider refuses Kage's credentials, the sending campaigns pause and you get one DM.

US carriers block texts from a number that has no registered 10DLC brand and campaign. Register both in the provider's console before the first send.

| Setting | Default | Effect |
|---|---|---|
| `connectors.sms.on` | on once set up | SMS runs once `from`, `publicUrl` and the provider's keys are set. `false` turns it off (`kage connector off sms`). |
| `connectors.sms.provider` | `telnyx` | `telnyx` or `twilio`. |
| `connectors.sms.from` | none | The number Kage texts from, in E.164 (`+14155550100`). Texts sent to any other number are ignored. |
| `connectors.sms.port` | `8793` | The local port the provider's webhook calls, at `/sms`. |
| `connectors.sms.publicUrl` | none | The public URL that reaches that port, ending in `/sms`. Kage gives it to the provider for delivery reports, and Twilio's signature check needs it exact. |
| `connectors.sms.perHour` | `30` | Texts from people that Kage answers per hour. Past it, Kage stores them and DMs you once. |
| `connectors.sms.perMinute` | `30` | Campaign texts sent per minute. |
| `connectors.sms.accountSid` | none | Twilio only: the account SID. |
| `connectors.sms.telnyxPublicKey` | none | Telnyx only: the public key that signs its webhooks (Telnyx console, Keys and Credentials). |
| `twilioAuthToken` | none | secrets.json. Twilio only: the auth token. It sends texts and checks Twilio's webhook signature. |
| `telnyxApiKey` | none | secrets.json. Telnyx only: the API key that sends texts. |

### Twilio Event Streams: texts to a number whose webhook points elsewhere

A Twilio number in a Messaging Service sends its incoming texts to the service's webhook, not to Kage. Twilio Event Streams sends a copy of each incoming text to a second address, and the service's own webhook keeps working.

1. In the Twilio console, under Event Streams, create a Webhook sink with the destination `<publicUrl>/events` and the method POST.
2. Subscribe that sink to `com.twilio.messaging.inbound-message.received`, schema version 1.

Kage checks the signature and the body hash of each post and refuses one that fails. The sink receives the texts to every number on the account, and Kage drops each one not sent to `connectors.sms.from`. A text that reaches Kage through both the webhook and Event Streams starts one task.

## Slash commands

| Setting | Default | Effect |
|---|---|---|
| `connectors.commands` | empty | An object from a command to its script: `{ "/lookup": "/abs/path/script.mjs" }`. The hub answers these itself, with no Claude session. |

## Set by Kage itself

`KAGE_CLAUDE` (the command that starts Claude Code) and `KAGE_THREAD` (a pane's session key) are set by `hub.ts` and the hub, and so are `KAGE_SSM_TOKEN`, `KAGE_SSM_SOCK` and `KAGE_SSM_SHIM` (a session's SSM relay and the folder of its stand-in plugin), `KAGE_KEYS_TOKEN` and `KAGE_KEYS_SOCK` (a session's key proxy), `KAGE_PANE_SETTINGS` (the sandbox settings a pane starts Claude Code with), `KAGE_MEETBOT_*` (the meeting bot's hub, token and voice agent), `KAGE_CALL_CODE` and `KAGE_CALL_REASON` (a call Kage places to the owner), `KAGE_SETUP_WAIT` and `KAGE_SLACK_API` (setup and tests). Do not put them in the settings files.
