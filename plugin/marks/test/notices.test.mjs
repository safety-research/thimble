// What main reads after a check of its citations or a repair of one (marks/notices.mjs), from the registry's `notices`
// text: every part the module names is in the text, and the hooks tests' stub of the text is the text as the terminal
// reads it.
//   node --test plugin/marks/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'

import { textOf } from '../../prompts/node.mjs'
import { NOTICES } from '../../tests/stubs.ts'
import { partsOf } from '../notices.mjs'

const PARTS = ['frame', 'check', 'check asked', 'seen', 'unseen', 'check end', 'repair', 'repair auto', 'repair end',
  'corrected', 'narrowed', 'rewritten', 'not confirmed', 'wrong', 'verified', 'still not confirmed', 'still wrong',
  'not checked', 'not checked again', 'why', 'request', 'request auto', 'request not run', 'request where',
  'found not confirmed', 'found wrong', 'request task']

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
