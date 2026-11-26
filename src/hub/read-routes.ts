import { parseSessionKey } from '../core/conversations.ts'
import type { Config } from '../core/config.ts'

export const readRoutesFor = (key: string, config: Config) =>
  parseSessionKey(key)?.conversation.connector === 'slack' ? { dbRoutes: { routes: () => config.dbRead?.routes ?? {}, teammateRoutes: () => config.dbRead?.teammateRoutes ?? [], maxRows: config.dbRead?.maxRows || 200 } } : {}
