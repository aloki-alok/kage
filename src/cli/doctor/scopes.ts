import { scopeLines } from '../../core/slack-scopes.ts'
import { checkScopes } from '../../runtime/slack-scopes.ts'
import { settings } from '../home.ts'
import type { Group } from './context.ts'

export const scopes: Group = async () => {
  const { user, bot } = settings().secrets.slack ?? {}
  return user && bot ? scopeLines(await checkScopes({ user, bot })) : []
}
