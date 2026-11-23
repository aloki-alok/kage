# 0021. A session's process lifecycle follows what Claude Code does (measured)

Status: Accepted.

## Decision

- Claude Code says `idle` only after it read every message sent to it. This was measured. Without state events, only an empty turn counts as idle. (`src/runtime/sdk-sessions.ts`)
- A message folded into a running turn emits `completed` before that turn's result. This was measured, and the SDK types lack it. (`src/runtime/sdk-sessions.ts`, `src/runtime/tests/sdk-sessions.test.ts`)
- `session_state_changed` arrives only when requested. A subagent's refusal ends its own answer, not the thread. (`src/runtime/sdk-sessions.ts`)
- Nothing more goes to a closing process, because it may take a message and die before it answers. (`src/runtime/sdk-sessions.ts`)
- Once the owner writes in a teammate's turn, an idle process is replaced by one with the owner's tools. The owner's message goes in first. (`src/runtime/sdk-sessions.ts`)
- A session slot opens only after the owner can see the card. An open approval holds the slot, and an unposted prompt can never be answered. (`src/runtime/sdk-sessions.ts`)
- With deferred approvals, the card ends the turn and the owner's yes starts a new turn that retries the same call. (`src/runtime/sdk-sessions.ts`)
- A busy check that fails counts as busy. Never close a session on a guess. (`src/core/sessions.ts`)
- Resume a session only when no process runs its id, so two processes never write one transcript. (`src/cli/attach.ts`)
- A held thread (`kage attach`) lasts exactly as long as the terminal process. The hub's copy can take 7 s to exit after a cut. (`src/cli/attach.ts`, `src/runtime/session-link.ts`)
- Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default), so an old thread may not resume. (`src/runtime/tmux-panes.ts`)
- A tmux busy check reads the UI text. A UI change makes it miss, and then only transcript times keep a long task alive. (`src/runtime/tmux-panes.ts`)
- `npm ci` deletes `node_modules`, so a hub or `kage` command running then crashes. The hub runs `npm ci` itself, then exits 75 for a fresh process. (`tests/setup.test.ts`, `hub.ts`)
- The hub restarts into new code only after changes settle for 10 s and every session is quiet. The stamp compares to boot time, never the clock. (`src/hub/updates.ts`, `src/core/sessions.ts`)
- A drain holds every new message, so `kage update` never starts one. (`tests/setup.test.ts`)
- `plugin/server.ts` takes tasks only after the MCP handshake. It writes the sender file before the task lands, so a failed write drops the task. (`plugin/server.ts`)
- Run the Claude process from a fixed folder. Claude Code files transcripts by folder, so a different folder forgets every thread. (`hub.ts`)
- Claude Code with no CLAUDE.md or settings, run with `-p`, denies Bash outside its rules. This was tested 2026-11-04 (`gh pr view` ran, `curl` was refused). (`src/connectors/slack/afk.ts`, `src/runtime/claude-once.ts`)
- Go tools verify TLS through trustd on macOS, which the shell sandbox blocks. (`src/runtime/path-guards.ts`)
- Slack answers a bad token or missing scope with 200 and a sign-in page. (`src/runtime/slack-files.ts`)
- Slack code font fits about 64 characters. A longer row wraps (measured 2026-11-05, Monaco 12 px). (`src/core/outbound.ts`)
- `package-lock.json` keeps its old version on purpose, because a changed lockfile makes every hub run `npm ci`. (`src/runtime/release.ts`)

## How it is checked

`src/runtime/tests/sdk-sessions.test.ts` drives a fake Agent SDK through each frame named here (state changes, `command_lifecycle`, results, a process exit). The measured lines were measured against the real CLI in the PRs that added them; re-measure one when a Claude Code release changes that frame.
