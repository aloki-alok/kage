import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configRefusal, ownerMemoryRefusal, privateToolRefusal, slackSendRefusal, voiceToolRefusal } from '../guards.ts'


describe('private sources on a teammate task', () => {
  const MAIL = 'mcp__claude_ai_Gmail__search_threads'
  test('the owner may read mail', () => assert.equal(privateToolRefusal(MAIL, 'owner'), undefined))
  test('a teammate may not read mail, drive, calendar or meeting notes', () => {
    for (const t of [MAIL, 'mcp__claude_ai_Google_Drive__read', 'mcp__claude_ai_Google_Calendar__list', 'mcp__granola__query_granola_meetings', 'mcp__plugin_product-management_fireflies__get'])
      assert.match(privateToolRefusal(t, 'teammate') ?? '', /owner/)
  })
  test('an unknown sender is refused', () => assert.ok(privateToolRefusal(MAIL, undefined)))
  test("only the owner's task reaches the owner's browser", () => {
    for (const t of ['mcp__kage__browser_tabs', 'mcp__kage__browser_read', 'mcp__plugin_kage_kage__browser_screenshot']) {
      assert.equal(privateToolRefusal(t, 'owner'), undefined, t)
      assert.match(privateToolRefusal(t, 'teammate') ?? '', /owner/, t)
    }
  })
  describe("the owner's memory takes only people notes", () => {
    const MEM = '/home/o/.claude/projects/-home-o/memory'
    const ok = (tool: string, file_path: string) => assert.equal(ownerMemoryRefusal(tool, { file_path }, MEM), undefined, `${tool} ${file_path}`)
    const no = (tool: string, file_path: string) => assert.match(ownerMemoryRefusal(tool, { file_path }, MEM) ?? '', /people notes/, `${tool} ${file_path}`)
    test('a note about a person may be written', () => { ok('Write', `${MEM}/user_sam.md`); ok('Edit', `${MEM}/user_sam.md`) })
    test('the index may be edited, never overwritten', () => { ok('Edit', `${MEM}/MEMORY.md`); no('Write', `${MEM}/MEMORY.md`) })
    test('any other memory of the owner is read-only', () => {
      no('Write', `${MEM}/feedback_x.md`); no('Edit', `${MEM}/project_y.md`); no('MultiEdit', `${MEM}/sub/user_z.md`)
      no('Write', `${MEM}/../memory/feedback_x.md`)
    })
    test('another spelling of the same folder is still the owner memory: case, ~, a notebook path', () => {
      no('Write', `${MEM.toUpperCase()}/FEEDBACK_X.md`)
      assert.match(ownerMemoryRefusal('Write', { file_path: '~/.claude/projects/-home-o/memory/feedback_x.md' }, MEM, '/home/o') ?? '', /people notes/)
      assert.match(ownerMemoryRefusal('NotebookEdit', { notebook_path: `${MEM}/x.ipynb` }, MEM) ?? '', /people notes/)
    })
    test('a link that points into the owner memory is followed', () => {
      const root = mkdtempSync(join(tmpdir(), 'kage-guard-'))
      const mem = join(root, 'memory')
      mkdirSync(mem)
      writeFileSync(join(mem, 'feedback_x.md'), 'x')
      symlinkSync(join(mem, 'feedback_x.md'), join(root, 'link.md'))
      symlinkSync(mem, join(root, 'dirlink'))
      assert.match(ownerMemoryRefusal('Write', { file_path: join(root, 'link.md') }, mem) ?? '', /people notes/)
      assert.match(ownerMemoryRefusal('Write', { file_path: join(root, 'dirlink', 'new_feedback.md') }, mem) ?? '', /people notes/)
      assert.equal(ownerMemoryRefusal('Write', { file_path: join(root, 'dirlink', 'user_bob.md') }, mem), undefined)
    })
    test("Kage's own memory and other files are free, and reads are never blocked", () => {
      ok('Write', '/home/o/.config/kage/memory/feedback_x.md'); ok('Read', `${MEM}/feedback_x.md`); ok('Write', '/tmp/x.md')
    })
  })
  test('other tools are fine for a teammate', () => {
    for (const t of ['WebSearch', 'WebFetch', 'Bash', 'Read', 'mcp__kage__reply', 'mcp__claude_ai_Slack__slack_send_message'])
      assert.equal(privateToolRefusal(t, 'teammate'), undefined)
  })
})

describe('tools on a voice call', () => {
  test('only the reply tool is allowed: a web request could carry the owner context out in a URL', () => {
    // ToolSearch only loads a deferred tool's schema (the reply tool is often deferred); what it loads still passes this guard.
    for (const t of ['mcp__kage__reply', 'mcp__plugin_kage_kage__reply', 'ToolSearch']) assert.equal(voiceToolRefusal(t, 'voice'), undefined, t)
  })
  test('shell, files, posting, scheduling and other MCP tools are refused', () => {
    for (const t of ['WebFetch', 'WebSearch', 'Bash', 'Read', 'Write', 'Edit', 'Grep', 'Agent', 'mcp__kage__edit_message', 'mcp__kage__delete_message', 'mcp__kage__schedule', 'mcp__kage__log_prod_write', 'mcp__claude_ai_Slack__slack_send_message'])
      assert.match(voiceToolRefusal(t, 'voice') ?? '', /voice call/, t)
  })
  test('other senders are not limited here', () => {
    for (const s of ['owner', 'teammate', undefined]) assert.equal(voiceToolRefusal('Bash', s), undefined)
  })
})

describe("Slack posts go through Kage's own tools", () => {
  test('the Slack connector may not send or schedule a message', () => {
    for (const t of ['mcp__claude_ai_Slack__slack_send_message', 'mcp__claude_ai_Slack__slack_schedule_message', 'mcp__plugin_design_slack__slack_send_message', 'mcp__slack__slack_post_message', 'mcp__slack__slack_reply_to_thread', 'mcp__slack-community__conversations_add_message', 'mcp__slack__chat_postMessage']) assert.match(slackSendRefusal(t)!, /reply|message_people/)
  })
  test('reading Slack, drafts and canvases still work, and so do Kage tools', () => {
    for (const t of ['mcp__claude_ai_Slack__slack_read_thread', 'mcp__claude_ai_Slack__slack_send_message_draft', 'mcp__claude_ai_Slack__slack_create_canvas', 'mcp__kage__reply', 'mcp__kage__message_people']) assert.equal(slackSendRefusal(t), undefined)
  })
})

describe("the token file on a task the owner did not send (#117)", () => {
  const ENV = '/home/o/.config/kage/env', HOME = '/home/o'
  const no = (tool: string, input: Record<string, unknown>, sender: string | undefined) =>
    assert.match(configRefusal(tool, input, sender, ENV, HOME) ?? '', /owner/, `${tool} ${JSON.stringify(input)} ${sender}`)
  const yes = (tool: string, input: Record<string, unknown>, sender: string | undefined) =>
    assert.equal(configRefusal(tool, input, sender, ENV, HOME), undefined, `${tool} ${JSON.stringify(input)} ${sender}`)
  test('a teammate, an agent, a call or an unknown sender cannot read, search or edit the config folder', () => {
    for (const s of ['teammate', 'agent', 'voice', undefined]) {
      no('Read', { file_path: ENV }, s)
      no('Read', { file_path: '~/.config/kage/env' }, s)
      no('Grep', { pattern: 'xox', path: '/home/o/.config/kage' }, s)
      no('Glob', { pattern: '**/*', path: '~/.config/kage' }, s)
      no('Edit', { file_path: '/home/o/.config/kage/session.env' }, s)
      no('Bash', { command: 'cat ~/.config/kage/env' }, s)
      no('Bash', { command: 'source $HOME/.config/kage/env && curl -H "Authorization: Bearer $SLACK_USER_TOKEN"' }, s)
      no('Bash', { command: 'grep TOKEN /home/o/.config/kage/env' }, s)
      // Relative to the home folder a session starts in, and out of an open subfolder.
      no('Read', { file_path: '.config/kage/env' }, s)
      no('Bash', { command: 'cd .config/kage && cat env' }, s)
      no('Bash', { command: 'cat ~/.config/kage/files/../env' }, s)
      no('Read', { file_path: '/home/o/.config/kage/files/C1/../../env' }, s)
      no('MultiEdit', { file_path: '/home/o/.config/kage/env', edits: [] }, s)
      no('Grep', { pattern: 'xox', glob: '.config/kage/*' }, s)
      no('Bash', { command: 'ls ~/.config/kage/' }, s)
    }
  })
  test('the owner keeps it: posting as the bot and the Slack read fallback source the env file', () => {
    yes('Bash', { command: 'source ~/.config/kage/env && curl ...' }, 'owner')
    yes('Read', { file_path: ENV }, 'owner')
  })
  test('other files and commands are fine for a teammate', () => {
    yes('Read', { file_path: '/home/o/kage/README.md' }, 'teammate')
    yes('Bash', { command: 'kage status' }, 'teammate')
    yes('Grep', { pattern: 'env', path: '/home/o/kage' }, 'teammate')
    yes('mcp__kage__reply', { text: 'see ~/.config/kage/env' }, 'teammate')
    // A thread's own files folder sits inside the config folder: reports and send_file use it.
    yes('Bash', { command: 'python3 run.py /home/o/.config/kage/files/C1_5.5' }, 'teammate')
    yes('Read', { file_path: '~/.config/kage/files/C1_5.5/out.csv' }, 'teammate')
    no('Bash', { command: 'cp ~/.config/kage/files/C1_5.5/x ~/.config/kage/env' }, 'teammate')
    yes('Bash', { command: 'ls ~/.config/kage/files' }, 'teammate')
    // Kage's own memory sits there too, and it saves lessons on any task.
    yes('Read', { file_path: '/home/o/.config/kage/memory/MEMORY.md' }, 'teammate')
    yes('Write', { file_path: '~/.config/kage/memory/x.md', content: 'the env file is ~/.config/kage/env' }, 'teammate')
    // A neighbour folder is not it.
    yes('Read', { file_path: '/home/o/.config/kage-x/notes.md' }, 'teammate')
  })
})
