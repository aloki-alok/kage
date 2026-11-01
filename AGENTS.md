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

6. Pick the start route. Read the org's channel approval:
   ```sh
   node -e 'const f=process.env.HOME+"/.claude/remote-settings.json";let s={};try{s=require(f)}catch{};console.log(JSON.stringify(s.allowedChannelPlugins||null))'
   ```
   - If the list contains `{"marketplace":"kage","plugin":"kage"}`, use the plugin route (step 7).
   - If it prints `null` or lacks kage, use the dev route (step 8). Tell the person that an org Owner can approve Kage later (README, "Start without prompts").
   - If Claude Code later says "Channels are not enabled for your org", the person's org Owner turns on Channels at https://claude.ai/admin-settings/claude-code. Personal Pro and Max accounts skip this.

7. Plugin route (no prompts, can start at login).
   ```sh
   claude plugin marketplace add "$PWD" && claude plugin install kage@kage
   grep -q '^KAGE_ROUTE=' ~/.config/kage/env || echo 'KAGE_ROUTE=plugin' >> ~/.config/kage/env
   ./start.sh
   ```
   **Person, first start only:** Claude Code may ask whether they trust the home folder. If the doctor in step 9 says "not connected", ask them to run `tmux attach -t <name>`, choose **Yes**, then press `Ctrl-b` and `d`. Do not answer it for them.

   On macOS, ask the person whether Kage should start at login. If yes, run `./autostart.sh on`.

8. Dev route.
   ```sh
   ./start.sh
   ```
   **Person:** Claude Code shows a warning screen for custom channels on every start, and on the first start it may also ask whether they trust the home folder. Ask them to run `tmux attach -t <name>`, choose **Yes** on the trust question, press Enter on "I am using this for local development", and then press `Ctrl-b` and `d`. Do not press the keys for them: those screens are their consent.

9. Prove it works.
   ```sh
   ./setup.sh doctor
   ```
   Check: the last line is `All good`. Every `FAIL` line names its fix. Do that fix, then run the doctor again. Kage takes about 20 seconds to connect after a start.

10. Tell the person to tag `@<name>` in any Slack thread. They get 🥷 when Kage picks the task up, and ⚔️ when it has answered.

## Run it

| Task | Command |
|---|---|
| Health check | `./setup.sh doctor` |
| See the session | `tmux attach -t <name>` (leave with `Ctrl-b` then `d`) |
| Restart | `tmux kill-session -t =<name> && ./start.sh` |
| Stop | `tmux kill-session -t =<name>` |
| Start at login on or off (macOS) | `./autostart.sh on` or `./autostart.sh off` |
| Let a teammate tag it | Add `KAGE_TEAMMATES=U0123ABC,U0456DEF` to `~/.config/kage/env`, then restart |
| Update Kage | `git pull`, then restart. The plugin reads this folder, so no reinstall is needed. |

The token file is `~/.config/kage/env` (mode 600). Never print it, copy it or commit it.

## Change the code

- `logic.ts` holds the gate: who may start a task, quoting, reply safety. Every rule in it has a test in `logic.test.ts`.
- After a change to `server.ts` or `logic.ts`, run `npm ci` once, then `npm test`, `npm run typecheck` and `npm run build`. Commit `dist/server.js` with the change, because the plugin runs the bundle. Then restart Kage.
- The server writes logs to stderr only. Stdout carries the channel protocol, so a stray `console.log` breaks it.
