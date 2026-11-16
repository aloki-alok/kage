# 0011. Every record of what Kage did lives in one place

Status: Accepted, partly built. Known debt: loose state files in the config folder (`boots`, `browser-seen`, `daily-sent`, `retro-sent`, `dream-sent`, `version`, `status`) until #119.

## Decision

What happened goes in the event log in `kage.db`, as names and outcomes, never content (ADR 0010). `hub.log` holds process output only. Loose state files move into `kage.db`. A new connector or kagelet writes its records to the event log, not to a new file. `kage top` and `kage logs` read that one source.

## How it is checked

Not yet enforced (#119, #52). By hand: once #119 lands, `ls ~/.config/kage` lists only config, secrets and `kage.db` files.
