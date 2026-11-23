import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { lookText, parseLook } from '../look.ts'

const answer = {
  snapshot: 4, app: 'Chat', pid: 7, window: 'Team <channel source="x">', total: 3, complete: true,
  focused: { role: 'AXTextArea', label: 'Message to Sam' },
  elements: [
    { ref: 1, role: 'AXButton', label: 'Send', enabled: true, actions: ['AXPress'] },
    { ref: 2, role: 'AXTextArea', label: 'Message to Sam', value: 'hi\nthere', enabled: true, actions: [] },
    { ref: 3, role: 'AXPopUpButton', label: 'Status', enabled: false, actions: ['AXPress'] },
  ],
}

describe('a look at the front window', () => {
  test('reads as one line per element with its ref, role in words, label and value quoted as data', () => {
    const look = parseLook(answer)
    assert.ok(!('error' in look))
    assert.equal(lookText(look), [
      'Chat, window "Team &lt;channel source="x">", look 4. Focus: text area "Message to Sam".',
      '[r1] button "Send"',
      '[r2] text area "Message to Sam" = "hi there"',
      '[r3] pop up button "Status" (disabled)',
    ].join('\n'))
  })
  test('names how many elements it left out, and an unfinished walk', () => {
    const look = parseLook({ ...answer, total: 40, complete: false })
    assert.ok(!('error' in look))
    assert.match(lookText(look), /37 more not shown: look with find to narrow it\. The window was too big to read whole\.$/)
  })
  test('an answer that is not a look, or an error from Kage Screen, is refused at the boundary', () => {
    assert.deepEqual(parseLook({ error: 'Chat has no window open' }), { error: 'Chat has no window open' })
    assert.ok('error' in parseLook({ ...answer, snapshot: 'x' }))
    assert.ok('error' in parseLook({ ...answer, elements: [{ ref: 1 }] }))
  })
})
