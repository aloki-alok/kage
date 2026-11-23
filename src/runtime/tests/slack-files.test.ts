import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { saveFiles } from '../slack-files.ts'
import { MAX_FILES, type SlackFile } from '../../core/slack-files.ts'

const file = (id: string, over: Partial<SlackFile> = {}): SlackFile => ({ id, name: `${id}.txt`, filetype: 'text', mimetype: 'text/plain', size: 5, url_private: `https://files.slack.com/files-pri/T1-${id}/${id}.txt`, ...over })
const serve = (calls: { url: string; auth: string | null }[]) => (async (url: string, init?: RequestInit) => {
  calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
  return new Response(`body of ${url.split('/').pop()}`, { headers: { 'content-type': 'text/plain' } })
}) as unknown as typeof fetch

describe('saveFiles', () => {
  test('downloads with the user token into the folder and lists the file by absolute path', async () => {
    const dir = mkdtempSync(`${tmpdir()}/kage-files-`), calls: { url: string; auth: string | null }[] = []
    const text = await saveFiles([file('F1')], { folder: `${dir}/files/C1_1.5`, token: 'xoxp-test', fetch: serve(calls) })
    assert.deepEqual(calls.map(c => c.auth), ['Bearer xoxp-test'])
    assert.equal(readFileSync(`${dir}/files/C1_1.5/F1-F1.txt`, 'utf8'), 'body of F1.txt')
    assert.ok(text.includes(`${dir}/files/C1_1.5/F1-F1.txt (F1.txt, text/plain, 14 B)`))
  })
  test('more than the cap downloads only the first 10 and names the rest', async () => {
    const dir = mkdtempSync(`${tmpdir()}/kage-files-`), calls: { url: string; auth: string | null }[] = []
    const text = await saveFiles(Array.from({ length: MAX_FILES + 1 }, (_, i) => file(`F${i}`)), { folder: dir, token: 't', fetch: serve(calls) })
    assert.equal(calls.length, MAX_FILES)
    assert.match(text, /Not saved: F10\.txt/)
  })
  test('an oversize file is never requested', async () => {
    const dir = mkdtempSync(`${tmpdir()}/kage-files-`), calls: { url: string; auth: string | null }[] = []
    const text = await saveFiles([file('F1', { size: 26 * 1024 * 1024 })], { folder: dir, token: 't', fetch: serve(calls) })
    assert.equal(calls.length, 0)
    assert.match(text, /F1\.txt.*25 MB/)
  })
  test('a download that returns a login page is not saved and is named', async () => {
    const dir = mkdtempSync(`${tmpdir()}/kage-files-`)
    const html = (async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
    const text = await saveFiles([file('F1')], { folder: dir, token: 't', fetch: html })
    assert.ok(!existsSync(`${dir}/F1-F1.txt`))
    assert.match(text, /Not saved: F1\.txt \(download failed\)/)
  })
  test('no files: no request, no folder, empty text', async () => {
    const calls: { url: string; auth: string | null }[] = []
    assert.equal(await saveFiles([], { folder: '/nonexistent/x', token: 't', fetch: serve(calls) }), '')
    assert.equal(calls.length, 0)
  })
})
