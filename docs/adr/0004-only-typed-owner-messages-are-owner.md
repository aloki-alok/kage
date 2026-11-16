# 0004. Only a message the owner typed counts as the owner

Status: Accepted. Known gap: a listed agent is `teammate` (#105). ADR 0018 lets a teammate answer a kagelet's held action inside the access the owner set.

## Decision

A task is `owner` only when the owner typed it. Slack requires `client_msg_id` and no `app_id` (`core/slack-message.ts`). Email is never the owner, whatever the address (`core/gate.ts`). A voice call is the owner only if Kage placed it and the voice connector flagged it. Agents, teammates, email and voice callers never count as the owner, so the owner's own forwarded email or script runs with teammate limits.

`senderOf` returns `owner`, `teammate` or `voice`. Every rule about guards, approvals, memory and config access keys off it.

## How it is checked

`core/tests/gate.test.ts` (`senderOf`).
