# Settings

Every setting lives in `~/.config/kage/env` (mode 600), one `NAME=value` per line. Apply a change with `kage restart`. A change to `KAGE_RUNTIME`, `KAGE_ROUTE`, `KAGE_CWD` or `KAGE_MEMORY` needs `kage stop`, then `kage start`. `KAGE_ENV` points Kage at a different file, which is how one machine runs two Kages.

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
| `KAGE_TEAMMATES` | empty | Slack user ids, comma separated, who may also tag Kage. Use `kage teammate add`. |

## Sessions

| Setting | Default | Effect |
|---|---|---|
| `KAGE_MAX_SESSIONS` | `4` | Sessions that run at once. A tag over the limit gets ⏳. |
| `KAGE_IDLE_MINUTES` | `30` | A quiet session closes after this long. Its next tag resumes it. |
| `KAGE_RUNTIME` | SDK | `tmux` runs each thread as a Claude Code pane instead of an Agent SDK session in the hub. |
| `KAGE_ROUTE` | `dev` | With `KAGE_RUNTIME=tmux` only. `plugin` starts panes with no warning screen, once your org approves the channel. |
| `KAGE_CWD` | your home folder | The folder sessions start in. |
| `KAGE_MEMORY` | `~/.config/kage/memory` | Kage's own memory folder. |
| `KAGE_OWNER_MEMORY` | your Claude Code memory for the home folder | The memory Kage reads, and where it may write notes about people (`user_*.md`) only. |

## AFK mode

| Setting | Default | Effect |
|---|---|---|
| `KAGE_AFK` | on | `off` turns AFK mode off. On, you DM Kage "afk for 30 mins" and it answers people who mention or DM you until you say "back". |
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
| `KAGE_VOICE_PORT` | `8787` | It listens on `127.0.0.1:<port>/mcp`. Put a tunnel in front of it. |
| `KAGE_VOICE_MAX` | `1` | Calls at a time. A call never takes a slot from your threads. |
| `KAGE_VOICE_PER_HOUR` | `20` | New calls per hour. |
| `KAGE_VOICE` | on | `off` turns voice off. |
| `KAGE_CALL_COMMAND` | none | The command `kage call` runs to phone you. It gets a one-time code in `$KAGE_CALL_CODE`. |

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

`KAGE_CLAUDE` (the command that starts Claude Code) and `KAGE_THREAD` (a pane's session key) are set by `start.sh` and the hub. Do not put them in the env file.
