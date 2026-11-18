# Run the Meta bot

The Meta bot answers people who message or comment on a business's Facebook Page or Instagram account. It runs on its own, apart from the hub. Strangers never reach Kage (ADR 0020).

What it does with each message:

1. It checks Meta's signature, then skips any message it has already handled.
2. It skips the thread if a person on the team answered it in the Meta inbox in the last `humanQuietHours`, or if the lead hit `repliesPerLeadPerDay`.
3. It makes one model call with the engine rules, `job.md` and the knowledge pack. The answer must be JSON with a reply and a label.
4. A fixed check holds a reply that carries a link not in `links.md`, a price not in the pack, or a secret.
5. A second model call reads the reply. Only `SEND` lets it out.
6. The mode decides where the reply goes. `dry` keeps it as a draft, `team` sends only to the `team` list, `live` sends to everyone, and `off` reads nothing.

The bot has no tools. Its model request never offers one, and `metabot/tests/structure.test.ts` fails if any file it loads can start a process.

## Set it up

1. Make the bot's folder. It holds secrets, so only you may read it:
   ```sh
   mkdir -p ~/.config/kage/metabot/pack && chmod 700 ~/.config/kage/metabot
   ```
2. Write `config.json` in it. Each key is listed under "Settings" below. Leave `mode` at `dry`.
3. Write `job.md`: who the bot speaks for, the next step for each kind of lead, and what each label means.
4. Put the facts in `pack/*.md` and the links the bot may send in `pack/links.md`, one per line. A reply with any other link or price is held.
5. Write `secrets.json` (mode 600): `appSecret` and `pageToken` from the Meta app, a `verifyToken` you make up, and `modelKey` for the model API.
6. Replay saved chats to check the answers. Nothing is sent:
   ```sh
   node metabot/replay.ts threads.json
   ```
   `threads.json` is a list of `{ "id": "T1", "lines": ["first message", "second"] }`.
7. Start the server. It listens on `127.0.0.1:<port>`, so put an HTTPS proxy or a tunnel in front of it:
   ```sh
   node metabot/server.ts
   ```
   Check: `curl -s 127.0.0.1:8795/health` prints `ok`.

## Connect the Meta app

1. In the app's Messenger settings, add the Page, then generate its Page token for `secrets.json`.
2. Under Webhooks, set the callback URL to `https://<your host>/webhook` with your verify token. Subscribe the Page fields `messages`, `messaging_postbacks`, `message_echoes` and `feed`.
3. Subscribe the Page to the app: `POST /{page-id}/subscribed_apps` with those fields.
4. If the Page uses Conversation routing, make the app the owner of Messenger chats. Meta sends the app no `messaging` events for a chat it does not own, so the bot stays quiet there.
5. Until App Review grants Advanced Access, Meta sends the bot only messages from people with a role on the app. Use `team` mode with their ids in `team` for that test.

App Review needs `pages_messaging` to reply in DMs and to comments, `pages_manage_engagement` for the public line under a comment, and `instagram_manage_messages` for Instagram.

## Settings

| Key | Default | Means |
|---|---|---|
| `brand` | `our business` | The name the bot speaks for. |
| `mode` | `dry` | `off`, `dry`, `team` or `live`. A wrong value reads as `dry`. |
| `team` | `[]` | The ids (PSIDs) that `team` mode sends to. |
| `ourAppId` | `""` | This app's id. An echo from any other app means a person answered in the inbox. |
| `limits.repliesPerLeadPerDay` | `8` | The most replies one lead gets in a UTC day. |
| `limits.humanQuietHours` | `72` | How long the bot stays out of a thread after a person answers it. |
| `maxChars` | `600` | A longer reply is held. |
| `historyLines` | `20` | How many earlier lines of the thread the model reads. |
| `fallbackReply` | `""` | A fixed line sent in place of a held reply, so the lead still gets an answer. Empty means nothing goes out. |
| `publicCommentLine` | `""` | A short public reply under a comment, after the private reply. Empty means none. |
| `model.baseUrl`, `model.model` | OpenAI, `gpt-5.4-mini` | Any OpenAI-compatible chat API. |
| `port` | `8795` | The local port. |
| `packDir` | `<folder>/pack` | Where the facts and `links.md` are. The bot reads them for each message, so changes apply at once. |
| `sinkUrl` | `""` | Where a lead goes once they leave an email or phone and have a real need. A POST with `sinkToken` as the Bearer token. Empty means no sink. |
| `linesKeptDays` | `30` | Chat lines older than this are deleted. |

## See what it did

- `metabot.db` holds one `events` row per message (outcome, label, time), the chat lines, and the drafts (`who = 'draft'`).
- `missed.jsonl` lists product questions the pack could not answer. Add the answers to the pack.
- The server prints one line per message to stderr: channel, kind and outcome.
