# 0004. Only a message the owner typed counts as the owner

Status: Accepted. Known gap: a listed agent is `teammate` (#105). ADR 0018 lets a teammate answer a kagelet's held action inside the access the owner set.

## Decision

A task is `owner` only when the owner typed it. Slack requires `client_msg_id` and no `app_id` (`src/core/slack-message.ts`). Email is never the owner, whatever the address (`src/core/gate.ts`). A voice call is the owner only if Kage placed it and the voice connector flagged it. Agents, teammates, email and voice callers never count as the owner, so the owner's own forwarded email or script runs with teammate limits.

`senderOf` returns `owner`, `teammate` or `voice`. Every rule about guards, approvals, memory and config access keys off it.

## How it is checked

`src/core/tests/gate.test.ts` (`senderOf`). The owner key and the link token: `src/runtime/tests/session-link-owner-key.test.ts`, and the live `src/runtime/tests/sandbox-teammates.test.ts`, where a walled shell reaches the socket and its owner command is refused.

## Trust only falls

- The owner is whoever the Slack user token belongs to. A display name never picks an identity, only the id does. (`src/connectors/slack/connect.ts`)
- A post that carries the owner's id but no `client_msg_id` is an app using their token, not the owner. (`src/core/gate.ts`, `src/core/slack-message.ts`)
- The hub sets the `kage say` flag. A Slack event never brings one, so Slack's own copy of that post is dropped. (`src/core/slack-message.ts`, `src/connectors/slack/connect.ts`)
- Only this machine reaches `router.sock`, so `kage tell`, `say` and `call` speak as the owner. A session's Bash can reach it too, so the reply tool's outbound rules still apply. (`src/connectors/slack/say.ts`, `src/runtime/session-link.ts`, `src/hub/owner-commands.ts`)
- The socket's commands come in three kinds, in one table. A write (`tell`, `say`, `relay`, `stop`, `hold`, `end`, `quiesce`, `reload`, `kagelet`, `callcode`) needs the owner key. A read (`board`, `health`) takes the owner key or the read token. A session's own messages need its `hello`. The hub makes it once in `owner.key` in the config folder, mode 600, and the `kage` commands send it. A connection without it gets a plain refusal, and nothing runs. No session may read the key: it is closed like `secrets.json` (ADR 0006). A walled shell may still open `router.sock`, since Claude Code cannot filter Unix sockets by path on Linux, so the key alone carries the check. A `KAGE_CLAUDE` check in a command is only a friendly message, since a session can unset it. (`src/runtime/session-link.ts`, `src/runtime/owner-key.ts`, `src/runtime/path-guards.ts`)
- If `owner.key` goes missing or changes while the hub runs, the `kage` commands name the fix (`kage restart --cut-running`) in the owner's terminal, never in a session. A refusal is never read as an older hub, so `kage restart` and `kage stop` cut nothing on one, and `kage doctor` FAILs with the same fix. (`src/core/quiet.ts`, `src/cli/doctor/hub-key.ts`)
- An owner thread's session gets the read token (`KAGE_READ_TOKEN`, made from the owner key, never the key itself), so `kage status` and `kage list` work there. It never answers a write. A teammate's or an agent's session gets no token, so the hub no longer shows it the owner's thread list. A teammate who writes later in a thread the owner started works in a session that already holds the token, so that turn can read the board. (`src/runtime/sdk-sessions.ts`, `src/cli/home.ts`)
- `hello` binds a connection to one thread only with that thread's link token, made from the owner key and the thread key. The hub gives it only to the tmux pane it starts, so a session cannot take another thread's tasks. An SDK session never says `hello`. A hub that makes a new key closes its own tagged panes on any runner, never another tmux window or its own pane, because they hold no token and could never link. The token stays the same across restarts, so an adopted pane links again. A leaked token binds only its own thread. (`src/runtime/session-link.ts`, `src/runtime/tmux-panes.ts`, `plugin/server.ts`)
- A session's shell may not run a `kage` command that writes as the owner (`tell`, `relay`, `stop`, `attach`, `call`, `reload`, `restart`, `add`, `remove`), with or without `KAGE_CLAUDE` set. The read commands still run. This is a word check in a hook, so a reworded command gets past it. In a thread the OS sandbox does not wall, such a command can still read the key, as with the token files. Only the sandbox is a wall there (ADR 0006). (`src/runtime/path-guards.ts`)
- A thread is owner-trusted only while every task it got came from the owner by Slack. Trust only falls, and a restart keeps it. (`src/hub/router.ts`, `src/runtime/store.ts`, `src/runtime/scheduler.ts`)
- A thread with a session from before trust was recorded starts untrusted, because its history is unknown. (`src/hub/router.ts`, `src/runtime/store.ts`)
- The hub decides a schedule's trust, never the session, so a teammate's turn cannot set up a schedule that runs as the owner. (`src/runtime/scheduler.ts`)
- A run woken by a watch, a probe or a job webhook never gets owner trust, whoever set it up. Its text is outside text. (`src/runtime/scheduler.ts`, `src/runtime/kage-tools.ts`)
- A pane's latest task decides the trust its exported jobs keep. A teammate's job stays a teammate's. (`src/cli/export-crons.ts`)
- An agent never stops a thread, never writes an approval, and never counts as the owner. Its "stop" stays a plain task. (`src/core/gate.ts`, `src/core/agents.ts`)
- A teammate stops a thread only if their own task started it. The starters map lives in memory, so after a restart only the owner may. (`src/core/gate.ts`, `src/hub/router.ts`)
- `side:` lanes are owner only, so a teammate cannot open extra sessions and push the owner's out. (`src/core/gate.ts`)
- Only the owner's DM carries approvals, and a card is answered in Slack only, because a session's own shell can open the socket. (`src/core/gate.ts`)
- The hub finds a card from its message id in the posted ledger, never from its text. Only a `card` row counts, so a copied card is a `bot` row. (`src/connectors/slack/connect.ts`, `src/core/ledgers.ts`, `src/runtime/kage-tools.ts`)
- A yes approves unless the rest hedges. A no denies on its first word, since a wrong deny is safe. An "always" must be strict, one line, nothing else. (`src/core/gate.ts`)
- Untagged words from the owner in a kagelet thread are notes for that kagelet. Nobody else's words steer one. (`src/connectors/slack/connect.ts`, `src/runtime/kagelets/notes.ts`)
- Undo (`restore_job`) takes only typed owner words, so a teammate or a job's own run cannot flip jobs back and forth. (`src/runtime/tools/schedule-tools.ts`)
- The email `References` header never picks a session. Only someone already in a stored thread resumes it. (`src/core/email.ts`)
- DMARC passes on any aligned signature, and Kage's own SES can sign as the domain, so a mail never proves the owner. (`src/core/email.ts`)
- WhatsApp is the owner's phone, easier to steal than Slack. A WhatsApp task messages people only after a yes on a Slack card. (`src/runtime/tools/slack-people.ts`)
