# Architecture decisions

Each file records one rule Kage follows, why, and how it is checked. Read the ones that bind the code you change. The skill `.claude/skills/kage-change-code/SKILL.md` says which.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-core-is-pure.md) | `src/core/` holds pure rules | Accepted, with known debt |
| [0002](0002-connectors-build-tasks.md) | Connectors build a `Task`. Core decides who may drive Kage | Accepted |
| [0003](0003-hub-writes-the-store.md) | The hub is the only writer of the store | Accepted |
| [0004](0004-only-typed-owner-messages-are-owner.md) | Only a message the owner typed counts as the owner | Accepted |
| [0005](0005-ceiling-per-sender.md) | One ceiling per kind of sender, enforced by the harness where it can | Accepted, not yet built |
| [0006](0006-config-and-secrets-files.md) | Settings in `config.json`, tokens in `secrets.json` | Accepted, in progress |
| [0007](0007-tests-beside-code.md) | Tests live in `<folder>/tests/` | Accepted |
| [0008](0008-auto-update-follows-stable.md) | Auto-update follows the `stable` tag | Accepted, amended by 0013 |
| [0009](0009-posts-go-through-kage-tools.md) | Every post goes through Kage's tools and the outbound checks | Accepted |
| [0010](0010-event-log-keeps-no-content.md) | The event log stores what happened, never what was said | Accepted |
| [0011](0011-one-place-for-records.md) | Every record of what Kage did lives in one place | Accepted, partly built |
| [0012](0012-specialist-kagelets-ship-their-own-skill.md) | A specialist kagelet ships with its own skill | Accepted, applies from the meeting bot on |
| [0013](0013-releases-are-made-by-the-owners-hub.md) | The owner's hub makes releases and moves `stable` | Accepted |
| [0014](0014-structure-is-a-test.md) | Structure rules are a test, and their debt only shrinks | Accepted |
| [0015](0015-monitors-climb-down-a-ladder.md) | Monitors climb down a ladder, and the hub records every step | Accepted |
| [0016](0016-a-kagelet-can-own-an-objective.md) | A kagelet can own an objective, measured by a number | Accepted |
| [0017](0017-a-twin-swaps-itself-when-the-hub-proves-it.md) | A twin swaps itself in when the hub proves it matches | Accepted |
| [0018](0018-a-kagelet-works-like-kage-under-kage.md) | A kagelet works like Kage, under Kage, and the person who asked answers its questions | Accepted |

## Format

Status, Decision, How it is checked. The Decision states the architecture as it is now: no history, no story, no numbers from one install. Add the next number. To change a decision, add a new ADR and mark the old one `Superseded by NNNN`.
| [0019](0019-telemetry-is-counts-only.md) | Telemetry sends counts and codes, never what Kage read | Accepted |
| [0020](0020-a-meta-bot-only-writes-text.md) | A Meta bot only writes text, and strangers never reach Kage | Accepted |
| [0021](0021-session-lifecycle-follows-claude-code.md) | A session's process lifecycle follows what Claude Code does (measured) | Accepted |
| [0022](0022-owner-stand-ins-are-read-only.md) | A stand-in that speaks as the owner is read-only and fails closed | Accepted |
| [0023](0023-slack-reaches-kage-by-socket-or-http.md) | Slack reaches Kage by Socket Mode or by HTTP, and both feed one intake | Accepted |
| [0024](0024-a-yes-is-kept-per-teammate.md) | A yes from the owner is kept per teammate, kind and reach | Accepted |
| [0025](0025-a-read-route-is-a-database-login-not-a-filter.md) | A read route is safe because of its database login, and a teammate's yes covers it | Accepted |
| [0026](0026-a-held-release-tells-the-owner.md) | A soaked commit that fails a release check tells the owner once | Accepted |
