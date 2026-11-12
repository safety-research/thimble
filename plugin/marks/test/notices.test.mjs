// What main reads after a check of its citations or a repair of one (marks/notices.mjs), from the registry's `notices`
// text: every part the module names is in the text, and the hooks tests' stub of the text is the text as the terminal
// reads it.
//   node --test plugin/marks/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'

import { textOf } from '../../prompts/node.mjs'
import { NOTICES } from '../../tests/stubs.ts'
import { partsOf, repairRequest } from '../notices.mjs'

const PARTS = ['frame', 'check', 'check asked', 'seen', 'unseen', 'check end', 'repair', 'repair auto', 'repair end',
  'corrected', 'narrowed', 'rewritten', 'not confirmed', 'wrong', 'verified', 'still not confirmed', 'still wrong',
  'not checked', 'not checked again', 'why', 'request', 'request auto', 'request not run', 'request stale',
  'request card ran', 'request stale also', 'request stale value', 'request where', 'found not confirmed', 'found wrong',
  'request task']

const parts = async mode => partsOf(await textOf('notices', mode))

test('the text holds every part the notices are built from, each with words', async () => {
  for (const mode of ['terminal', 'browser']) {
    const p = await parts(mode)
    for (const name of PARTS) assert.ok(p[name], `notices.md has the part ${name} (${mode})`)
  }
})

test("the hooks tests' stub of the text is the text as the terminal reads it", async () => {
  assert.equal(NOTICES, await textOf('notices', 'terminal'))
})

test("a stale citation's repair request names each card that ran again after the change, whose cells it may cite", async () => {
  const stale = { n: 2, words: '71', status: 'verified', sources: [{ file: 'runs.csv', path: '/made-up/runs.csv', changed: true }] }
  for (const mode of ['terminal', 'browser']) {
    const p = await parts(mode)
    const text = repairRequest(p, stale, 2, false, [], ['card:k3f9a1'])
    assert.match(text, /since runs\.csv changed after its first check\. .* thimble ran card:k3f9a1 again after that change, so its cells now hold the current values\. It may stand in an earlier reply/)
    // with no card that ran, the request names none
    assert.doesNotMatch(repairRequest(p, stale, 2), /thimble ran/)
  }
})

test("a stale citation's repair request asks for the sentence as the files are now, and only what was before in the reason", async () => {
  const stale = n => ({ n, words: '3 lines', status: 'verified', sources: [{ file: 'README.md', path: '/made-up/README.md', changed: true }] })
  for (const mode of ['terminal', 'browser']) {
    const p = await parts(mode)
    const [first, task] = repairRequest(p, stale(1), 1, false, [stale(2)]).split('\n')
    // after every citation the check takes, for all of them
    assert.match(first, /Check it again as well\. When a value the sentence states changed, correct the sentence to the value as it is now\. Say what it was before in `reason`, not in the sentence\.$/)
    assert.match(task, /^Check it again from the start\./)
  }
})
