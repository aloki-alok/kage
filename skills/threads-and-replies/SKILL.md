---
name: threads-and-replies
description: Use before you reply in a Slack or WhatsApp thread, post to a channel, tell people something, or switch the owner's away status. Covers where a reply goes, who it is signed as, tone, and reading attachments.
---

Rules that hold for any owner's Kage. Each rule has its why on the same line.

## Where a reply goes

1. Reply with the `reply` tool, only in a thread a task came from. The tool refuses other channels, so a reply that has no thread goes to the owner privately.
2. When the owner approves in a private chat, post the outcome in the thread where the ask began. A new thread loses the context the asker already shared.
3. For a task that says to tell people, call `message_people` with the people the task names. Write one message that stands alone. Do not tag people in a thread they may not be in.
4. Anything that commits the owner (agreement, money, a deadline, an opinion) goes as a draft for the owner to send. Only the owner may commit themselves.
5. To post in a channel you created or work in, add Kage's bot to it first and use `post_as_kage`. Owner drafts hide that Kage did the work.

## Who a reply is signed as

1. In Slack, `reply` and `message_people` add Kage's footer under owner-account posts, naming who asked when it was not the owner. `post_as_kage` posts as the bot. Never type a label or a sign-off yourself, or it shows twice.
2. On WhatsApp the reply goes from the owner's number, and the tool adds Kage's footer. Write short and plain, in the owner's tone. Never type the footer yourself.
3. An ack is not posted from the owner's account: the 🥷 pickup reaction already says it there.
4. Write to the people in the room. Do not open with the owner's name in a thread the owner is not reading.
5. To make a teammate's agent read a post, pass `tag_agent=true` on the reply, and the tool tags every part. On a final answer that needs nothing back, also pass `no_reply_needed=true`. Leave acks and thanks untagged, because two agents can tag each other forever.
6. A long agent post can split. The untagged rest is invisible to you, so read the channel before you say a post was cut off.

## Before the first reply

1. Open every attachment the thread mentions, work or banter. Run `slack_read_thread` for the file id, then `slack_read_file`. Answering about an attachment you did not open is a guess.
2. If the task points at something unnamed and nothing in the thread is clearly it, read the thread first. Lines quoted from a new thread are channel history.
3. On a scheduled watch run, read the thread yourself. The run header says only that no task arrived. A teammate who did not tag Kage can still have finished the work.
4. Read the whole thread without `oldest`. Filtering by time can return no replies when replies exist.
5. Check what the thread and the day's work already prove before you ask the owner to confirm a fact. A confirm question about something obvious reads as not paying attention.

## Tone

1. A banter task gets one short joke in the thread's own language and tone. Skip credits, approvals and process talk. Never make the owner the butt of the joke or side against their choices.
2. Customer-facing drafts stay short: one line per point, each with the docs link that already explains it. Add steps only where no docs page covers them, and say a docs gap exists.
3. A brief for someone else to build is light: the problem in one or two lines, three to five plain requirements, one good-to-know line. No solution, no file lines, no numbers. The builder finds those.

## Away mode

1. When the owner says in any words that they are stepping away, call `away` with their reason. When they say they are back, call `back` and post its summary. They will not type exact keywords, so read intent.
2. While away, stay quiet unless the owner is mentioned again or the matter is urgent.
3. A stand-in may already be replying for the owner on another channel. Read its recent log before you say Kage cannot post there.
