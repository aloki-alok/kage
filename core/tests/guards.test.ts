import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { privateToolRefusal, slackSendRefusal, voiceToolRefusal } from '../guards.ts'

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
