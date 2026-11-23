import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalPreview } from '../preview.ts'

test('a shell command shows as itself, with real line breaks, not as escaped JSON', () => {
  assert.equal(approvalPreview('Bash', { command: 'cd /srv &&\n  ./deploy.sh "prod"', description: 'Deploy' }), 'cd /srv &&\n  ./deploy.sh "prod"')
})

test('an edit shows the file, then the lines it removes and adds', () => {
  assert.equal(
    approvalPreview('Edit', { file_path: '/a/b.py', old_string: 'x = 1\ny = 2', new_string: 'x = 3' }),
    '/a/b.py\n- x = 1\n- y = 2\n+ x = 3',
  )
  assert.equal(
    approvalPreview('MultiEdit', { file_path: '/a/b.py', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }),
    '/a/b.py\n- a\n+ b\n\n- c\n+ d',
  )
})

test('a new file shows its path, then its content', () => {
  assert.equal(approvalPreview('Write', { file_path: '/a/n.md', content: '# Title\nbody' }), '/a/n.md\n# Title\nbody')
})

test('any other tool shows one field per line, long text kept whole', () => {
  assert.equal(
    approvalPreview('mcp__claude_ai_Slack__slack_send_message', { channel_id: 'C1', message: 'Hi team\nline 2', unfurl: false, blocks: [1] }),
    'channel_id: C1\nmessage: Hi team\n  line 2\nunfurl: false\nblocks: [1]',
  )
})
