# 0004. Only a message the owner typed counts as the owner

Status: Accepted

## Context

Anyone can post as the owner with a token, forward an email, or play a recording on a phone call. An agent can relay text it read elsewhere. If any of these counted as the owner, they could approve prompts and reach the owner's tools.

## Decision

A task is `owner` only when the owner typed it. Slack requires `client_msg_id` and no `app_id` (`core/slack-message.ts`). Email is never the owner, whatever the address (`core/gate.ts`). A voice call is the owner only if Kage placed it and the voice connector flagged it. Agents, teammates, email and voice callers never count as the owner. `senderOf` returns `owner`, `teammate` or `voice`.

## Consequences

- Every later rule (guards, approvals, memory, config access) keys off `senderOf`, so one function holds the line.
- Cost: the owner's own forwarded email or script runs with teammate limits.
- Known gap: a listed agent is `teammate` today. A separate `agent` sender is proposed in #105.

## How it is checked

`core/tests/gate.test.ts` (`senderOf`).
