# Kage's meeting bot

On the hub's own machine there is nothing to run: once `meetbot/node_modules` is installed and `meetingToken` is set, the hub starts the bot as its child, headless, and restarts it after a crash. The steps below are for a bot on another machine.

The bot joins a Google Meet in its own Chromium. It posts one chat line saying it takes notes, and it sends Meet's live captions to your Kage hub. When someone says Kage's name, the hub answers at the voice-call limits, and the bot speaks the answer into the call. When the call ends, the whole transcript goes to your DM with Kage as notes, with follow-ups that wait for your yes. It runs on any machine with a screen or Xvfb. It only calls out to the hub, so the machine opens no port.

## Run it

1. On the hub's machine, set the meeting token: `kage config set` does not take tokens, so add `"meetingToken": "<a long random string>"` to `~/.config/kage/secrets.json`, then run `kage restart`.
2. Let the bot's machine reach the hub's meeting port. The hub listens on 127.0.0.1 only. With Tailscale on both machines, run this on the hub's machine:
   ```sh
   kage tunnel on
   ```
   It shares the meeting port with your tailnet, not the internet, and `kage doctor` shows it. `kage tunnel off` closes it.
3. On the bot's machine, install it:
   ```sh
   cd meetbot && npm ci && npx playwright-core install chromium
   ```
4. Write `~/.config/kage-meetbot/config.json`:
   ```json
   { "hub": "http://<hub machine's tailnet name>:8790" }
   ```
   and `~/.config/kage-meetbot/secrets.json` (mode 600) with the same token as the hub:
   ```json
   { "meetingToken": "<the same string>" }
   ```
5. Start it. On a machine with no screen, wrap it in Xvfb, because Meet refuses headless browsers:
   ```sh
   xvfb-run -a node bot.ts
   ```
   Check: it logs `meeting bot up`, and no `hub unreachable` line follows.

Then tell Kage in Slack: `@kage join https://meet.google.com/abc-defg-hij`. The host admits "Kage (notes)".

## Settings

| Key | File | Default | What it does |
|---|---|---|---|
| `hub` | config.json | none | The hub's meeting webhook address, with its port. |
| `name` | config.json | `Kage (notes)` | The name everyone in the call sees. |
| `consent` | config.json | a line naming the bot | The chat line it posts when it joins. |
| `chrome` | config.json | Playwright's Chromium | The browser to run. |
| `profile` | config.json | `~/.config/kage-meetbot/chromium` | The browser profile. Sign in to a Google account here once if Meet refuses guests. |
| `window` | config.json | `false` | `true` shows the browser window instead of running it headless. |
| `speak` | config.json | none | A command that reads Kage's answer on stdin and writes WAV audio to stdout: any TTS or voice pipeline. With none, or when it fails, the answer goes in the Meet chat. |
| `meetingToken` | secrets.json | none | The hub's `meetingToken`. |

## Check a change

All of Meet's page knowledge is in `page.js`. The end-to-end check runs the bot in Chromium against `tests/fake-meet.html` and the real hub connector:

```sh
node --test tests/e2e.test.ts
npx -p typescript@7 tsc --noEmit -p .
```

The fake page proves the bot's logic, not Meet's current page. After a change to `page.js`, join one real call.
