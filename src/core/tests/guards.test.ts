import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { agentToolRefusal, privateToolRefusal, slackSendRefusal, voiceToolRefusal, mcpToolRefusal, sandboxed } from '../guards.ts'

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
  test("only the owner's task reaches the owner's screen", () => {
    for (const t of ['mcp__kage__screen_shot', 'mcp__plugin_kage_kage__screen_record', 'mcp__kage__screen_act']) {
      assert.equal(privateToolRefusal(t, 'owner'), undefined, t)
      assert.match(privateToolRefusal(t, 'teammate') ?? '', /owner/, t)
    }
  })
  test('other tools are fine for a teammate', () => {
    for (const t of ['WebSearch', 'WebFetch', 'Bash', 'Read', 'mcp__kage__reply', 'mcp__claude_ai_Slack__slack_send_message'])
      assert.equal(privateToolRefusal(t, 'teammate'), undefined)
  })
})

describe('tools on a voice call', () => {
  test('only the reply tool is allowed: a web request could carry the owner context out in a URL', () => {
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

describe("an agent's task may read and answer, nothing more", () => {
  test('reading files and answering in the thread are allowed', () => {
    for (const t of ['Read', 'Grep', 'Glob', 'ToolSearch', 'TodoWrite', 'mcp__kage__reply', 'mcp__kage__edit_message', 'mcp__plugin_kage_kage__reply'])
      assert.equal(agentToolRefusal(t, 'agent'), undefined, t)
  })
  test('shell, edits, web, other MCP tools, subagents, posting as the owner and schedules are refused before any card', () => {
    for (const t of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task',
      'mcp__claude_ai_OmniDimension__dispatchCall', 'mcp__grafana__query_loki_logs', 'mcp__kage__message_people', 'mcp__kage__schedule',
      'mcp__kage__send_file', 'mcp__kage__delete_message', 'mcp__kage__set_model'])
      assert.match(agentToolRefusal(t, 'agent') ?? '', /only read and answer/, t)
  })
  test('the owner, a teammate and a voice call are not limited by this rule', () => {
    for (const s of ['owner', 'teammate', 'voice', undefined]) assert.equal(agentToolRefusal('Bash', s), undefined)
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

describe("MCP tools on a task not from the owner: Kage's own and the owner's shared list only (#271)", () => {
  const shared = ['mcp__claude_ai_Claude_Docs__', 'mcp__slack__slack_read_']
  test("a claude.ai connector acts as the owner's account, so a teammate never gets it, even listed", () => {
    for (const t of ['mcp__claude_ai_Claude_Docs__batch', 'mcp__claude_ai_Acme_CRM__getDeal'])
      assert.match(mcpToolRefusal(t, 'teammate', [...shared, 'mcp__claude_ai_']) ?? '', /owner's own account/, t)
    assert.equal(mcpToolRefusal('mcp__claude_ai_Acme_CRM__getDeal', 'owner', shared), undefined)
  })
  test('a server nobody listed is refused for a teammate or an email task, and the owner uses it', () => {
    assert.match(mcpToolRefusal('mcp__new_crm__read_deals', 'teammate', shared) ?? '', /shares/)
    assert.match(mcpToolRefusal('mcp__new_crm__read_deals', undefined, shared) ?? '', /shares/)
    assert.equal(mcpToolRefusal('mcp__new_crm__read_deals', 'owner', shared), undefined)
  })
  test("Kage's own tools, a listed prefix and the built-in tools pass", () => {
    for (const t of ['mcp__kage__reply', 'mcp__plugin_kage_kage__reply', 'mcp__slack__slack_read_thread', 'Read', 'Bash'])
      assert.equal(mcpToolRefusal(t, 'teammate', shared), undefined, t)
  })
  test('a listed prefix covers only what it names', () => {
    assert.match(mcpToolRefusal('mcp__slack__slack_send_message', 'teammate', shared) ?? '', /shares/)
  })
})

describe('a trusted teammate (#425)', () => {
  test("may use the owner's connected accounts and other MCP tools", () => {
    assert.equal(privateToolRefusal('mcp__claude_ai_Gmail__search', 'trusted'), undefined)
    assert.equal(mcpToolRefusal('mcp__claude_ai_Gmail__search', 'trusted'), undefined)
    assert.equal(mcpToolRefusal('mcp__new_crm__read_deals', 'trusted'), undefined)
  })
  test('a plain teammate still may not', () => {
    assert.match(mcpToolRefusal('mcp__claude_ai_Gmail__search', 'teammate')!, /owner's own account/)
  })
})

test('the OS sandbox: unset means teammates, so only a thread the owner did not start is walled; true walls all, false none (#313)', () => {
  assert.equal(sandboxed(undefined, false), true)
  assert.equal(sandboxed(undefined, true), false)
  assert.equal(sandboxed('teammates', false), true)
  assert.equal(sandboxed('teammates', true), false)
  assert.equal(sandboxed(true, true), true)
  assert.equal(sandboxed(false, false), false)
})
