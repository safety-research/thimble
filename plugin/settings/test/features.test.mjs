// The features (settings/features.mjs): the manifest's userConfig, which Claude Code keeps and hands to the hooks
// module, holds the same fields as the switches the modules ask.   node --test plugin/settings/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { RETIRED, SWITCHES, choiceOf, citationsFrom, claudeCites, featureOn, lensesAfterReply, noteChange, setOptions, switchesFrom } from '../features.mjs'

test("the manifest's userConfig is the features, each on by default and turned off by an option; the observer's look runs while a feature one of its lenses serves is on", () => {
  // the manifest's userConfig is the features: one boolean each, with its name, its words and its default
  {
    const manifest = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
    // the fields Citations replaced stay last, so a value saved under them still reaches the plugin
    assert.deepEqual(Object.keys(manifest.userConfig), [...SWITCHES.map(s => s.key), ...Object.keys(RETIRED)])
    assert.deepEqual(SWITCHES.map(s => s.key), ['citations', 'cards', 'squeeze', 'explain', 'details', 'claims', 'claimsMode', 'counts', 'squeezeCards'])
    for (const s of SWITCHES) {
      const kind = s.choices ? { type: 'string', options: s.choices } : { type: 'boolean' }
      assert.deepEqual(manifest.userConfig[s.key], { ...kind, title: s.title, description: s.does, default: s.default })
      // a feature with modes says what each one gives
      if (s.choices) assert.deepEqual(Object.keys(s.says), s.choices)
    }
    for (const [k, f] of Object.entries(RETIRED)) assert.deepEqual(manifest.userConfig[k], f)
    assert.equal(SWITCHES.find(s => s.key === 'claimsMode').title, 'Extract claims')
  }
  // the heads-ups' switch is named as the tray and the threads name what it gives, and keeps its stored key, so a
  // setting saved under the old name still applies
  {
    const heads = SWITCHES.find(s => s.lenses?.includes('heads'))
    assert.equal(heads.key, 'details')
    assert.equal(heads.title, 'Heads-ups')
    // the settings list it under Comments, with the explainers
    assert.deepEqual(SWITCHES.filter(s => s.group === 'Comments').map(s => s.title), ['Explainers', 'Heads-ups'])
    assert.match(heads.does, /heads-up/)
    setOptions({ details: false })
    assert.equal(featureOn('details'), false)
    setOptions({})
  }
  // a feature is on by default, and an option turns it off
  {
    setOptions({})
    assert.equal(featureOn('cards'), true)
    setOptions({ cards: false })
    assert.equal(featureOn('cards'), false)
    setOptions({ cards: 'yes' })
    assert.equal(featureOn('cards'), true)
    setOptions({})
  }
  // Citations: auto cite by default; Claude cites in the two auto modes; w is manual's; a value outside them is the default
  {
    setOptions({})
    assert.equal(choiceOf('citations'), 'auto cite')
    assert.equal(claudeCites(), true)
    assert.equal(featureOn('where'), false)
    setOptions({ citations: 'auto cite + check' })
    assert.equal(claudeCites(), true)
    setOptions({ citations: 'manual' })
    assert.equal(claudeCites(), false)
    assert.equal(featureOn('citations'), true)
    assert.equal(featureOn('where'), true)
    assert.equal(switchesFrom({ citations: 'manual' })('where'), true)
    setOptions({ citations: 'off' })
    assert.equal(claudeCites(), false)
    assert.equal(featureOn('citations'), false)
    setOptions({ citations: 'sometimes' })
    assert.equal(choiceOf('citations'), 'auto cite')
    setOptions({})
  }
  // a value saved under the retired fields stands while Citations holds its default; a Citations the person sets wins
  {
    assert.equal(citationsFrom({ marks: false, citationChecks: 'auto' }), 'off')
    assert.equal(citationsFrom({ marks: true, citationChecks: 'auto' }), 'auto cite + check')
    assert.equal(citationsFrom({ marks: true, citationChecks: 'off' }), 'auto cite')
    assert.equal(citationsFrom({ marks: true, citationChecks: 'on demand' }), null)
    setOptions({ citations: 'auto cite', marks: false })
    assert.equal(choiceOf('citations'), 'off')
    setOptions({ citations: 'manual', marks: false })
    assert.equal(choiceOf('citations'), 'manual')
    setOptions({ marks: false })
    noteChange('citations', 'auto cite')
    assert.equal(choiceOf('citations'), 'auto cite')
    setOptions({})
  }
  // the look after each reply runs while a feature one of its lenses serves is on; the claims join it only when Claims
  // found is auto (on demand by default, a value outside its modes too); a saved Claims switch still turns them off
  {
    setOptions({})
    assert.equal(featureOn('observer'), true)
    assert.equal(choiceOf('claimsMode'), 'on demand')
    assert.equal(lensesAfterReply('claims'), false)
    setOptions({ explain: false, details: false })
    assert.equal(featureOn('observer'), false)
    setOptions({ explain: false, details: false, claimsMode: 'auto' })
    assert.equal(featureOn('observer'), true)
    assert.equal(lensesAfterReply('claims'), true)
    setOptions({ explain: false, details: false, claims: false, claimsMode: 'auto' })
    assert.equal(featureOn('observer'), false)
    assert.equal(featureOn('claims'), false)
    setOptions({ claimsMode: true })
    assert.equal(choiceOf('claimsMode'), 'on demand')
    setOptions({})
  }
})

