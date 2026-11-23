import { SECRETS, type Secret } from '../core/secret-prompt.ts'
import { askSecret } from '../runtime/terminal-secret.ts'

const [kind = '', label = ''] = process.argv.slice(2)
const want = (SECRETS as Record<string, Secret>)[kind]
if (!want) { console.error(`usage: ask-secret.ts <${Object.keys(SECRETS).join('|')}> <label>`); process.exit(2) }
const value = await askSecret(label, want)
if (!value) process.exit(1)
process.stdout.write(`${value}\n`)
