# Settings

Every setting lives in `~/.config/kage/env` (mode 600), one `NAME=value` per line. Apply a change to `KAGE_TEAMMATES` or `KAGE_TRUSTED_APPS` with `kage reload`: it cuts no session, and a file with a wrong line changes nothing. Apply any other change with `kage restart`. `kage reload` names the changed settings that still wait for one. A change to `KAGE_RUNTIME`, `KAGE_ROUTE`, `KAGE_CWD` or `KAGE_MEMORY` needs `kage stop`, then `kage start`. `KAGE_ENV` points Kage at a different file, which is how one machine runs two Kages.

To list every setting the code reads:

```sh
grep -rhoE 'KAGE_[A-Z_]+' --include=*.ts --include=*.sh . --exclude-dir=node_modules | sort -u
```

## Slack and identity

| Setting | Default | Effect |
|---|---|---|
| `SLACK_APP_TOKEN` | required | The `xapp-` token for Socket Mode. `kage save` writes it. |
| `SLACK_USER_TOKEN` | required | The `xoxp-` token. Its owner is the only person who drives Kage. |
| `SLACK_BOT_TOKEN` | required | The `xoxb-` token Kage posts with. |
| `KAGE_NAME` | `kage` | The word you tag (`@kage`), the tmux session name, and the label on posts. |
| `KAGE_TEAMMATES` | empty | Slack user ids, comma separated, who may also tag Kage. Use `kage add`. |
| `KAGE_TRUSTED_APPS` | empty | Agents, comma separated: each is a Slack app id and its owner, as `<app id>:<owner id>`, with the agent's own Slack user id after a second colon when Kage knows it (`<app id>:<owner id>:<tag>`). Kage tags the agent with it on every part of a reply. The owner is a listed person, or a listed agent. Use `kage add <app id> <owner>`. A tagged post from the app, made with its owner's token, counts as that person's task. It never counts as the owner's. An app id with no owner counts with any listed teammate's token. |

## Sessions

| Setting | Default | Effect |
|---|---|---|
| `KAGE_MAX_SESSIONS` | `4` | Sessions that run at once. A tag over the limit gets ⏳. |
| `KAGE_MAX_KAGELETS` | `10` | Kagelets that may run on this install. Past it, by name order, one runs nothing. Kage makes no new one while this many files exist, paused ones included. |
| `KAGE_KAGELET_DAILY_USD` | `2` | What one kagelet may spend in a day. At the cap it is paused (its file says so), and you get a DM and a waiting line. It stays paused until you resume it, and from then it counts only what it spends after the resume. |
| `KAGE_AUTO_UPDATE` | on | `off` stops Kage updating itself. On, every 6 hours the hub runs `git fetch origin main`, then `git merge --ff-only origin/main`, and restarts into the new code once every session is quiet. It does this only in a git checkout on branch `main` with no uncommitted changes and no local commits. Anything else gets one `auto-update did nothing` line in `kage logs` with the reason. After an update you get a DM that names the old and new version and links to what changed. An install from the install line is not a git checkout, so it updates only when you run the install line again. Releases are not signed yet (#58). |
| `KAGE_IDLE_MINUTES` | `30` | A quiet session closes after this long. Its next tag resumes it. |
| `KAGE_RUNTIME` | SDK | `tmux` runs each thread as a Claude Code pane instead of an Agent SDK session in the hub. |
| `KAGE_ROUTE` | `dev` | With `KAGE_RUNTIME=tmux` only. `plugin` starts panes with no warning screen, once your org approves the channel. |
| `KAGE_CWD` | your home folder | The folder sessions start in. |
| `KAGE_MEMORY` | `~/.config/kage/memory` | Kage's own memory folder. |
| `KAGE_OWNER_MEMORY` | your Claude Code memory for the home folder | The memory Kage reads, and where it may write notes about people (`user_*.md`) only. |

## AFK mode

| Setting | Default | Effect |
|---|---|---|
| `KAGE_AFK` | on | `off` turns AFK mode off. On, tell Kage you are stepping away in any words ("cover for me, lunch for an hour"). It watches threads that mention or DM you and stays quiet unless you are mentioned again or it is urgent. A P0 phones you through `KAGE_CALL_COMMAND`. Say you are back in any words for the summary. Threads run as tmux panes cannot switch it yet. |
| `KAGE_AFK_MODEL` | `sonnet` | The model the stand-in uses. |

## Email

Email is on when `KAGE_MAIL_ADDRESS`, `KAGE_MAIL_QUEUE` and `KAGE_OWNER_EMAIL` are set, unless `KAGE_EMAIL=off`. It also needs the AWS keys.

| Setting | Default | Effect |
|---|---|---|
| `KAGE_MAIL_ADDRESS` | none | The address people write to. |
| `KAGE_MAIL_QUEUE` | none | The SQS queue that receives that address's mail. |
| `KAGE_OWNER_EMAIL` | none | Your address. Its domain is the only one Kage replies to. |
| `KAGE_AWS_ACCESS_KEY_ID`, `KAGE_AWS_SECRET_ACCESS_KEY` | none | AWS keys for SQS and SES. |
| `KAGE_AWS_REGION` | `us-west-1` | Their region. |
| `KAGE_TEAMMATE_EMAILS` | empty | Teammates' addresses, comma separated. |
| `KAGE_EMAIL` | on | `off` is the kill switch. |

## Voice and calls

| Setting | Default | Effect |
|---|---|---|
| `KAGE_VOICE_TOKEN` | none | Turns voice on: an MCP endpoint with one tool, `ask_kage`, behind `Authorization: Bearer <token>`. |
| `KAGE_GITHUB_SECRET` | none | With `KAGE_GITHUB_LOGIN`, turns GitHub on: a webhook at `127.0.0.1:<port>/github`, checked against this secret. Point a tunnel at it, then add the webhook on a repo (content type JSON, events: pull request reviews, pull requests, issues, issue comments, check suites). |
| `KAGE_GITHUB_LOGIN` | none | Your GitHub username. Only events that are yours wake Kage: a review on your pull request, failed checks on it, an issue or a review request given to you, a comment that mentions you, from people the repo lists as owner, member or collaborator. Each pull request or issue gets one thread in your DM with Kage. |
| `KAGE_GITHUB_PORT` | `8789` | The local port the GitHub webhook listens on. |
| `KAGE_GITHUB_PER_HOUR` | `20` | At most this many GitHub events start work in an hour; past it, you get one note and the rest are skipped until the hour is up. |
| `KAGE_MEETING_TOKEN` | none | Turns meeting notes on: a webhook at `127.0.0.1:<port>/meeting` behind `Authorization: Bearer <token>`. Post a finished transcript as JSON: `{"title", "link", "segments": [{"speaker", "text", "start"}]}`, the shape Vexa's `GET /transcripts/...` returns. Each meeting gets a thread in your DM with Kage: notes, decisions, owners, open questions, and follow-ups Kage does only after your yes. |
| `KAGE_MEETING_PORT` | `8790` | The local port the meeting webhook listens on. |
| `KAGE_MEETING_PER_HOUR` | `10` | At most this many transcripts start work in an hour. |
| `KAGE_VOICE_PORT` | `8787` | It listens on `127.0.0.1:<port>/mcp`. Put a tunnel in front of it. |
| `KAGE_VOICE_MAX` | `1` | Calls at a time. A call never takes a slot from your threads. |
| `KAGE_VOICE_PER_HOUR` | `20` | New calls per hour. |
| `KAGE_VOICE` | on | `off` turns voice off. |
| `KAGE_CALL_COMMAND` | none | The command `kage call` and an AFK P0 run to phone you. It gets a one-time code in `$KAGE_CALL_CODE`, and for a P0 the reason in `$KAGE_CALL_REASON`. |

## WhatsApp

WhatsApp runs through [WAHA](https://github.com/devlikeapro/waha), an unofficial WhatsApp Web bridge linked to your own number. WhatsApp's terms do not allow unofficial clients, so the number you link can be banned. Use it at your own risk.

When it is on, you type `@kage <task>` in any chat to hand Kage a task. The chat is also armed for an hour: a stand-in answers new messages there as you, until you type in the chat yourself. A guard reads every message before it leaves, and holds anything internal for you in your Slack DM.

| Setting | Default | Effect |
|---|---|---|
| `KAGE_WHATSAPP` | on | WhatsApp starts when `~/.config/kage/waha/.env` exists (`WAHA_API_KEY`, `WHATSAPP_HOOK_HMAC_KEY`). `off` turns it off. |
| `KAGE_WA_MEMORY` | `~/.config/kage/wa-notes` | The only folder the stand-in can read. Put notes there on how you write and what it may know. Never point it at your full memory, and put no symlinks to other folders in it: anyone in an armed chat can ask about what it reads. |
| `KAGE_WA_MODEL` | `sonnet` | The model the stand-in and the guard use. |
| `KAGE_WAHA_URL` | `http://127.0.0.1:3198` | Where WAHA's API listens. |
| `KAGE_WA_HOOK_HOST` | `127.0.0.1` | Where Kage listens for WAHA's signed webhook. Use `0.0.0.0` only when WAHA runs in a container that reaches the host through a VM gateway, and keep the port off the internet. |
| `KAGE_WA_HOOK_PORT` | `3199` | The webhook port. Point WAHA at `http://<host>:<port>/waha`. |

## Slash commands

| Setting | Default | Effect |
|---|---|---|
| `KAGE_COMMANDS` | empty | `/name=/abs/path/script.mjs`, comma separated. The hub answers these itself, with no Claude session. |

## Set by Kage itself

`KAGE_CLAUDE` (the command that starts Claude Code) and `KAGE_THREAD` (a pane's session key) are set by `hub.ts` and the hub. Do not put them in the env file.
