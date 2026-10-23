// The names thimble gives its records (core/layout.mjs) and a text's width (core/text.js). The kernel makes the same
// names (plugin/tests/test_store.py checks the same two values). All paths are made up.
//   node --test plugin/core/test/layout.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { conversationDir, folderName, safeName, shortHash } from '../layout.mjs'
import { cut, textWidth } from '../text.js'

test('a name holds letters, digits, - and _ only, at most 80 of them, and two folders whose paths differ only in characters a name cannot hold get names of their own', () => {
  // two folders whose paths differ only in characters a name cannot hold get names of their own
  {
    const names = ['/w/run.1', '/w/run-1', '/w-run/1'].map(folderName)
    assert.equal(new Set(names).size, 3)
    assert.equal(folderName('/w/run.1'), 'w-run-1-b8a5493c96fe')
    assert.equal(shortHash('toolu_01ABC'), '12a499106e46')
  }
  // a name holds letters, digits, - and _ only, and at most 80 of them
  {
    assert.equal(safeName('a/b c.d'), 'a-b-c-d')
    assert.equal(safeName('x'.repeat(100)).length, 80)
    assert.equal(conversationDir('/made-up/th/', 's 1'), '/made-up/th/conversations/s-1')
  }
})

test('a wide character takes two cells and a combining mark none; cut ends in … within its cells', () => {
  assert.equal(textWidth('名前 ok'), 7)
  assert.equal(textWidth('é'), 1)
  assert.equal(cut('名前 ok', 4), '名…')
  assert.equal(cut('short', 9), 'short')
})
