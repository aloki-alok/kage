// What a release is: the next version and the notes, from the merged PR titles since the last release.

export type Bump = 'minor' | 'patch'
type Kind = 'new' | 'fixed' | 'other' | 'internal'

// Titles are plain sentences, so the first words decide. Internal work (docs, tests, ADRs, skills) is left out of the notes.
function kind(title: string): Kind {
  if (/^(merge|bump)\b/i.test(title)) return 'internal'
  if (/\b(adrs?|docs?|ci|tests?|refactor|skill|contributing)\b/i.test(title)) return 'internal'
  if (/^(fix|fixes|fixed|stop|refuse)\b|\b(fix|fixes|fixed|refuse|refuses|bug)\b/i.test(title)) return 'fixed'
  if (/^(add|adds|new|let|allow|support)\b/i.test(title)) return 'new'
  return 'other'
}

export function bumpVersion(version: string, bump: Bump): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) throw new Error(`"${version}" is not x.y.z`)
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return bump === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`
}

// No titles, no release. Any new feature is a minor release, anything else a patch.
export function releasePlan(current: string, titles: string[]): { version: string; bump: Bump; notes: string } | undefined {
  if (!titles.length) return
  const by = (k: Kind) => titles.filter(t => kind(t) === k)
  const bump: Bump = by('new').length ? 'minor' : 'patch'
  const sections = ([['New', 'new'], ['Fixed', 'fixed'], ['Other', 'other']] as const)
    .filter(([, k]) => by(k).length)
    .map(([head, k]) => `## ${head}\n${by(k).map(t => `- ${t}`).join('\n')}`)
  return { version: bumpVersion(current, bump), bump, notes: sections.join('\n\n') || 'Internal changes only.' }
}
