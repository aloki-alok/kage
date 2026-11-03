# Set up and run Kage (for coding agents)

You are setting up Kage for the person you work with. Kage lets them tag `@kage` in Slack, and a Claude Code session on this machine does the work and answers in the thread.

Do every step yourself. Ask the person only for the steps marked **Person**, because only a human can click in Slack or in the Claude admin page. When you need them, say exactly what to click, and wait.

Run every command from the repo root. Each step ends with a check. Go to the next step only when the check passes.

## Set it up

1. Check the tools.
   ```sh
   ./setup.sh check
   ```
   Check: it prints `ok:`. If a tool is missing, install it (macOS: `brew install node tmux`). For Claude Code, see https://code.claude.com/docs/en/quickstart.

2. Pick the name. Ask the person what they want to tag in Slack. If they have no preference, use `kage`. The name starts with a lowercase letter, then 1 to 20 lowercase letters, digits or dashes. Use the same name in every step.

3. Make the Slack app.
   ```sh
   ./setup.sh app <name>
   ```
   Check: it prints a `Create link`. It also tries to open that link in the browser.

4. **Person:** create the app and copy three tokens. Give them the link from step 3 and these steps:
   1. Pick the workspace, then click **Next** and **Create**.
   2. Open **Basic Information > App-Level Tokens > Generate**. Use any name and the scope `connections:write`. Copy the `xapp-` token.
   3. Open **Install App > Install to Workspace > Allow**. Copy the User OAuth Token (`xoxp-`) and the Bot User OAuth Token (`xoxb-`).

   If Slack says the app needs approval, a workspace admin approves it once.

5. **Person:** save the tokens. The tokens must never pass through you: do not ask for them in chat, and if the person pastes one anyway, tell them to regenerate it in Slack. Open a terminal window where they paste the tokens into hidden prompts:
   ```sh
   osascript -e "tell application \"Terminal\" to do script \"cd '$PWD' && ./setup.sh save <name>\"" -e 'tell application "Terminal" to activate'
   ```
   On Linux, ask them to run `cd ~/kage && ./setup.sh save <name>` in a terminal. The window prints `ok: saved to ... owner U...` when the tokens work.
   Check: `./setup.sh doctor` shows `ok` for the three `SLACK_` tokens. The other lines may still fail at this point.

6. Start it.
   ```sh
   ./start.sh
   ```
   Check: it prints `running, no prompts`. The first start installs the Agent SDK, which takes about a minute.

   On macOS, ask the person whether Kage should start at login. If yes, run `./autostart.sh on`.

7. Prove it works.
   ```sh
   ./setup.sh doctor
   ```
   Check: the last line is `All good`. Every `FAIL` line names its fix. Do that fix, then run the doctor again. Kage takes about 20 seconds to connect after a start.

8. Tell the person to tag `@<name>` in any Slack thread. They get 🥷 when Kage picks the task up, then 🗡️ for a quick answer, 📜 when Kage waits on their reply, and ⚔️ when the task is done. Each thread runs in its own Claude Code session.

## Run it

| Task | Command |
|---|---|
| Health check | `./setup.sh doctor` |
| Manage sessions in one screen | `./setup.sh top` draws Kage holding a string to every live thread (asks you, working, starting, watching, quiet), with ended threads under them. Mouse or keys: hover or `↑↓` pick, click or `⏎` open the live feed, `a` attach, `x` cut (the thread resumes on its next task), `s` schedules, `/` search, `q` quit. It needs a hub built from this version for live state. Regenerate Kage's picture with `node make-hero.ts` and its hand with `node make-hand.ts` (macOS). |
| Follow what every thread does | `./setup.sh watch`, or `./setup.sh watch acme` for threads whose place contains "acme". Read only, works with both runtimes. |
| Work in a thread's session yourself | `./setup.sh attach <place>` opens it in your terminal with its whole conversation. Kage holds the thread (new tasks wait) until you quit, then takes it back. It refuses while Kage is mid-turn or waiting on an approval. |
| See the panes (tmux runtime only) | `tmux attach -t <name>`, then `Ctrl-b` `n` to the `threads` window: one pane per thread, labelled with its channel. `Ctrl-b` `z` zooms a pane. Leave with `Ctrl-b` then `d`. |
| Restart | `tmux kill-session -t =<name> && ./start.sh` |
| Stop | `tmux kill-session -t =<name>` |
| Start at login on or off (macOS) | `./autostart.sh on` or `./autostart.sh off` |
| Let a teammate tag it | `./setup.sh teammate add <name, @handle or id>` (also `remove`, `list`). If it lists two people, ask which one. |
| Change the session limits | Add `KAGE_MAX_SESSIONS=4` or `KAGE_IDLE_MINUTES=30` to `~/.config/kage/env`, then restart |
| Run threads as tmux panes instead | Add `KAGE_RUNTIME=tmux` to `~/.config/kage/env`, then restart. Each pane then shows a channels warning screen that the person confirms (README, "Run threads as tmux panes instead"). |
| Update Kage | `git pull`, then restart. The plugin reads this folder, so no reinstall is needed. A restart ends SDK sessions mid-turn, and each resumes its conversation on its next task. An env file with no `KAGE_RUNTIME` line moves from panes to the SDK on that restart: running panes keep their thread until they close. |

The token file is `~/.config/kage/env` (mode 600). Never print it, copy it or commit it.

## Change the code

| Folder or file | Holds |
|---|---|
| `core/` | Pure rules, each with a `*.test.ts` next to it: `gate` (who may start a task, the task line, quoting, teammates), `conversations` (where a message lives and its session key), `sessions` (the dispatcher), `outbound` (mentions, secrets, Slack-sized parts), `ledgers`, `guards` (hook rules) |
| `connectors/` | One file per place Kage hears from: `slack.ts` (the one Socket Mode connection) with `slack-commands.ts`, `email.ts` with `mail.ts` and `mailbox.ts`. A connector turns a message into a `Task` and never decides who may drive Kage: `core/gate.ts` does |
| `runtime/` | Where sessions run: `sdk-sessions.ts` (the default: an Agent SDK session per thread, inside the hub), `tmux-windows.ts` (a pane per thread), `session-link.ts` (the socket sessions connect to), `protocol.ts` (the messages on it), `store.ts` (one SQLite file: conversations and their sessions), `kage-tools.ts` (a session's reply, edit, delete, waiting and prod-log tools, its instructions and approval prompt, with no transport) |
| `router.ts` | The hub: wiring only |
| `server.ts` | Serves `kage-tools.ts` over MCP inside each thread's tmux pane |

- After a change to any `.ts` file, run `npm ci` once, then `npm test`, `npm run typecheck` and `npm run build`. Commit `dist/` with the change, because the plugin and the hub run the bundles. Then restart Kage.
- The server writes logs to stderr only. Stdout carries the channel protocol, so a stray `console.log` breaks it.
