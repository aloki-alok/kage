# 0006. Settings in `config.json`, tokens in `secrets.json`

Status: Accepted, in progress (#116)

## Context

`~/.config/kage/env` mixes 8 secrets with about 41 untyped settings. A typo in a name is ignored with no message. Only two settings apply without a restart.

## Decision

Settings go in `~/.config/kage/config.json`, typed by one schema. Tokens go in `~/.config/kage/secrets.json`, mode 600, and no session may read it, the owner's included. Kage posts to other channels with its own tool (`post_as_kage`, #133), not with a token a session holds. Code migrates the old `env` file once. It never passes through a Claude session.

## Consequences

- A bad key is refused with a message, and the last good config stays.
- Agents may read and edit `config.json`, but never the tokens.
- Until #116 merges, the env file is still the source (`config.ts`, `docs/settings.md`) and `core/guards.ts` `configRefusal` blocks non-owner tasks from the config folder.
- Cost: every setting read moves behind one loader, so each setting needs a small PR.

## How it is checked

Not yet enforced: issue #116. A guard test for the secrets file comes with it.
