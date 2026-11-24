# 0006. Settings in `config.json`, tokens in `secrets.json`

Status: Accepted, built (#116)

## Decision

Settings go in `~/.config/kage/config.json`, typed by one schema (`src/core/config.ts`). A bad key is refused with a message, and the last good config stays. Tokens go in `~/.config/kage/secrets.json`, mode 600, and no session may read it, the owner's included. Kage posts to other channels with its own tool (`post_as_kage`), not with a token a session holds.

Code imports the old `env` file once (`src/runtime/config-files.ts`). It never passes through a Claude session. `configRefusal` and `protectConfig` in `src/runtime/path-guards.ts` keep sessions out of the token files.

## How it is checked

`src/core/tests/config.test.ts` (schema, import table, settings doc). The token files' guards: `src/runtime/tests/sandbox.test.ts` and `src/runtime/tests/sandbox-off.test.ts` (live, see CONTRIBUTING).

## File handling traps

- The CLI never prints a `secrets.*` value, and `config has` prints nothing, so a token never leaves the file. (`src/cli/config.ts`)
- A parse error names the file and key, never the value. A `SyntaxError` quotes file text, so only the line is logged. (`src/runtime/config-files.ts`)
- A config write is checked against the schema first, then written beside the file and moved over it, always mode 600. (`src/runtime/config-files.ts`)
- A crash after `config.json` is written and before the env rename leaves plaintext tokens. `config.json` wins, so only rename. (`src/runtime/config-files.ts`)
- A changed config key restarts the hub when quiet. A wrong file is refused, the last good settings stay, and events hold key names only. (`src/runtime/config-watch.ts`)
- `hub.ts` and `src/runtime/hold-keys.ts` import only Node modules, so they load even when the packages are broken. (`hub.ts`, `src/runtime/hold-keys.ts`)
- Keys in `sessionKeys` leave the environment before any session copies it. If the proxy fails to load, they are still removed. (`hub.ts`, `src/runtime/hold-keys.ts`)
- The key proxy does not follow redirects, so a key never goes elsewhere. The SSM relay and proxy sockets are created mode 600. (`src/runtime/key-proxy.ts`, `src/runtime/ssm-relay.ts`)
- `owner.key` gets the same closing as `secrets.json`: the Read and Edit deny rules, the sandbox `denyRead` and `denyWrite`, and `configRefusal`. The `kage` commands read it, so a session that could read it could speak as the owner (ADR 0004). (`src/runtime/owner-key.ts`, `src/runtime/path-guards.ts`)
- The SSM relay re-checks owner-only trust on every connection and never logs the token, stream URL or bytes. (`src/runtime/ssm-relay.ts`, `src/core/ssm.ts`)
- A path match cannot stop a shell. Only the OS sandbox is a wall. It covers the threads `harness.sandbox` walls (by default, every thread the owner did not start), and in any other thread a reworded command gets past `configRefusal`. (`src/runtime/path-guards.ts`)
- A shell sandbox passes one `--settings` flag, because a second flag would replace the first. (`src/runtime/tmux-panes.ts`)
- A `.new` swapped-in file written through a link is a trap, so kagelet files are written as a fresh copy and swapped in. (`src/runtime/kagelets/files.ts`, `src/runtime/kagelets/memory.ts`)
