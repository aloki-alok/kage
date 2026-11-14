// Saves a task's Slack files into the thread's files folder, with the user token. Sessions have no token to do it.
import { mkdirSync, writeFileSync } from 'node:fs'
import { log } from '../config.ts'
import { MAX_FILE_BYTES, downloadUrl, fileLines, planFiles, savedName, type Saved, type SlackFile } from '../core/slack-files.ts'

// Returns the lines for the task text: each saved file by path, name, type and size, and what was skipped.
export async function saveFiles(files: SlackFile[], o: { folder: string; token: string; fetch?: typeof fetch }): Promise<string> {
  const { fetch: plan, skipped } = planFiles(files)
  const saved: Saved[] = []
  if (plan.length) mkdirSync(o.folder, { recursive: true, mode: 0o700 })
  for (const f of plan) {
    const name = f.name || f.id || 'file'
    try {
      const r = await (o.fetch ?? fetch)(downloadUrl(f), { headers: { Authorization: `Bearer ${o.token}` }, redirect: 'error', signal: AbortSignal.timeout(60_000) })
      const body = Buffer.from(await r.arrayBuffer())
      // A bad token or a missing scope answers 200 with a sign-in page.
      if (!r.ok || (r.headers.get('content-type')?.startsWith('text/html') && f.mimetype !== 'text/html') || body.length > MAX_FILE_BYTES) throw new Error(`status ${r.status}, ${body.length} bytes`)
      const path = `${o.folder}/${savedName(f)}`
      writeFileSync(path, body, { mode: 0o600 })
      saved.push({ path, name, type: f.mimetype || f.filetype || 'unknown', size: body.length })
    } catch (e) {
      log(`could not save Slack file ${f.id ?? ''}`, e instanceof Error ? e.message : e)
      skipped.push(`${name} (download failed)`)
    }
  }
  return fileLines(saved, skipped)
}
