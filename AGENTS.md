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

The install line puts `kage` on your PATH (in a git checkout, run `./setup.sh link` once). Then `kage help` lists every command and `kage help <command>` shows one with an example. `kage doctor` prints the command that fixes each problem: run it, run the printed fix, and repeat until `All good`.

| Task | Command |
|---|---|
| Health check | `kage doctor` |
| One look at every session | `kage status` |
| The live console (mouse or keys: `↑↓` pick, `⏎` open the feed, `a` attach, `x` cut, `s` schedules, `/` search, `q` quit) | `kage top` |
| Follow every step | `kage watch`, or `kage watch support` for threads whose place contains "support" |
| Work in a thread's session yourself | `kage attach <place>`. It takes the session at once: a turn in progress stops, as with Esc. New tasks for it wait until you quit. When several threads share a place, attach by the key it lists. |
| Tell a thread something, as you | `kage tell <place> <message>`. Its session takes it after the current turn and answers in the thread. |
| The hub log | `kage logs` |
| Restart after a settings change | `kage restart`. A change to `KAGE_RUNTIME`, `KAGE_ROUTE`, `KAGE_CWD` or `KAGE_MEMORY` needs `kage stop`, then `kage start`. |
| Stop | `kage stop` |
| Start at login (macOS) | `kage autostart on` or `off` |
| Let a teammate tag it | `kage teammate add <name, @handle or id>` (also `remove`, `list`). If it lists two people, ask which one. |
| Let a teammate's own agent tag it | `kage app add <app id>` (also `remove`, `list`), then `kage restart`. The teammate must be listed too. The agent's owner finds the app id at api.slack.com/apps, under Basic Information. |
| Voice, calls, email, AFK, limits | Every setting, with its default, is in [docs/settings.md](docs/settings.md). |
| Run threads as tmux panes instead | Add `KAGE_RUNTIME=tmux` to `~/.config/kage/env`, then `kage stop` and `kage start`. Each pane then shows a channels warning screen that the person confirms (README, "Run threads as tmux panes instead"). |
| Update Kage | Run the install line again (`curl -fsSL https://raw.githubusercontent.com/aloki-alok/kage/main/install.sh | bash`), or `git pull` in a git checkout. The hub restarts into the new code by itself once every session is quiet. A session cut by a restart resumes its conversation on its next task. |

Never run `kage stop` or `kage restart` from inside a Kage session: it ends that session too. The command refuses unless you add `--force`.

The token file is `~/.config/kage/env` (mode 600). Never print it, copy it or commit it.

## Change the code

Read [CONTRIBUTING.md](CONTRIBUTING.md): the code map, the words the code uses, and how to check a change.
