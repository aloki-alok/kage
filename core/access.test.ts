import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { kageletTier } from './access.ts'

describe('a kagelet tool\'s tier comes from its name, never from the model', () => {
  test('the web tools and db_read are read', () => {
    for (const t of ['WebSearch', 'WebFetch', 'db_read']) assert.equal(kageletTier(t), 'read', t)
  })
  test('an MCP tool that only looks is read', () => {
    for (const t of ['mcp__notion__search', 'mcp__claude_ai_Docs__read', 'mcp__gmail__list_messages', 'mcp__linear__getIssue', 'mcp__github__get_pull_request'])
      assert.equal(kageletTier(t), 'read', t)
  })
  test('an MCP tool that sends or changes something internal is write, and so is a name it cannot place', () => {
    for (const t of ['mcp__gmail__send', 'mcp__notion__update_page', 'mcp__slack__post_message', 'mcp__linear__create_issue', 'mcp__x__get_or_create_label', 'mcp__x__notify', 'mcp__x__find_replace', 'mcp__x__get_upsert'])
      assert.equal(kageletTier(t), 'write', t)
  })
  test('prod, money, customers, access and deletes are act, even behind a read verb', () => {
    for (const t of ['mcp__stripe__create_refund', 'mcp__db__execute_sql', 'mcp__drive__delete_file', 'mcp__github__merge_pull_request', 'mcp__team__invite_member', 'mcp__crm__list_customers', 'mcp__x__get_and_delete'])
      assert.equal(kageletTier(t), 'act', t)
  })
  test('Kage\'s own tools and every other built-in tool are act, so no kagelet holds one', () => {
    for (const t of ['Bash', 'Read', 'Write', 'Edit', 'Agent', 'Task', 'Skill', 'mcp__kage__message_people', 'mcp__plugin_kage_kage__reply', 'mcp__kage__db_read'])
      assert.equal(kageletTier(t), 'act', t)
  })
})
