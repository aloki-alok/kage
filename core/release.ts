
export type Bump = 'minor' | 'patch'
type Kind = 'new' | 'fixed' | 'other' | 'internal'

function kind(title: string): Kind {
  if (/^(merge|bump|release|docs?|ci|tests?|refactor|chore)\b|\badrs?\b/i.test(title)) return 'internal'
  if (/^(add|adds|new|let|allow|support)\b/i.test(title)) return 'new'
  if (/^(fix|fixes|fixed|stop)\b|\b(fix|fixes|fixed|refuse|refuses)\b/i.test(title)) return 'fixed'
  return 'other'
}

export function bumpVersion(version: string, bump: Bump): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) throw new Error(`"${version}" is not x.y.z`)
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return bump === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`
}

export function releasePlan(current: string, titles: string[]): { version: string; bump: Bump; notes: string } | undefined {
  if (!titles.length) return
  const by = (k: Kind) => titles.filter(t => kind(t) === k)
  const bump: Bump = by('new').length ? 'minor' : 'patch'
  const sections = ([['New', 'new'], ['Fixed', 'fixed'], ['Other', 'other']] as const)
    .filter(([, k]) => by(k).length)
    .map(([head, k]) => `## ${head}\n${by(k).map(t => `- ${t}`).join('\n')}`)
  return { version: bumpVersion(current, bump), bump, notes: sections.join('\n\n') || 'Internal changes only.' }
}

export const RELEASE_CHECKS = ['ci.yml', 'upgrade.yml'] as const
export function checkProblems(sha: string, runs: Partial<Record<(typeof RELEASE_CHECKS)[number], string>>): string[] {
  return RELEASE_CHECKS.filter(w => runs[w] !== 'completed success').map(w => `${w} on ${sha.slice(0, 7)} is not green (${runs[w] ?? 'no run found'})`)
}
