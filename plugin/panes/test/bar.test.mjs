// The bar in the room it has (panes/host.js fitBar): what gives way first when the line is short.
//   node --test plugin/panes/test/bar.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { barLine, fitBar, previewBarWidth } from '../host.js'

const verbs = [{ key: 'v', words: 'visualize' }, { key: 's', words: 'squeeze' }, { key: 'c', words: '29 claims', short: '29 claims' }]
const counts = [{ id: 'cov', text: 'r coverage 100% (4/4 files)' }, { id: 'labels', text: 'l 3 labels' }]

test('the reply the keys act on gives way before the counts: its words are cut at their end, and the labels stay', () => {
  const nav = { key: '{ }', words: "reply 2 of 4: The writers didn't change much over the run", short: 'reply 2 of 4', yields: true }
  const bar = { label: 'thimble', left: [...verbs, nav], counts }
  const full = barLine(bar).length
  // a little short of room: the counts stay, and the navigator's words end in …
  let fit = fitBar(bar, full - 12)
  assert.equal(fit.counts.length, 2)
  const words = fit.left.find(x => x.key === '{ }').words
  assert.ok(words.startsWith('reply 2 of 4: The') && words.endsWith('…'), words)
  assert.ok(barLine(fit).length <= full - 12)
  // shorter still: the navigator says only which reply, and the counts still stay
  fit = fitBar(bar, barLine({ ...bar, left: [...verbs, { ...nav, words: nav.short }] }).length)
  assert.equal(fit.left.find(x => x.key === '{ }').words, 'reply 2 of 4')
  assert.deepEqual(fit.counts.map(c => c.id), ['cov', 'labels'])
})

test('beside a side panel, the bar says the pane\'s plain name where its thread\'s name does not fit', () => {
  const bar = { label: 'thimble:main/Coverage', labelShort: 'Coverage', left: [{ key: 'esc', words: 'close' }], counts: [counts[0]] }
  const fit = fitBar(bar, 50)
  assert.equal(fit.label, 'Coverage')
  assert.equal(fit.cut, false)
  // with room, the whole name
  assert.equal(fitBar(bar, 120).label, 'thimble:main/Coverage')
})

test('the settings preview, drawn at the real bar\'s width beside the panel, drops coverage where the bar does', () => {
  const bar = { label: 'thimble', left: [{ key: 'a', words: 'ask' }, { key: '[', words: 'previous' }], counts: [{ id: 'threads', text: '2 threads' }, { id: 'cov', text: 'r coverage 30% (12/40 files)' }] }
  // a conversation of 50 columns beside the panel; the band draws the bar 1 column narrower than its viewport
  const real = fitBar(bar, 50 - 1)
  const preview = fitBar(bar, previewBarWidth(50, 1))
  assert.ok(!real.counts.some(c => c.id === 'cov'), 'the real bar drops coverage at this width')
  assert.deepEqual(preview.counts.map(c => c.id), real.counts.map(c => c.id))
  // the panel's own width (96) would keep it, which is what the preview showed before
  assert.ok(fitBar(bar, 96 - 4).counts.some(c => c.id === 'cov'))
  assert.equal(previewBarWidth(undefined, 1), null)
  assert.equal(previewBarWidth(64, null), null)
})
