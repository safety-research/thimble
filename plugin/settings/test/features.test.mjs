// The features (settings/features.mjs): the manifest's userConfig, which Claude Code keeps and hands to the hooks
// module, holds the same fields as the switches the modules ask.   node --test plugin/settings/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { SWITCHES, choiceOf, claudeCites, featureOn, lensesAfterReply, minimalOn, OLD_PRESET, PRESET, RENAMED, atPreset, currentValues, renamedTo, setOptions, switchesFrom, valueIn } from '../features.mjs'

test("the manifest's userConfig is the features, each at its default until an option sets it; the observer's look runs while a feature one of its lenses serves is on", () => {
  // the manifest's userConfig is the features: one boolean each, with its name, its words and its default
  {
    const manifest = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
    assert.deepEqual(Object.keys(manifest.userConfig), SWITCHES.map(s => s.key))
    // in the order of their keys on the bar, Minimal mode first, as the settings pane lists them
    assert.deepEqual(SWITCHES.map(s => s.key), ['minimal', 'cards', 'squeezeAnswers', 'catchUp', 'citations', 'checkerModel', 'checkerEffort', 'explain', 'details', 'labels', 'claimsMode', 'coverage'])
    for (const s of SWITCHES) {
      const kind = s.choices ? { type: 'string', options: s.choices } : { type: 'boolean' }
      assert.deepEqual(manifest.userConfig[s.key], { ...kind, title: s.title, description: s.does, default: s.default })
      // each mode says what it gives, on and off for a switch; the settings under Citations have no line of their own
      if (s.under) assert.equal(s.says, undefined, s.key)
      else assert.deepEqual(Object.keys(s.says), s.choices ?? ['on', 'off'], s.key)
    }
    // the groups the pane draws between thin lines, each a run of rows
    const runs = []
    for (const s of SWITCHES) (runs.at(-1)?.[0].group === s.group ? runs.at(-1) : runs[runs.push([]) - 1]).push(s)
    assert.deepEqual(runs.map(r => r.map(s => s.key)), [['minimal'], ['cards'], ['squeezeAnswers', 'catchUp'], ['citations', 'checkerModel', 'checkerEffort'], ['explain', 'details'], ['labels', 'claimsMode', 'coverage']])
    // each row's key on the bar; Minimal mode, Heads-ups and the settings under Citations have none
    assert.deepEqual(Object.fromEntries(SWITCHES.filter(s => s.letter).map(s => [s.key, s.letter])), { cards: 'v', squeezeAnswers: 's', catchUp: 'b', citations: 'c', explain: 'e', labels: 'l', claimsMode: 'w', coverage: 'r' })
    assert.deepEqual(SWITCHES.filter(s => s.under).map(s => [s.title, s.under]), [['Verifier model', 'citations'], ['Verifier effort', 'citations']])
    assert.equal(SWITCHES[0].title, 'Minimal mode')
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
    // the settings list it with the explainers
    assert.deepEqual(SWITCHES.filter(s => s.group === heads.group).map(s => s.title), ['Explainers', 'Heads-ups'])
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
  // Citations: manual by default, where Claude cites nothing and c cites selected words; Claude cites in the two auto
  // modes, c cites selected words in every mode but off; a value outside them is the default
  {
    setOptions({})
    assert.equal(choiceOf('citations'), 'manual')
    assert.equal(claudeCites(), false)
    assert.equal(featureOn('cite'), true)
    assert.deepEqual(SWITCHES.find(s => s.key === 'citations').choices, ['auto + verify', 'auto', 'manual', 'off'])
    setOptions({ citations: 'auto' })
    assert.equal(claudeCites(), true)
    assert.equal(featureOn('cite'), true)
    setOptions({ citations: 'auto + verify' })
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
    assert.equal(choiceOf('citations'), 'manual')
    setOptions({})
  }
  // a value that settings.json still holds under a field of the manifest until 0.10.12 changes nothing
  {
    setOptions({ marks: true, citationChecks: 'on', squeeze: false, counts: false, claims: true, defaultsAt: 'none' })
    assert.equal(choiceOf('citations'), 'manual')
    assert.equal(featureOn('squeezeAnswers'), true)
    assert.equal(featureOn('labels'), true)
    assert.equal(choiceOf('claims'), 'off')
    setOptions({})
  }
  // the look after each reply runs while a feature one of its lenses serves is on; the claims join it only when Claims
  // is auto; Claims off is no claims (off by default, a value outside its modes too)
  {
    setOptions({})
    assert.equal(featureOn('observer'), true)
    assert.equal(choiceOf('claimsMode'), 'off')
    assert.equal(featureOn('claims'), false)
    assert.equal(lensesAfterReply('claims'), false)
    setOptions({ claimsMode: 'auto' })
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
    assert.equal(choiceOf('claimsMode'), 'off')
    setOptions({})
  }
  // Coverage: off by default; an option turns it on
  {
    setOptions({})
    assert.equal(featureOn('coverage'), false)
    setOptions({ coverage: true })
    assert.equal(featureOn('coverage'), true)
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
    assert.deepEqual(PRESET, { citations: 'auto', cards: 'on demand', squeezeAnswers: false, catchUp: false, explain: 'auto', details: 'auto', claimsMode: 'off', labels: false, coverage: false })
    setOptions({ minimal: true, ...PRESET })
    assert.equal(minimalOn(), true)
    assert.equal(atPreset(currentValues()), true)
    assert.equal(featureOn('observer'), true)
    assert.equal(lensesAfterReply('explain'), true)
    assert.equal(lensesAfterReply('details'), true)
    assert.equal(lensesAfterReply('claims'), false)
    assert.equal(claudeCites(), true)
    assert.equal(choiceOf('citations'), 'auto')
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
  // a mode saved under its old name stands for the new one: auto cite + check and auto cite + verify are auto + verify,
  // auto cite is auto; a mode of Minimal mode's saved so still stands for it
  {
    for (const [old, now] of [['auto cite + check', 'auto + verify'], ['auto cite + verify', 'auto + verify'], ['auto cite', 'auto']]) {
      assert.equal(renamedTo('citations', old), now)
      assert.equal(valueIn({ citations: old }, 'citations'), now)
      setOptions({ citations: old })
      assert.equal(choiceOf('citations'), now)
      assert.equal(claudeCites(), true)
    }
    // every old name is a mode the manifest no longer offers, and stands for one it offers
    const choices = SWITCHES.find(s => s.key === 'citations').choices
    for (const [old, now] of Object.entries(RENAMED.citations)) assert.ok(!choices.includes(old) && choices.includes(now), old)
    assert.equal(atPreset({ ...PRESET, citations: 'auto cite' }), true)
    setOptions({})
  }
})

test('a Verifier model saved under an earlier version of a family names the model of that family now', async () => {
  const { modelNamed } = await import('../../core/models.js')
  assert.equal(modelNamed('Fable 5.2')?.id, 'claude-fable-5-2')
  assert.equal(modelNamed('Fable 5.1')?.id, 'claude-fable-5-2')
  assert.equal(modelNamed('same as Claude'), null)
})
