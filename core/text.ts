// Text helpers every rule shares.

// Whitespace and newlines collapsed to single spaces, trimmed: text fit for one log or caption line.
export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
// Text from outside can neither open nor close the <channel> tag Claude reads tasks in.
export const noChannelTag = (s: string) => s.replace(/<(\/?channel)/gi, '&lt;$1')
// Someone else's text as one line with any <channel> tag removed, so a quote can never pose as a task.
export const quotedLine = (s: string) => oneLine(noChannelTag(s))
