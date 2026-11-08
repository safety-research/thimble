// The words that name a look's messages (observer/messages.mjs): a catch-up is named as one of the replies since the
// analyst's last prompt, and a simpler version as one of the answer above it. Made-up data only.
// node --test plugin/observer/test/messages.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { messagesText } from '../messages.mjs'

const msg = { kind: 'answer', text: 'The build failed on three runs.', turnNo: 4, prompt: { text: 'why did it fail?', by: 'composer' } }

test('a simpler version is named as one of the answer above it, which still shows; a catch-up as one of the replies', () => {
  const simpler = messagesText([{ ...msg, catchUp: 'The build failed.', simpler: true }])
  assert.match(simpler, /A simpler version thimble wrote of Claude's answer at the end of turn 4/)
  assert.match(simpler, /below that answer, which still shows/)
  assert.doesNotMatch(simpler, /catch-up|in place of reading them/)
  assert.match(simpler, /The build failed\.$/)
  const caught = messagesText([{ ...msg, catchUp: 'Both: the build failed.' }])
  assert.match(caught, /A catch-up thimble wrote of Claude's messages since the analyst's last prompt/)
})
