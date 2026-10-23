// The features (settings/features.mjs): the manifest's userConfig, which Claude Code keeps and hands to the hooks
// module, holds the same fields as the switches the modules ask.   node --test plugin/settings/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { COLOR, COLORS, SWITCHES, colorNow, colorOf, featureOn, noteChange, setOptions } from '../features.mjs'

test("the manifest's userConfig is the features, each on by default and turned off by an option; the observer's look runs while a feature one of its lenses serves is on", () => {
  // the manifest's userConfig is the features: one boolean each, with its name, its words and its default
  {
    const manifest = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
    assert.deepEqual(Object.keys(manifest.userConfig), [...SWITCHES.map(s => s.key), COLOR.key])
    assert.deepEqual(SWITCHES.map(s => s.key), ['marks', 'cards', 'squeeze', 'explain', 'details', 'claims', 'counts', 'squeezeCards'])
    for (const s of SWITCHES) assert.deepEqual(manifest.userConfig[s.key], { type: 'boolean', title: s.title, description: s.does, default: s.default })
    assert.deepEqual(manifest.userConfig[COLOR.key], { type: 'string', title: COLOR.title, description: COLOR.does, default: COLOR.default })
  }
  // a feature is on by default, and an option turns it off
  {
    setOptions({})
    assert.equal(featureOn('marks'), true)
    setOptions({ marks: false, cards: 'yes' })
    assert.equal(featureOn('marks'), false)
    assert.equal(featureOn('cards'), true)
    setOptions({})
  }
  // the observer's look runs while a feature one of its lenses serves is on
  {
    setOptions({})
    assert.equal(featureOn('observer'), true)
    setOptions({ explain: false, details: false })
    assert.equal(featureOn('observer'), true)
    setOptions({ explain: false, details: false, claims: false })
    assert.equal(featureOn('observer'), false)
    setOptions({})
  }
})

test("thimble's color is purple by default, an option or a pick a moment ago changes it, and a name it does not know is purple", () => {
  assert.deepEqual(COLORS.map(c => c.name), ['purple', 'blue', 'teal', 'green', 'orange', 'yellow'])
  assert.equal(new Set(COLORS.map(c => c.key)).size, COLORS.length)
  setOptions({})
  assert.equal(colorNow(), 'purple')
  assert.equal(colorOf(colorNow()).key, 'merged')
  setOptions({ color: 'teal' })
  assert.equal(colorNow(), 'teal')
  assert.equal(colorOf(colorNow()).key, 'planMode')
  // a pick in the settings pane acts at once; a name thimble has no color for changes nothing
  noteChange('color', 'orange')
  assert.equal(colorNow(), 'orange')
  noteChange('color', 'made-up-pink')
  assert.equal(colorNow(), 'orange')
  // an option with a name thimble does not know, or not a string: the default
  setOptions({ color: 'made-up-pink' })
  assert.equal(colorNow(), 'purple')
  setOptions({ color: 3 })
  assert.equal(colorNow(), 'purple')
  setOptions({})
})
