// The features (settings/features.mjs): the manifest's userConfig holds the same fields; switches a person would never
// turn apart are one feature; Notes to Claude is experimental and off by default; the observer is no switch, and runs
// while a feature that reads answers is on.   node --test plugin/settings/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { LENSES } from '../../observer/lenses/index.mjs'
import { MERGED, SWITCHES, featureOn, lensOn, noteChange, observerOn, setOptions, switchOfLens, switchesFrom } from '../features.mjs'
import { program, selectedOf, wrap } from '../../panes/settings.js'
import '../../draw/kit.js'
import { gridText, renderTerm } from '../../draw/term.js'

const DK = globalThis.DrawKit

test("the manifest's userConfig is the features: one boolean each, with its name, its words and its default", () => {
  const manifest = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(manifest.userConfig), SWITCHES.map(s => s.key))
  for (const s of SWITCHES) assert.deepEqual(manifest.userConfig[s.key], { type: 'boolean', title: s.label ?? s.title, description: `${s.does} ${s.costs}`, default: s.default })
  // no Observer parent, and no feature under another
  assert.ok(!SWITCHES.some(s => s.key === 'observer' || 'under' in s))
})

test('switches a person would never turn apart are one feature: v proposals with Cards, catch-up with Squeeze, the two counts together', () => {
  assert.deepEqual(MERGED, { visualize: 'cards', catchup: 'squeeze', coverage: 'counts', labels: 'counts' })
  for (const [old, now] of Object.entries(MERGED)) {
    assert.ok(SWITCHES.some(s => s.key === now), now)
    assert.ok(!SWITCHES.some(s => s.key === old), old)
    setOptions({ [now]: false })
    assert.equal(featureOn(old), false, old)
    setOptions({ [now]: true })
    assert.equal(featureOn(old), true, old)
  }
  // an old field left in a person's settings changes nothing
  setOptions({ visualize: false })
  assert.equal(featureOn('cards'), true)
  setOptions({})
})

test('Notes to Claude is the one experimental feature, under its own heading at the end, and off by default', () => {
  const notes = SWITCHES.find(s => s.key === 'notes')
  assert.equal(notes.default, false)
  assert.equal(notes.group, 'Experimental')
  assert.deepEqual(SWITCHES.filter(s => s.group).map(s => s.key), ['notes'])
  assert.equal(SWITCHES.at(-1).key, 'notes')
  setOptions({})
  assert.equal(featureOn('notes'), false)
  assert.equal(lensOn(LENSES.find(l => l.name === 'notes')), false)
  for (const s of SWITCHES.filter(x => !x.group)) assert.equal(featureOn(s.key), true, s.key)
})

test('the observer is no switch: it runs while a feature that reads answers is on, and asks the lenses of those alone', () => {
  for (const l of LENSES) assert.ok(switchOfLens(l), l.name)
  setOptions({})
  assert.equal(observerOn(), true)
  setOptions({ claims: false })
  assert.equal(lensOn(LENSES.find(l => l.name === 'claims')), false)
  assert.equal(lensOn(LENSES.find(l => l.name === 'explain')), true)
  // the important-details feature turns the heads-up lens off
  setOptions({ details: false })
  assert.equal(switchOfLens(LENSES.find(l => l.name === 'heads')).key, 'details')
  assert.equal(lensOn(LENSES.find(l => l.name === 'heads')), false)
  // every feature that reads answers off: no look, though the bar's counts are on
  const off = Object.fromEntries(SWITCHES.filter(s => s.lenses.length).map(s => [s.key, false]))
  setOptions(off)
  assert.equal(featureOn('observer'), false)
  assert.equal(featureOn('counts'), true)
  for (const l of LENSES) assert.equal(lensOn(l), false, l.name)
  // a lens no feature names (a new one) follows the observer; its module may name its feature
  assert.equal(lensOn({ name: 'new-lens' }), false)
  setOptions({ ...off, notes: true })
  assert.equal(observerOn(), true)
  assert.equal(lensOn({ name: 'new-lens' }), true)
  assert.equal(switchOfLens({ name: 'whatever', option: 'details' }).key, 'details')
  setOptions({})
})

test('switchesFrom answers for the values given (the preview), not the plugin options', () => {
  setOptions({})
  const on = switchesFrom({ cards: false, claims: false })
  assert.equal(on('cards'), false)
  assert.equal(on('visualize'), false)
  assert.equal(on('claims'), false)
  assert.equal(on('squeeze'), true)
  assert.equal(featureOn('cards'), true)
})

test('a change the panel made is acted on at once, before the plugin loads again with it', () => {
  setOptions({ claims: true })
  noteChange('claims', false)
  assert.equal(featureOn('claims'), false)
  // a key that is no feature changes nothing
  noteChange('observer', false)
  assert.equal(featureOn('observer'), true)
  setOptions({})
})

// the settings panel's program, drawn as the terminal draws it
const rows = SWITCHES.map(s => ({ key: s.key, title: s.title, group: s.group ?? null, does: s.does, on: s.default, locked: false, pending: false }))
function draw(data, state = {}, w = 90) {
  const d = DK.run(program, data, { w, h: 40, state, mode: 'pane', surface: 'terminal' })
  assert.ok(!d.error, JSON.stringify(d.error))
  const g = renderTerm(d, { w })
  return { d, g, text: gridText(g).split('\n').map(l => l.trimEnd()).join('\n') }
}

test('the settings panel: one row per feature, flat, its words on one line under its name, Experimental last; no /config', () => {
  const { g, text } = draw({ rows, cost: 'All features but Labels and coverage on the bar share one model call after each reply.', last: null })
  const lines = text.split('\n')
  for (const s of SWITCHES) {
    const at = lines.findIndex(l => l.includes(s.title))
    assert.ok(at >= 0, s.title)
    // never drawn in from another feature
    assert.match(lines[at], /^(● on|○ off) {2,3}\S/)
    assert.ok(lines[at + 1].trim().startsWith(s.does.split(' ').slice(0, 3).join(' ')), s.title)
  }
  assert.ok(text.indexOf('Experimental') > text.indexOf('Labels and coverage on the bar'))
  assert.ok(!/\/config|Observer/.test(text))
  assert.match(text, /○ off {2}Notes to Claude/)
  assert.match(text, /↑↓ feature · ↵ or a click turns it on or off · esc close/)
  // each feature is one part a press or the ring lands on
  assert.deepEqual(g.regions.map(r => r.id), SWITCHES.map(s => `s-${s.key}`))
})

test('the selection: the state, else the feature changed last (the plugin loaded again since), else the first', () => {
  assert.equal(selectedOf({}, rows, null), 'cards')
  assert.equal(selectedOf({}, rows, 'claims'), 'claims')
  assert.equal(selectedOf({ sel: 'explain' }, rows, 'claims'), 'explain')
  assert.equal(selectedOf({}, rows, 'gone'), 'cards')
  assert.equal(draw({ rows, cost: '', last: 'claims' }).d.selected, 's-claims')
  // a feature's words wrap at the panel's width, at most two lines
  assert.deepEqual(wrap('one two three four five', 9), ['one two', 'three …'])
})
