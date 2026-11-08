// The features (settings/features.mjs): the manifest's userConfig, which Claude Code keeps and hands to the hooks
// module, holds the same fields as the switches the modules ask.   node --test plugin/settings/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { SWITCHES, choiceOf, claudeCites, featureOn, lensesAfterReply, minimalOn, OLD_PRESET, PRESET, atPreset, currentValues, setOptions, switchesFrom } from '../features.mjs'

test("the manifest's userConfig is the features, each on by default and turned off by an option; the observer's look runs while a feature one of its lenses serves is on", () => {
  // the manifest's userConfig is the features: one boolean each, with its name, its words and its default
  {
    const manifest = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
    assert.deepEqual(Object.keys(manifest.userConfig), SWITCHES.map(s => s.key))
    assert.deepEqual(SWITCHES.map(s => s.key), ['minimal', 'citations', 'checkerModel', 'checkerEffort', 'cards', 'squeezeAnswers', 'catchUp', 'explain', 'details', 'claimsMode', 'labels', 'coverage'])
    for (const s of SWITCHES) {
      const kind = s.choices ? { type: 'string', options: s.choices } : { type: 'boolean' }
      assert.deepEqual(manifest.userConfig[s.key], { ...kind, title: s.title, description: s.does, default: s.default })
      // a feature with modes says what each one gives
      if (s.choices) assert.deepEqual(Object.keys(s.says), s.choices)
    }
    // the person reads Squeeze as Simplify, and Claims by its name; the keys stay, so a saved setting still applies
    assert.equal(SWITCHES.find(s => s.key === 'squeezeAnswers').title, 'Simplify')
    assert.equal(SWITCHES.find(s => s.key === 'claimsMode').title, 'Claims')
    assert.deepEqual(SWITCHES.find(s => s.key === 'claimsMode').choices, ['auto', 'on demand', 'off'])
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
    // auto and off: on demand, which it had until 0.10.11, reads as off
    assert.deepEqual(heads.choices, ['auto', 'off'])
    setOptions({ details: 'on demand' })
    assert.equal(choiceOf('details'), 'off')
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
  // Cards: auto by default; on demand still draws (v, and a card Claude is asked for), off draws none; saved as the
  // switch it was until 0.10.8, on is auto and off is off
  {
    assert.deepEqual(SWITCHES.find(s => s.key === 'cards').choices, ['auto', 'on demand', 'off'])
    setOptions({})
    assert.equal(choiceOf('cards'), 'auto')
    setOptions({ cards: 'on demand' })
    assert.equal(featureOn('cards'), true)
    setOptions({ cards: 'off' })
    assert.equal(featureOn('cards'), false)
    setOptions({ cards: true })
    assert.equal(choiceOf('cards'), 'auto')
    setOptions({ cards: 'false' })
    assert.equal(choiceOf('cards'), 'off')
    setOptions({})
  }
  // Citations: auto cite + verify by default; Claude cites in the two auto modes, c cites selected words in every mode
  // but off; a value outside them is the default
  {
    setOptions({})
    assert.equal(choiceOf('citations'), 'auto cite + verify')
    assert.equal(claudeCites(), true)
    assert.equal(featureOn('cite'), true)
    setOptions({ citations: 'auto cite' })
    assert.equal(claudeCites(), true)
    assert.equal(featureOn('cite'), true)
    setOptions({ citations: 'auto cite + verify' })
    assert.equal(claudeCites(), true)
    setOptions({ citations: 'manual' })
    assert.equal(claudeCites(), false)
    assert.equal(featureOn('citations'), true)
    assert.equal(featureOn('cite'), true)
    assert.equal(switchesFrom({ citations: 'manual' })('cite'), true)
    setOptions({ citations: 'off' })
    assert.equal(claudeCites(), false)
    assert.equal(featureOn('citations'), false)
    assert.equal(featureOn('cite'), false)
    assert.equal(switchesFrom({ citations: 'off' })('cite'), false)
    setOptions({ citations: 'sometimes' })
    assert.equal(choiceOf('citations'), 'auto cite + verify')
    setOptions({})
  }
  // a value that settings.json still holds under a field of the manifest until 0.10.12 changes nothing
  {
    setOptions({ marks: false, citationChecks: 'off', squeeze: false, counts: false, claims: false, defaultsAt: 'none' })
    assert.equal(choiceOf('citations'), 'auto cite + verify')
    assert.equal(featureOn('squeezeAnswers'), true)
    assert.equal(featureOn('labels'), true)
    assert.equal(choiceOf('claims'), 'auto')
    setOptions({})
  }
  // the look after each reply runs while a feature one of its lenses serves is on; the claims join it only when Claims
  // is auto (auto by default, a value outside its modes too); Claims off is no claims
  {
    setOptions({})
    assert.equal(featureOn('observer'), true)
    assert.equal(choiceOf('claimsMode'), 'auto')
    assert.equal(featureOn('claims'), true)
    assert.equal(lensesAfterReply('claims'), true)
    setOptions({ claimsMode: 'on demand' })
    assert.equal(lensesAfterReply('claims'), false)
    setOptions({ explain: false, details: false, claimsMode: 'on demand' })
    assert.equal(featureOn('observer'), false)
    setOptions({ explain: false, details: false, claimsMode: 'auto' })
    assert.equal(featureOn('observer'), true)
    assert.equal(lensesAfterReply('claims'), true)
    setOptions({ explain: false, details: false, claimsMode: 'off' })
    assert.equal(featureOn('observer'), false)
    assert.equal(featureOn('claims'), false)
    setOptions({ claimsMode: true })
    assert.equal(choiceOf('claimsMode'), 'auto')
    setOptions({})
  }
  // Minimal is a preset: its modes (PRESET) keep Claude citing, each citation verified when it is opened, and the
  // explainers and heads-ups in the look after each reply; Cards on demand; Simplify, Catch-up and the session-wide
  // panes (Claims, Labels, Coverage) off. Explainers and Heads-ups saved as the switches they were read as auto (on)
  // and off (off)
  {
    setOptions({})
    assert.equal(minimalOn(), false)
    assert.equal(choiceOf('explain'), 'auto')
    assert.equal(atPreset({}), false)
    assert.deepEqual(PRESET, { citations: 'auto cite', cards: 'on demand', squeezeAnswers: false, catchUp: false, explain: 'auto', details: 'auto', claimsMode: 'off', labels: false, coverage: false })
    setOptions({ minimal: true, ...PRESET })
    assert.equal(minimalOn(), true)
    assert.equal(atPreset(currentValues()), true)
    assert.equal(featureOn('observer'), true)
    assert.equal(lensesAfterReply('explain'), true)
    assert.equal(lensesAfterReply('details'), true)
    assert.equal(lensesAfterReply('claims'), false)
    assert.equal(claudeCites(), true)
    assert.equal(choiceOf('citations'), 'auto cite')
    assert.equal(featureOn('cite'), true)
    assert.equal(featureOn('explain'), true)
    assert.equal(featureOn('details'), true)
    assert.equal(featureOn('cards'), true)
    assert.equal(choiceOf('cards'), 'on demand')
    for (const k of ['claims', 'labels', 'coverage', 'squeezeAnswers', 'catchUp']) assert.equal(featureOn(k), false, k)
    // the modes Minimal set from 0.10.4 to 0.10.7 are not its modes now
    setOptions({ minimal: true, ...OLD_PRESET })
    assert.equal(atPreset(currentValues()), false)
    assert.equal(atPreset(currentValues(), OLD_PRESET), true)
    setOptions({ explain: true, details: false })
    assert.equal(choiceOf('explain'), 'auto')
    assert.equal(choiceOf('details'), 'off')
    assert.equal(featureOn('details'), false)
    setOptions({})
  }
  // a mode saved under its old name stands for the new one: auto cite + check is auto cite + verify
  {
    setOptions({ citations: 'auto cite + check' })
    assert.equal(choiceOf('citations'), 'auto cite + verify')
    assert.equal(claudeCites(), true)
    setOptions({})
  }
})
