import { suggest } from './cli-help.ts'

type SettingDoc = { key: string; section: string; default: string; effect: string }

const plain = (md: string) => md.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/`/g, '').trim()
const firstSentence = (text: string) => /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text
const shown = (v: unknown) => typeof v === 'string' ? v : JSON.stringify(v)

export function settingDocs(md: string): SettingDoc[] {
  let section = ''
  const docs: SettingDoc[] = []
  for (const line of md.split('\n')) {
    if (line.startsWith('## ')) section = line.slice(3).trim()
    if (!line.startsWith('| `')) continue
    const [keys = '', fallback = '', ...rest] = line.replace(/^\||\|\s*$/g, '').split('|')
    const effect = rest.join('|')
    if (plain(effect).startsWith('secrets.json')) continue
    for (const [, key] of keys.matchAll(/`([^`]+)`/g)) docs.push({ key: key!, section, default: plain(fallback), effect: plain(effect) })
  }
  return docs
}

export function settingsOverview(docs: SettingDoc[], current: (key: string) => unknown): string[] {
  const lines: string[] = []
  for (const section of [...new Set(docs.map(d => d.section))]) {
    const rows = docs.filter(d => d.section === section).map(d => {
      const v = current(d.key)
      return { key: d.key, value: v === undefined ? d.default : `${shown(v)} (default ${d.default})`, what: firstSentence(d.effect) }
    })
    const k = Math.max(...rows.map(r => r.key.length)), w = Math.max(...rows.map(r => r.value.length))
    lines.push(section, ...rows.map(r => `  ${r.key.padEnd(k)}  ${r.value.padEnd(w)}  ${r.what}`), '')
  }
  return [...lines, 'kage config get <key> shows one in full. Every setting: docs/settings.md']
}

export function keyHelp(docs: SettingDoc[], key: string, current: unknown): string[] {
  const doc = docs.find(d => d.key === key)
  if (!doc) {
    const near = suggest(key, docs.map(d => d.key))
    return [`No setting ${key}. ${near ? `Did you mean ${near}?` : 'kage config list lists them all.'}`]
  }
  return [
    current === undefined ? `${key} is not set, so it is ${doc.default}` : `${key} = ${shown(current)} (default ${doc.default})`,
    doc.effect,
    `Change it: kage config set ${key} <value>`,
  ]
}
