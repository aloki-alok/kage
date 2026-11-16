# 0019. Telemetry sends counts and codes, never what Kage read

Status: Accepted. The `report_bug` tool is not built.

## Decision

An install may send telemetry to one OTLP endpoint (`telemetry.endpoint`). Two layers go there:

| Layer | Source | What leaves |
|---|---|---|
| Kage | event rows, through `core/telemetry.ts` `toTelemetry` | per kind, fixed words and numbers only: a run's cost and trigger, a tool's outcome, a tripwire's action and duration, a crash fingerprint |
| Claude Code | each session's own OpenTelemetry, logs only | cost, tokens, tool names and results, API errors. Prompts, replies and tool input stay redacted: no `OTEL_LOG_*` flag is ever set |

Claude Code's layer also carries the signed-in account: email, account and organization ids, and the names of loaded plugins and MCP servers (seen on a real run, 2026-11-16). Kage cannot strip them on the way out, so the Kage receiver (`https://monitor.omnidim.io/kage`) keeps only an allow list of fields per service before storing: for Claude Code, counts, model, timing and outcome.

Never sent by Kage's layer: `who`, `trace`, `chain`, `transcript`, the `detail` text, message text, names, ids, emails and paths. A record is tied only to a random install id in `telemetry-id`.

Turned on, an install sends only what happens after: the cursor starts at the newest row. The owner turns it off with `telemetry.on: false`, `KAGE_TELEMETRY=off` or `DO_NOT_TRACK`. A receiver answering 410 stops every install sending until its next start.

## Why

Without it, nobody but the owner's own hub tells us what breaks. Kage reads private messages, so one leaked line costs more than all the counts are worth: the allowlist is by type, so free text cannot pass at all.

## How it is checked

`core/tests/telemetry.test.ts` plants names, Slack ids, an email, a path, a secret and message text in every event kind and asserts none of it leaves, and that every string value is a fixed word. It also asserts the session env sets no content flag. `runtime/tests/telemetry-export.test.ts` checks the cursor, the 410 stop and the batch cap.
