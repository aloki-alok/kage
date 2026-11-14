// Whether the Slack app holds every scope Kage wants (core/slack-scopes.ts). Added last: it calls Slack twice.
import { scopeLines } from '../../core/slack-scopes.ts'
import { checkScopes } from '../../runtime/slack-scopes.ts'
import { settings } from '../home.ts'
import type { Group } from './context.ts'

export const scopes: Group = async () => {
  const { user, bot } = settings().secrets.slack ?? {}
  return user && bot ? scopeLines(await checkScopes({ user, bot })) : []
}
