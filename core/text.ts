
export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
export const noChannelTag = (s: string) => s.replace(/<(\/?channel)/gi, '&lt;$1')
export const quotedLine = (s: string) => oneLine(noChannelTag(s))
