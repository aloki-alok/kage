# Settings

Settings live in `~/.config/kage/config.json`, and the tokens in `~/.config/kage/secrets.json` (mode 600). One schema checks both files, so a misspelled key is refused with its name. Kage watches both files. A change to `people.teammates` or `people.agents` applies at once and cuts no session. Any other key restarts Kage by itself once every session is quiet. A file with a wrong key or value is refused: Kage keeps the last good settings and DMs you the bad key. `kage reload` checks now, and `kage set <key> <value>` changes one key of `config.json`. `KAGE_ENV` points Kage at a different config folder (its dirname), which is how one machine runs two Kages.

A key that is absent has its default. A dotted name such as `harness.maxSessions` is a nested key: `{ "harness": { "maxSessions": 6 } }`. Keys marked "secrets.json" go in that file. A list is a JSON array, an on or off setting is `true` or `false`.

An older install had one `~/.config/kage/env` file. On its first start with this version, Kage reads it with a fixed table, writes both JSON files, and renames it to `env.imported-<time>`. It deletes that file 7 days after a clean start. A line the table does not know goes under `unknown` in `config.json` (a secret-looking one keeps its value in `secrets.json`), and Kage DMs you its name.

To list every key:

```sh
node -e "import('./core/config.ts').then(m => console.log(m.KEYS.map(k => k.path).join('\n')))"
```

## Who may change a setting

Only your own terminal runs `kage set`: it refuses inside a Kage session. No session reads `secrets.json` or an env file, and none writes `config.json`. In your own task, a session changes a setting with `set_setting`. Limits, models, AFK, Jev thresholds, ports and the browser block list apply at once. People, any `command`, a connector turned on, and every `harness` key wait for your yes on a card. Tokens cannot be set that way.

## Slack and identity

| Setting | Default | Effect |
|---|---|---|
| `slack.app` | required | secrets.json. The `xapp-` token for Socket Mode. `kage save` writes it. |
| `slack.user` | required | secrets.json. The `xoxp-` token. Its owner is the only person who drives Kage. |
| `slack.bot` | required | secrets.json. The `xoxb-` token Kage posts with. |
| `name` | `kage` | The word you tag (`@kage`), the tmux session name, and the label on posts. |
| `people.teammates` | empty | A list of Slack user ids who may also tag Kage. Use `kage add`. |
| `people.agents` | empty | A list of agents. Each is `{ "app": "<app id>", "owner": "<owner id>", "tag": "<user id>" }`. The `tag` is the agent's own Slack user id, set when Kage knows it: Kage tags the agent with it on every part of a reply. The owner is a listed person, or a listed agent. Use `kage add <app id> <owner>`. A tagged post from the app, made with its owner's token, counts as that person's task. It never counts as the owner's. An app id with no owner counts with any listed teammate's token. |

## Agent replies (Jev classifier)

An agent that always answers can keep a thread going with posts that ask for nothing: "done", "thanks", "posted it". With a Jev key, Kage asks [TypeSafe's Jev classifier](https://typesafe.ai) about each tagged post from a listed agent before it starts a task, and drops the post when Jev scores it as needing no reply. The loop guard (4 agent turns in a row in one thread, 20 a minute) still applies on top.

Only a listed agent's post goes to Jev, at most its first 4,000 characters, with the tag taken out. Your posts and your teammates' never do. If Jev times out (4 s) or errors, the post is answered as before. `kage logs` shows each decision as an `answering` or `dropped` line with Jev's score, never the post or the key. `kage doctor` checks the key with one fixed test sentence. A change needs `kage restart`.

| Setting | Default | Effect |
|---|---|---|
| `jevKey` | none | secrets.json. Turns Jev on. A key for `api.typesafe.ai`, kept in secrets.json only. |
| `jev.agents` | every listed agent | A list of the app ids Jev checks, or `["all"]`. Each must also be in `people.agents`. |
| `jev.threshold` | `0.5` | The needs-reply score, between 0 and 1, that a post needs to start a task. Higher drops more. |
| `jev.model` | `jev-latest` | The Jev model, such as `jev-1.14.0` to pin one. |

## Sessions

| Setting | Default | Effect |
|---|---|---|
| `harness.maxSessions` | `4` | Sessions that run at once. A tag over the limit gets ⏳. |
| `kagelets.max` | `10` | Kagelets that may run on this install. Past it, by name order, one runs nothing. Kage makes no new one while this many files exist, paused ones included. |
| `kagelets.dailyUsd` | none (no cap) | What one kagelet may spend in a day, in dollars. Unset, no kagelet is ever paused for cost. To turn the cap on, set a number such as `2`. `0` is a cap of $0, which pauses every kagelet: leave the line out for no cap. At the cap the kagelet is paused (its file says so), and you get a DM and a waiting line. At 80% you get one DM that day. It stays paused until you resume it, and from then it counts only what it spends after the resume. A run in progress stops at the cap. A value that is not a number of dollars leaves the cap off, and the hub log says so at start. |
| `kagelets.totalDailyUsd` | none (no cap) | What all kagelets together may spend in a day, in dollars. Unset, there is no total cap. Set, every running kagelet is paused at it, and you get one DM that day. At 80% you get one DM that day. Each kagelet counts what it spent since midnight, or since its last resume. Only you set or raise a cap: a standing approval never covers it. With or without caps, Kage watches cost: a kagelet that spends over 3 times its 7-day daily average (and over $0.50), or a run that wrote no cost row, gets one line a day in Kage's reports, which Kage's kagelet list shows. |
| `kagelets.chainUsd` | none (no cap) | What one chain of kagelets (`after:` steps and kagelet messages, started by one scheduled or person-started run) may spend, in dollars. At the cap the hub starts no further step, and the stop goes on your waiting list. A value that is not a number of dollars leaves the cap off, and the hub log says so at start. |
| `autoUpdate` | on | `false` stops Kage updating itself. On, every 6 hours the hub fetches the `stable` tag from origin, runs `git merge --ff-only` to it, and restarts into the new code once every session is quiet. It follows the tag, not the newest commit on `main`, so a merge reaches no install until the tag moves. With no `stable` tag on origin, it does not update. It does this only in a git checkout on branch `main` with no uncommitted changes and no commits the tag lacks, so a tag moved back is never followed. Anything else gets one `auto-update did nothing` line in `kage logs` with the reason. A commit is tagged `stable` only after it has run on the repo owner's own hub for 24 hours, with `kage doctor` at `All good` and no crash-loop DM. The repo owner's Kage moves the tag, with one command: `git push -f origin <sha>:refs/tags/stable`. No code, CI or script pushes tags. After an update you get a DM that names the old and new version and links to what changed. The install line makes a git checkout when git is installed, and run again it turns an older tarball install into one. Without git it installs a tarball, which updates only when you run the install line again. `kage doctor` says when an install cannot update itself, and why. Releases are not signed yet (#58). |
| `kagelets.dbRead.command` | none | The command `db_read` runs, for a kagelet you granted `db_read`. Point it at the read command this install already uses: a script that runs one query in a read-only transaction and prints the rows, one per line. Kage passes the query as the last argument, quoted, so `my-db-read --flag` runs as `my-db-read --flag '<query>'`. Kage holds no database login of its own, so a kagelet never reads more than this command can. Never create a new database login for Kage. Unset, a kagelet's `db_read` uses a read command you approved on a card before tiers (kept in `kage.db`, also after you remove the kagelet that brought it), and with none kept a kagelet gets no `db_read`. Set, this one wins. |
| `kagelets.dbRead.maxRows` | `200` | The most rows one `db_read` query returns. Kage wraps the query as `select * from (<query>) limit <rows>`. |
| `harness.idleMinutes` | `30` | A quiet session closes after this long. Its next tag resumes it. |
| `harness.runtime` | SDK | `tmux` runs each thread as a Claude Code pane instead of an Agent SDK session in the hub. |
| `harness.route` | `dev` | With `harness.runtime` set to `tmux` only. `plugin` starts panes with no warning screen, once your org approves the channel. |
| `harness.cwd` | your home folder | The folder sessions start in. |
| `harness.memory` | `~/.config/kage/memory` | Kage's own memory folder. |
| `harness.ownerMemory` | your Claude Code memory for the home folder | The memory Kage reads, and where it may write notes about people (`user_*.md`) only. |

## AFK mode

| Setting | Default | Effect |
|---|---|---|
| `afk.on` | on | `false` turns AFK mode off. On, tell Kage you are stepping away in any words ("cover for me, lunch for an hour"). It watches threads that mention or DM you and stays quiet unless you are mentioned again or it is urgent. A P0 phones you through `connectors.call.command`. Say you are back in any words for the summary. Threads run as tmux panes cannot switch it yet. |
| `afk.model` | `sonnet` | The model the stand-in uses. |

## Email

Email is on when `connectors.email.address`, `connectors.email.queue` and `connectors.email.ownerEmail` are set, unless `connectors.email.on` is `false`. It also needs the AWS keys.

| Setting | Default | Effect |
|---|---|---|
| `connectors.email.address` | none | The address people write to. |
| `connectors.email.queue` | none | The SQS queue that receives that address's mail. |
| `connectors.email.ownerEmail` | none | Your address. Its domain is the only one Kage replies to. |
| `aws.accessKeyId`, `aws.secretAccessKey` | none | secrets.json. AWS keys for SQS and SES. |
| `connectors.email.region` | `us-west-1` | Their region. |
| `connectors.email.teammateEmails` | empty | A list of teammates' addresses. |
| `connectors.email.on` | on | `false` is the kill switch. |

## Voice and calls

| Setting | Default | Effect |
|---|---|---|
| `voiceToken` | none | secrets.json. Turns voice on: an MCP endpoint with one tool, `ask_kage`, behind `Authorization: Bearer <token>`. |
| `githubSecret` | none | secrets.json. With `connectors.github.login`, turns GitHub on: a webhook at `127.0.0.1:<port>/github`, checked against this secret. Point a tunnel at it, then add the webhook on a repo (content type JSON, events: pull request reviews, pull requests, issues, issue comments, check suites). |
| `connectors.github.login` | none | Your GitHub username. Only events that are yours wake Kage: a review on your pull request, failed checks on it, an issue or a review request given to you, a comment that mentions you, from people the repo lists as owner, member or collaborator. Each pull request or issue gets one thread in your DM with Kage. |
| `connectors.github.port` | `8789` | The local port the GitHub webhook listens on. |
| `connectors.github.perHour` | `20` | At most this many GitHub events start work in an hour; past it, you get one note and the rest are skipped until the hour is up. |
| `meetingToken` | none | secrets.json. Turns meeting notes on: a webhook at `127.0.0.1:<port>/meeting` behind `Authorization: Bearer <token>`. Post a finished transcript as JSON: `{"title", "link", "segments": [{"speaker", "text", "start"}]}`, the shape Vexa's `GET /transcripts/...` returns. Each meeting gets a thread in your DM with Kage: notes, decisions, owners, open questions, and follow-ups Kage does only after your yes. |
| `connectors.meeting.port` | `8790` | The local port the meeting webhook listens on. |
| `connectors.meeting.perHour` | `10` | At most this many transcripts start work in an hour. |
| `browserToken` | none | secrets.json. Turns Kage in Chrome on: your own tasks can list your open tabs, read one, capture the front tab, and act in a tab (click, type, press a key, go to an address, open a tab in a Kage tab group). Every action waits for your yes on a card in your DM with Kage, which names the site and the control as the page labels it, with a screenshot when the tab is in front. `kage add browser` sets it, pairs every Chromium browser it finds (Chrome, Brave, Edge, Arc, Chromium, Vivaldi) so the extension fetches the token itself, and prints the steps: load the `extension` folder in Chrome (`chrome://extensions`, Developer mode, Load unpacked). In a browser it did not pair, paste the printed token in the Kage toolbar icon. `kage doctor` says whether the extension is connected. Teammates, agents, voice callers and kagelets never reach your browser. |
| `connectors.browser.port` | `8791` | The local port the extension connects to. |
| `connectors.browser.block` | none | A list of sites Kage never reads (`["bank.example.com", "1password.com"]`). A site also blocks its subdomains. Pages that are not http or https are never read. |
| `connectors.voice.port` | `8787` | It listens on `127.0.0.1:<port>/mcp`. Put a tunnel in front of it. |
| `connectors.voice.max` | `1` | Calls at a time. A call never takes a slot from your threads. |
| `connectors.voice.perHour` | `20` | New calls per hour. |
| `connectors.voice.on` | on | `false` turns voice off. |
| `connectors.call.command` | none | The command `kage call` and an AFK P0 run to phone you. It gets a one-time code in `$KAGE_CALL_CODE`, and for a P0 the reason in `$KAGE_CALL_REASON`. |

## WhatsApp

WhatsApp runs through [WAHA](https://github.com/devlikeapro/waha), an unofficial WhatsApp Web bridge linked to your own number. WhatsApp's terms do not allow unofficial clients, so the number you link can be banned. Use it at your own risk.

When it is on, you type `@kage <task>` in any chat to hand Kage a task. The chat is also armed for an hour: a stand-in answers new messages there as you, until you type in the chat yourself. A guard reads every message before it leaves, and holds anything internal for you in your Slack DM.

| Setting | Default | Effect |
|---|---|---|
| `connectors.whatsapp.on` | on | WhatsApp starts when `~/.config/kage/waha/.env` exists (`WAHA_API_KEY`, `WHATSAPP_HOOK_HMAC_KEY`). `false` turns it off. |
| `connectors.whatsapp.memory` | `~/.config/kage/wa-notes` | The only folder the stand-in can read. Put notes there on how you write and what it may know. Never point it at your full memory, and put no symlinks to other folders in it: anyone in an armed chat can ask about what it reads. |
| `connectors.whatsapp.model` | `sonnet` | The model the stand-in and the guard use. |
| `connectors.whatsapp.wahaUrl` | `http://127.0.0.1:3198` | Where WAHA's API listens. |
| `connectors.whatsapp.hookHost` | `127.0.0.1` | Where Kage listens for WAHA's signed webhook. Use `0.0.0.0` only when WAHA runs in a container that reaches the host through a VM gateway, and keep the port off the internet. |
| `connectors.whatsapp.hookPort` | `3199` | The webhook port. Point WAHA at `http://<host>:<port>/waha`. |

## Slash commands

| Setting | Default | Effect |
|---|---|---|
| `connectors.commands` | empty | An object from a command to its script: `{ "/lookup": "/abs/path/script.mjs" }`. The hub answers these itself, with no Claude session. |

## Set by Kage itself

`KAGE_CLAUDE` (the command that starts Claude Code) and `KAGE_THREAD` (a pane's session key) are set by `hub.ts` and the hub. Do not put them in the settings files.
