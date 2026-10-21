// The fix preview's keys (panes/fix.js) and the failure line's keys (shell/fixask.js). All data is made up.
//   node --test plugin/panes/test/fix.test.mjs
import '../../test-home.mjs'
import '../../draw/kit.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gridText, renderTerm } from '../../draw/term.js'
import pane, { diffFiles } from '../fix.js'
import { FAIL_KEYS, fixRequest, fixVerb, lineKey, USE_KEYS } from '../../shell/fixask.js'

const DK = globalThis.DrawKit

const PATCH = [
  'diff --git a/plugin/claims/rows.js b/plugin/claims/rows.js',
  '--- a/plugin/claims/rows.js', '+++ b/plugin/claims/rows.js', '@@ -1,3 +1,4 @@', '-const sep = ","', '+const sep = sniff(text)', '+// sniffed', ' x',
  'diff --git a/plugin/claims/test/semi.test.js b/plugin/claims/test/semi.test.js',
  '--- /dev/null', '+++ b/plugin/claims/test/semi.test.js', '@@ -0,0 +1,2 @@', '+test()', '+done()',
].join('\n')

const STORE = {
  title: 'Rows opens semicolon files', kind: 'fix', waiting: true, diff: PATCH,
  issue: '# Rows fails on a file that uses ; between fields\n\nRows could not open ‹data file›.\n\nExpected: Rows opens the row.',
  scan: [
    { id: 'h1', kind: 'file', found: 'orders.csv', replacement: '‹data file›', where: 'issue', kept: false },
    { id: 'h2', kind: 'token', found: 'sk-made-up-0000', replacement: '‹secret›', where: 'issue', kept: false },
  ],
}

const run = (store, o = {}) => {
  const data = pane.data({ 'fix:rows-semi': store }, { slug: 'rows-semi' })
  const d = DK.run(pane.program, data, { w: 80, h: 60, mode: 'pane', ...o })
  assert.equal(d.error, undefined, d.error && d.error.message)
  return { d, text: gridText(renderTerm(d, { w: 80 })).replace(/ /g, ' ') }
}
const keys = d => (d.on || []).map(h => h.name)

test('the preview shows the hits, the exact issue and the files, and y w send as the person', () => {
  const { d, text } = run(STORE)
  assert.match(text, /Nothing has been sent\. This is the exact text\./)
  assert.match(text, /2 found · all removed/)
  assert.match(text, /file name\s+orders\.csv\s+→ ‹data file›/)
  assert.match(text, /Rows fails on a file that uses ; between fields/)
  assert.match(text, /2 files · \+4 −1/)
  assert.match(text, /y send \(the pull request as a draft\) · w save as a file · e edit · esc not now/)
  assert.deepEqual(keys(d).sort(), ['d', 'e', 'k', 'w', 'y'])
  // y and w ask the host to send; the program never holds the ask id
  assert.deepEqual(run(STORE, { event: { type: 'key', key: 'y' } }).d.effects, [{ slug: 'rows-semi', answer: 'send', do: 'send' }])
  assert.deepEqual(run(STORE, { event: { type: 'key', key: 'w' } }).d.effects, [{ slug: 'rows-semi', answer: 'file', do: 'send' }])
  assert.deepEqual(run(STORE, { event: { type: 'key', key: 'e' } }).d.effects, [{ slug: 'rows-semi', do: 'edit' }])
})

test('k keeps one hit, never a token; d reads the diff; a sent draft has no y or w', () => {
  const { d, text } = run(STORE, { state: { keeping: true } })
  assert.deepEqual(keys(d).sort(), ['1', 'esc'])
  assert.match(text, /1 file name/)
  assert.deepEqual(run(STORE, { state: { keeping: true }, event: { type: 'key', key: '1' } }).d.effects, [{ slug: 'rows-semi', id: 'h1', do: 'keep' }])
  assert.match(run(STORE, { state: { diff: true } }).text, /\+const sep = sniff\(text\)/)
  assert.deepEqual(diffFiles(PATCH).map(f => [f.file, f.add, f.del]), [['plugin/claims/rows.js', 2, 1], ['plugin/claims/test/semi.test.js', 2, 0]])
  assert.ok(!keys(run({ ...STORE, waiting: false }).d).includes('y'))
})

test("a failure line's keys: f fixes, F reports, p and u act on a fix in use, and nothing else is taken", () => {
  assert.equal(FAIL_KEYS, 'f fix this · F report only')
  const failed = { kind: 'failed', text: '× Rows could not open the file' }
  assert.equal(lineKey(failed, 'f'), 'fix')
  assert.equal(lineKey(failed, 'F'), 'report')
  assert.equal(lineKey(failed, 'p'), null)
  assert.equal(lineKey({ kind: 'applied', slug: 'rows-semi', title: 't' }, 'u'), 'undo')
  assert.equal(lineKey(null, 'f'), null)
  const r = fixRequest({ failure: failed.text, kind: 'fix' })
  assert.match(r, /pressed f \(fix this\) on a thimble failure: "Rows could not open the file"/)
  assert.match(r, /`thimble fix new/)
  assert.match(fixRequest({ failure: 'x', kind: 'report' }), /--kind report/)
})

test('/thimble:fix: no words lists the fixes, submit undo and try act on a fix, and any other words are a change', () => {
  assert.deepEqual(fixVerb(''), { verb: 'status' })
  assert.deepEqual(fixVerb('  submit '), { verb: 'submit', slug: '' })
  assert.deepEqual(fixVerb('share claims-newest'), { verb: 'submit', slug: 'claims-newest' })
  assert.deepEqual(fixVerb('undo'), { verb: 'undo', slug: '' })
  assert.deepEqual(fixVerb('try claims-newest'), { verb: 'try', slug: 'claims-newest' })
  assert.deepEqual(fixVerb('sort the claims newest first'), { verb: 'change', text: 'sort the claims newest first' })
  assert.deepEqual(fixVerb('undo the bold in the bar'), { verb: 'change', text: 'undo the bold in the bar' })
  assert.deepEqual(fixVerb('remove claims-newest'), { verb: 'remove', slug: 'claims-newest' })
  assert.deepEqual(fixVerb('redo the claims fix on 0.11.0'), { verb: 'change', text: 'redo the claims fix on 0.11.0' })
  assert.equal(lineKey({ kind: 'notice', text: 'Your fix went off' }, 'u'), null)
  assert.equal(USE_KEYS, 'p submit · u undo')
})

test('a fix whose copy has no change is submitted as a request: an issue alone, with no pull request', () => {
  const { d, text } = run({ ...STORE, diff: '' })
  assert.match(text, /Submit your request/)
  assert.match(run({ ...STORE, scan: [] }).text, /Privacy scan · nothing found/)
  assert.doesNotMatch(text, /Draft pull request/)
  assert.match(text, /y send · w save as a file · e edit · esc not now/)
  assert.deepEqual(keys(d).sort(), ['e', 'k', 'w', 'y'])
  assert.match(run(STORE).text, /Submit your fix/)
})
