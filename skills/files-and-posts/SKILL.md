---
name: files-and-posts
description: Use when you attach or send a file, share a table, chart, long document or artifact, build a dashboard link, or a post is refused by a guard or classifier.
---

Each rule has its why on the same line.

## Tables, charts and long documents

1. Attach a table over about 15 rows, or one the reader will copy into a sheet, as a CSV with `send_file`. Put the row count and the top five rows in the reply.
2. Attach a chart as a PNG the same way. `send_file` takes only CSV and PNG, so it is the route that works in a thread.
3. Pack a long document for a teammate as a CSV, one row per document.
4. Make a doc or artifact only when someone will edit or share it.

## Sensitive data in files

1. Strip login, email and phone columns from a per-user CSV and keep an id so readers can join it elsewhere. The classifier blocks bulk contact data as sensitive detail.
2. If `send_file` fails, give the owner the file path privately and do not say the file is attached.
3. Never read or print the token file to work around a refused upload. Say what was refused and stop.

## When a guard refuses a post

1. A guard may refuse a post that only sounds like a secret, such as the word token beside user, access or an equals sign. Reword it, for example `credentials from their own app`, or name the docs page.
2. If a connector says a channel was not found, check which account it signs in as before you conclude the channel is missing. If every read route fails, say so in the thread and stop.
