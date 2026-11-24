# 0023. Slack reaches Kage by Socket Mode or by HTTP, and both feed one intake

Status: Accepted. Replaces the Socket Mode line in ADR 0002.

## Decision

- Slack reaches the hub by one transport at a time: Socket Mode, a connection the hub opens, or HTTP, where Slack calls the hub's `/slack` route. `slack.transport` picks it. `auto` picks HTTP only when the signing secret is saved and the hub has a public HTTPS route (`slack.publicUrl`, or the Slack route `kage tunnel on` recorded). Otherwise it picks Socket Mode, which needs no public address. (`src/core/slack-transport.ts`, `src/hub/config.ts`)
- Socket Mode keeps one connection, because Slack splits events across connections. A second `start()` while one opens leaves two. (`src/connectors/slack/connect.ts`, `src/connectors/slack/socket.ts`)
- Both transports hand each payload to the same listeners, under the names Socket Mode uses (`message`, `slash_commands`, `interactive`), with the same `ack`. Nothing below the transport knows which one carried it. (`src/connectors/slack/http.ts`, `src/connectors/slack/connect.ts`, `src/connectors/slack/commands.ts`)
- Over HTTP, the signing secret is the only gate. A request with no signature, or a timestamp more than 5 minutes from now, is refused before its body is read, and one whose `v0` signature does not match is refused after. A guard that cannot read the timestamp refuses. (`src/core/signature.ts`, `src/connectors/slack/http.ts`)
- Over HTTP, the 200 goes out at the ack, and the work runs after it, so Slack never waits 3 seconds. A listener that fails before its ack gets 500, so Slack sends the event again. (`src/connectors/slack/http.ts`)
- A message Slack sends twice, by a retry or by both transports, makes one task: the inbox row keyed on its channel and `ts` is written before the ack, and the second write finds it. (`src/connectors/slack/connect.ts`, `src/runtime/store.ts`)
- The catch-up read of watched channels runs each time the transport says it is connected: at each socket connect, and once at hub start over HTTP. (`src/connectors/slack/connect.ts`)

## How it is checked

`src/core/tests/signature.test.ts` and `src/core/tests/slack-transport.test.ts` test the signature, the timestamp window, what a request means and what `auto` picks. `src/connectors/slack/tests/http.test.ts` sends signed and unsigned requests to a real receiver. `src/connectors/slack/tests/transports.test.ts` sends one event twice through the real connector and store and counts one task, checks the catch-up at start, and sends one slash command and one button press over Socket Mode and over HTTP to the same handler.
