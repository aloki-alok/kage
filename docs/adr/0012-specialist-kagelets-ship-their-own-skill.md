# 0012. A specialist kagelet ships with its own skill

Status: Accepted, applies from the meeting bot on

## Context

The shipped skills in `skills/` teach every new install what earlier Kage installs learned the hard way. A specialist kagelet, such as a meeting bot, has lessons only it needs. If those stay in one owner's private memory, each new install trains its own bot from zero.

## Decision

A specialist kagelet adds one skill under `skills/<name>/SKILL.md` in the same PR that adds the kagelet. The skill holds the rules for that job, each with its why in one line. It holds no names, ids, customers, dates or quotes (`core/skill-lessons.ts` is the check). The plugin loads it into every session, so a new install starts with a trained bot.

## Consequences

- A new kagelet is not done until its skill exists.
- The nightly dream may propose a new rule for the matching skill as a PR, on the repo owner's hub only. A person merges it.
- Skills cost context in every session, so one focused skill per specialist, not one per lesson.

## How it is checked

`runtime/tests/skills.test.ts` checks that each skill is named like its folder and holds no private detail. Whether a new kagelet has a skill is checked by hand in review.
