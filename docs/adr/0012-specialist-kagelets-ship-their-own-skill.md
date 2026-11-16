# 0012. A specialist kagelet ships with its own skill

Status: Accepted

## Decision

A specialist kagelet adds one skill under `skills/<name>/SKILL.md` in the same PR that adds the kagelet, so a new install starts with a trained kagelet. The kagelet is not done until its skill exists.

- The skill holds the rules for that job, each with its why in one line. It holds no names, ids, customers, dates or quotes (`core/skill-lessons.ts`).
- One focused skill per specialist, since every session loads it.
- The nightly dream may propose a new rule for the skill as a PR, on the repo owner's hub only. A person merges it.

## How it is checked

`tests/skills.test.ts` checks that each skill is named like its folder and holds no private detail. Whether a new kagelet has a skill is checked in review.
