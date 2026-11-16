# 0006. Settings in `config.json`, tokens in `secrets.json`

Status: Accepted, built (#116)

## Decision

Settings go in `~/.config/kage/config.json`, typed by one schema (`core/config.ts`). A bad key is refused with a message, and the last good config stays. Tokens go in `~/.config/kage/secrets.json`, mode 600, and no session may read it, the owner's included. Kage posts to other channels with its own tool (`post_as_kage`), not with a token a session holds.

Code imports the old `env` file once (`runtime/config-files.ts`). It never passes through a Claude session. `configRefusal` and `protectConfig` in `runtime/path-guards.ts` keep sessions out of the token files.

## How it is checked

`core/tests/config.test.ts` (schema, import table, settings doc). The token files' guards: `runtime/tests/sandbox.test.ts` and `runtime/tests/sandbox-off.test.ts` (live, see CONTRIBUTING).
