# 0006. Settings in `config.json`, tokens in `secrets.json`

Status: Accepted, built (#116)

## Decision

Settings go in `~/.config/kage/config.json`, typed by one schema (`core/config.ts`). A bad key is refused with a message, and the last good config stays. Tokens go in `~/.config/kage/secrets.json`, mode 600, and no session may read it, the owner's included. Kage posts to other channels with its own tool (`post_as_kage`), not with a token a session holds.

Code imports the old `env` file once (`runtime/config-files.ts`). It never passes through a Claude session. `configRefusal` and `protectConfig` in `runtime/path-guards.ts` keep sessions out of the token files.

## How it is checked

`core/tests/config.test.ts` (schema, import table, settings doc). The token files' guards: `runtime/tests/sandbox.test.ts` and `runtime/tests/sandbox-off.test.ts` (live, see CONTRIBUTING).

## File handling traps

- The CLI never prints a `secrets.*` value, and `config has` prints nothing, so a token never leaves the file. (`cli/config.ts`)
- A parse error names the file and key, never the value. A `SyntaxError` quotes file text, so only the line is logged. (`runtime/config-files.ts`)
- A config write is checked against the schema first, then written beside the file and moved over it, always mode 600. (`runtime/config-files.ts`)
- A crash after `config.json` is written and before the env rename leaves plaintext tokens. `config.json` wins, so only rename. (`runtime/config-files.ts`)
- A changed config key restarts the hub when quiet. A wrong file is refused, the last good settings stay, and events hold key names only. (`runtime/config-watch.ts`)
- `hub.ts` and `runtime/hold-keys.ts` import only Node modules, so they load even when the packages are broken. (`hub.ts`, `runtime/hold-keys.ts`)
- Keys in `sessionKeys` leave the environment before any session copies it. If the proxy fails to load, they are still removed. (`hub.ts`, `runtime/hold-keys.ts`)
- The key proxy does not follow redirects, so a key never goes elsewhere. The SSM relay and proxy sockets are created mode 600. (`runtime/key-proxy.ts`, `runtime/ssm-relay.ts`)
- The SSM relay re-checks owner-only trust on every connection and never logs the token, stream URL or bytes. (`runtime/ssm-relay.ts`, `core/ssm.ts`)
- A path match cannot stop a shell. Only the OS sandbox is a wall. It covers the threads `harness.sandbox` walls (by default, every thread the owner did not start), and in any other thread a reworded command gets past `configRefusal`. (`runtime/path-guards.ts`)
- A shell sandbox passes one `--settings` flag, because a second flag would replace the first. (`runtime/tmux-panes.ts`)
- A `.new` swapped-in file written through a link is a trap, so kagelet files are written as a fresh copy and swapped in. (`runtime/kagelets/files.ts`, `runtime/kagelets/memory.ts`)
