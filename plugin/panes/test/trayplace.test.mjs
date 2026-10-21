// The tray on a mark of an earlier reply says where that reply is, since a key cannot scroll the chat to it.
//   node --test panes/test/trayplace.test.mjs
import '../../test-home.mjs'
import '../../draw/kit.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { program } from '../tray.js'

const DK = globalThis.DrawKit
const STACK = [{ row: 'm2', i: 0, kind: 'cite', ref: 'notes/plan.txt#L12', label: 'plan.txt:12' }]
const CARD = { title: 'plan.txt:12', right: 'cite · notes/plan.txt', drawings: [], sections: [], links: [] }

const rightOf = steps => {
  const opts = { w: 80, h: 14, mode: 'pane', state: { stack: STACK } }
  const want = DK.run(program, { threads: [], steps }, opts).wants[0].key
  const d = DK.run(program, { threads: [], steps }, { ...opts, got: { [want]: CARD } })
  assert.equal(d.error, undefined, d.error && d.error.message)
  const frames = []
  const walk = n => { if (!n || typeof n !== 'object') return; if (n.t === 'frame') frames.push(n); for (const v of Object.values(n)) walk(v) }
  walk(d.root)
  return frames[0] ? [frames[0].right].flat().map(r => (typeof r === 'string' ? r : r.s)).join('') : null
}

test('a mark of an earlier reply names that reply first in the tray\'s frame; the newest reply\'s marks do not', () => {
  assert.equal(rightOf({ next: true, prev: true, reply: 'reply 1 of 3, above' }), 'reply 1 of 3, above · cite · notes/plan.txt')
  assert.equal(rightOf({ next: true, prev: true }), 'cite · notes/plan.txt')
})
