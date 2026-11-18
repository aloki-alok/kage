// npm test: today's behavior, one `node --test` over every file (the red baseline for #277).
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
const limit = Number(process.argv.find(a => a.startsWith('--limit='))?.slice(8) ?? 300) * 1000
const { NODE_TEST_CONTEXT: _, ...env } = process.env
const r = spawnSync(process.execPath, ['--test', `--test-timeout=${limit}`, ...args], { stdio: 'inherit', env })
process.exit(r.status ?? 1)
