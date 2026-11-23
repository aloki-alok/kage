# 0020. A Meta bot only writes text, and strangers never reach Kage

Status: Accepted.

## Decision

The Meta bot (`metabot/`) answers members of the public on a Facebook Page, in Instagram DMs and under Page comments. Anyone can write to it, so it holds no power at all:

| Rule | Where |
|---|---|
| It is its own process. It loads only `metabot/` and pure `src/core/` files, never the hub, a session, a connector or the CLI. | `metabot/server.ts` |
| Its model request carries messages only: no tools, functions or tool choice. One reply and one label come back as JSON. | `metabot/model.ts` |
| The lead's words are user turns. The engine rules come first in the system turn, and a job file only adds to them. | `metabot/prompt.ts` `chatMessages` |
| A fixed check holds a reply with a link outside `links.md`, a price not written in the pack, a secret, or too many characters. A second model must answer `SEND`. Both fail closed. | `metabot/prompt.ts` `checkAnswer`, `guardMessages` |
| It sends only in `team` (to listed testers) or `live` mode. A missing or wrong mode reads as `dry`. | `metabot/decide.ts` `sendsTo`, `metabot/config.ts` |
| A person who answers in the Meta inbox takes the thread for `humanQuietHours`. | `metabot/decide.ts` `decide` |

What it learns arrives as text files: the owner, or a kagelet on Kage's review, edits the pack. The bot never writes to the pack itself. It logs questions it could not answer to `missed.jsonl`.

## How it is checked

`metabot/tests/structure.test.ts` walks every import the bot reaches and fails on a file outside `metabot/` and `src/core/`, on a node module outside a short list (no `child_process`, `vm` or `worker_threads`), and on any name that runs a process or code. It plants each of those and checks that the test catches it. `metabot/tests/graph.test.ts` checks that the model request has no tool field. `metabot/tests/reply.test.ts` checks that `dry` and `team` never send to a lead, and that a check or a guard hold sends nothing but the owner's fallback line.
