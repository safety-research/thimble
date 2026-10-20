// The switches (settings/features.mjs): the manifest's userConfig holds the same fields, and a switch acts only while
// the one it needs is on.   node --test plugin/settings/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { LENSES } from '../../observer/lenses/index.mjs'
import { SWITCHES, featureOn, lensOn, setOptions, switchOfLens } from '../features.mjs'

test("the manifest's userConfig is the switches: one boolean each, with its label, its words and its default", () => {
  const manifest = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(manifest.userConfig), SWITCHES.map(s => s.key))
  for (const s of SWITCHES) assert.deepEqual(manifest.userConfig[s.key], { type: 'boolean', title: s.label, description: `${s.does} ${s.costs}`, default: s.default })
})

test('every lens of the observer has its switch, and a lens is on only while the observer is', () => {
  for (const l of LENSES) assert.ok(switchOfLens(l), l.name)
  setOptions({ claims: false })
  assert.equal(featureOn('claims'), false)
  assert.equal(lensOn(LENSES.find(l => l.name === 'claims')), false)
  assert.equal(lensOn(LENSES.find(l => l.name === 'notes')), true)
  setOptions({ observer: false, notes: true })
  assert.equal(featureOn('notes'), false)
  assert.equal(lensOn(LENSES.find(l => l.name === 'notes')), false)
  // a lens no switch names (a new one) follows the observer; its module may name its switch
  assert.equal(lensOn({ name: 'new-lens' }), false)
  setOptions({})
  assert.equal(lensOn({ name: 'new-lens' }), true)
  assert.equal(switchOfLens({ name: 'whatever', option: 'details' }).key, 'details')
  assert.equal(featureOn('catchup'), true)
})
