// The features (settings/features.mjs): the manifest's userConfig, which Claude Code keeps and hands to the hooks
// module, holds the same fields as the switches the modules ask.   node --test plugin/settings/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { SWITCHES, choiceOf, featureOn, setOptions } from '../features.mjs'

test("the manifest's userConfig is the features, each on by default and turned off by an option; the observer's look runs while a feature one of its lenses serves is on", () => {
  // the manifest's userConfig is the features: one boolean each, with its name, its words and its default
  {
    const manifest = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
    assert.deepEqual(Object.keys(manifest.userConfig), SWITCHES.map(s => s.key))
    assert.deepEqual(SWITCHES.map(s => s.key), ['marks', 'citationChecks', 'cards', 'squeeze', 'explain', 'details', 'claims', 'counts', 'squeezeCards'])
    for (const s of SWITCHES) {
      const kind = s.choices ? { type: 'string', options: s.choices } : { type: 'boolean' }
      assert.deepEqual(manifest.userConfig[s.key], { ...kind, title: s.title, description: s.does, default: s.default })
    }
  }
  // the heads-ups' switch is named as the tray and the threads name what it gives, and keeps its stored key, so a
  // setting saved under the old name still applies
  {
    const heads = SWITCHES.find(s => s.lenses?.includes('heads'))
    assert.equal(heads.key, 'details')
    assert.equal(heads.title, 'Heads-ups')
    assert.match(heads.does, /heads-up/)
    setOptions({ details: false })
    assert.equal(featureOn('details'), false)
    setOptions({})
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
  // citations are checked on demand by default; auto and off are the other modes, and a value outside them is the default
  {
    setOptions({})
    assert.equal(choiceOf('citationChecks'), 'on demand')
    setOptions({ citationChecks: 'auto' })
    assert.equal(choiceOf('citationChecks'), 'auto')
    setOptions({ citationChecks: 'off' })
    assert.equal(choiceOf('citationChecks'), 'off')
    assert.equal(featureOn('citationChecks'), false)
    setOptions({ citationChecks: 'sometimes' })
    assert.equal(choiceOf('citationChecks'), 'on demand')
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

