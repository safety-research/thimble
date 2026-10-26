// The features (settings/features.mjs): the manifest's userConfig, which Claude Code keeps and hands to the hooks
// module, holds the same fields as the switches the modules ask.   node --test plugin/settings/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { DEFAULTS, DEFAULTS_FIELD, RETIRED, defaultsFrom, SWITCHES, choiceOf, citationsFrom, claudeCites, featureOn, heldByMinimal, lensesAfterReply, minimalOn, noteChange, noteDefaults, setOptions, switchesFrom } from '../features.mjs'

test("the manifest's userConfig is the features, each on by default and turned off by an option; the observer's look runs while a feature one of its lenses serves is on", () => {
  // the manifest's userConfig is the features: one boolean each, with its name, its words and its default
  {
    const manifest = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
    // the fields Citations replaced stay last, so a value saved under them still reaches the plugin
    assert.deepEqual(Object.keys(manifest.userConfig), [...SWITCHES.map(s => s.key), ...Object.keys(RETIRED), ...Object.keys(DEFAULTS_FIELD)])
    assert.deepEqual(SWITCHES.map(s => s.key), ['minimal', 'citations', 'cards', 'squeezeAnswers', 'catchUp', 'explain', 'details', 'claimsMode', 'labels', 'coverage'])
    for (const s of SWITCHES) {
      const kind = s.choices ? { type: 'string', options: s.choices } : { type: 'boolean' }
      assert.deepEqual(manifest.userConfig[s.key], { ...kind, title: s.title, description: s.does, default: s.default })
      // a feature with modes says what each one gives
      if (s.choices) assert.deepEqual(Object.keys(s.says), s.choices)
    }
    for (const [k, f] of Object.entries({ ...RETIRED, ...DEFAULTS_FIELD })) assert.deepEqual(manifest.userConfig[k], f)
    // the person reads Squeeze as Rewrite and Claims as Evidence; the keys stay, so a saved setting still applies
    assert.equal(SWITCHES.find(s => s.key === 'squeezeAnswers').title, 'Rewrite')
    assert.equal(SWITCHES.find(s => s.key === 'claimsMode').title, 'Evidence')
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
  // Citations: manual by default (c on selected words); Claude cites in the two auto modes; a value outside them is the default
  {
    setOptions({})
    assert.equal(choiceOf('citations'), 'manual')
    assert.equal(claudeCites(), false)
    assert.equal(featureOn('cite'), true)
    setOptions({ citations: 'auto cite' })
    assert.equal(claudeCites(), true)
    assert.equal(featureOn('cite'), false)
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
    setOptions({ citations: 'sometimes' })
    assert.equal(choiceOf('citations'), 'manual')
    setOptions({})
  }
  // a value saved under the retired fields stands while Citations holds its default; a Citations the person sets wins
  {
    assert.equal(citationsFrom({ marks: false, citationChecks: 'auto' }), 'off')
    assert.equal(citationsFrom({ marks: true, citationChecks: 'auto' }), 'auto cite + verify')
    assert.equal(citationsFrom({ marks: true, citationChecks: 'off' }), 'auto cite')
    assert.equal(citationsFrom({ marks: true, citationChecks: 'on demand' }), null)
    setOptions({ citations: 'auto cite', marks: false })
    assert.equal(choiceOf('citations'), 'off')
    setOptions({ citations: 'auto cite + verify', marks: false })
    assert.equal(choiceOf('citations'), 'auto cite + verify')
    setOptions({ marks: false })
    noteChange('citations', 'auto cite')
    assert.equal(choiceOf('citations'), 'auto cite')
    setOptions({})
  }
  // the look after each reply runs while a feature one of its lenses serves is on; the claims join it only when Claims
  // is auto (on demand by default, a value outside its modes too); Claims off is no claims, and the old Claims switch
  // saved off stands for it
  {
    setOptions({})
    assert.equal(featureOn('observer'), true)
    assert.equal(choiceOf('claimsMode'), 'on demand')
    assert.equal(featureOn('claims'), true)
    assert.equal(lensesAfterReply('claims'), false)
    setOptions({ explain: false, details: false })
    assert.equal(featureOn('observer'), false)
    setOptions({ explain: false, details: false, claimsMode: 'auto' })
    assert.equal(featureOn('observer'), true)
    assert.equal(lensesAfterReply('claims'), true)
    setOptions({ explain: false, details: false, claimsMode: 'off' })
    assert.equal(featureOn('observer'), false)
    assert.equal(featureOn('claims'), false)
    setOptions({ explain: false, details: false, claims: false, claimsMode: 'on demand' })
    assert.equal(choiceOf('claims'), 'off')
    assert.equal(featureOn('claims'), false)
    setOptions({ claimsMode: true })
    assert.equal(choiceOf('claimsMode'), 'on demand')
    setOptions({})
  }
  // a default that moved: the installer saved every default, so auto cite saved before 0.10.4 moves to manual once,
  // when the first session saves it (term.ts) and notes it here; auto cite set afterwards stays, and so does any other
  // mode, and a setting the person changes before the move counts as set
  {
    assert.deepEqual(defaultsFrom({ citations: 'auto cite' }), { citations: 'manual' })
    assert.deepEqual(defaultsFrom({ citations: 'auto cite', defaultsAt: DEFAULTS.at }), {})
    assert.deepEqual(defaultsFrom({ citations: 'auto cite + verify' }), {})
    setOptions({ citations: 'auto cite' })
    noteDefaults()
    assert.equal(choiceOf('citations'), 'manual')
    setOptions({ citations: 'auto cite', defaultsAt: DEFAULTS.at })
    noteDefaults()
    assert.equal(choiceOf('citations'), 'auto cite')
    setOptions({ citations: 'off' })
    noteChange('citations', 'auto cite')
    noteDefaults()
    assert.equal(choiceOf('citations'), 'auto cite')
    setOptions({})
  }
  // Minimal: off by default; on, nothing joins the look after each reply (so no look runs), Claude does not cite, the
  // claims wait for f, h asks for heads-ups; each setting keeps its own value, which acts again once Minimal is off
  {
    setOptions({})
    assert.equal(minimalOn(), false)
    assert.equal(featureOn('heads'), false)
    assert.deepEqual(heldByMinimal({}), {})
    const set = { minimal: true, citations: 'auto cite + verify', claimsMode: 'auto' }
    setOptions(set)
    assert.equal(minimalOn(), true)
    assert.equal(featureOn('observer'), false)
    assert.equal(lensesAfterReply('explain'), false)
    assert.equal(lensesAfterReply('claims'), false)
    assert.equal(choiceOf('citations'), 'manual')
    assert.equal(claudeCites(), false)
    assert.equal(featureOn('cite'), true)
    assert.equal(choiceOf('claims'), 'on demand')
    assert.equal(featureOn('explain'), true)
    assert.equal(featureOn('heads'), true)
    assert.equal(featureOn('cards'), true)
    assert.deepEqual(heldByMinimal(set), { citations: 'manual', claimsMode: 'on demand', explain: 'on demand', details: 'on demand' })
    // what is off stays off, and Heads-ups off has no h
    assert.deepEqual(heldByMinimal({ ...set, citations: 'off', claimsMode: 'off', explain: false, details: false }), {})
    setOptions({ ...set, details: false })
    assert.equal(featureOn('heads'), false)
    setOptions({ ...set, minimal: false })
    assert.equal(choiceOf('citations'), 'auto cite + verify')
    assert.equal(lensesAfterReply('claims'), true)
    assert.equal(featureOn('heads'), false)
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

