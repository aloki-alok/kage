
export type Bump = 'minor' | 'patch'
type Kind = 'new' | 'safety' | 'faster' | 'fixed' | 'internal'

const SECTIONS: [string, Kind][] = [['New features', 'new'], ['Access and safety', 'safety'], ['Optimizations', 'faster'], ['Bug fixes', 'fixed'], ['Under the hood', 'internal']]
const UPGRADING = '## Upgrading\nRun kage update --stable, or wait: a git install on main moves to this release within 6 hours.'

const SAFETY = /\b(refuses?|refused|trust|approvals?|permissions?|sandbox|secrets?|guard|access)\b/i
const INTERNAL = /^(merge|bump|release|docs?|ci|tests?|refactor|chore|build|move|split|drop|extract|rename|remove)\b|\badrs?\b/i

function kind(title: string): Kind {
  const type = /^(\w+)(\([^)]*\))?!?:/.exec(title)?.[1]?.toLowerCase()
  if (type === 'feat' || type === 'fix') return SAFETY.test(title) ? 'safety' : type === 'feat' ? 'new' : 'fixed'
  if (type === 'perf') return 'faster'
  if (type || INTERNAL.test(title)) return 'internal'
  if (SAFETY.test(title)) return 'safety'
  if (/\b(faster|cheaper)\b/i.test(title)) return 'faster'
  if (/^(fix|fixes|fixed|stop)\b/i.test(title)) return 'fixed'
  return 'new'
}

const plainTitle = (title: string) => title.replace(/^(feat|fix|perf|refactor|chore|ci|docs?|tests?|build)(\([^)]*\))?!?:\s*/i, '')

export function bumpVersion(version: string, bump: Bump): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) throw new Error(`"${version}" is not x.y.z`)
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return bump === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`
}

export function releasePlan(current: string, titles: string[]): { version: string; bump: Bump; notes: string } | undefined {
  if (!titles.length) return
  const bump: Bump = titles.some(t => kind(t) === 'new') ? 'minor' : 'patch'
  const sections = SECTIONS.map(([head, k]) => [head, titles.filter(t => kind(t) === k)] as const).filter(([, ts]) => ts.length)
    .map(([head, ts]) => `## ${head}\n${ts.map(t => `- ${plainTitle(t)}`).join('\n')}`)
  return { version: bumpVersion(current, bump), bump, notes: [...sections, UPGRADING].join('\n\n') }
}

export const RELEASE_CHECKS = ['ci.yml', 'upgrade.yml'] as const
export function checkProblems(sha: string, runs: Partial<Record<(typeof RELEASE_CHECKS)[number], string>>): string[] {
  return RELEASE_CHECKS.filter(w => runs[w] !== 'completed success').map(w => `${w} on ${sha.slice(0, 7)} is not green (${runs[w] ?? 'no run found'})`)
}
