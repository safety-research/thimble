// The features (settings/features.mjs): the manifest's userConfig, which Claude Code keeps and hands to the hooks
// module, holds the same fields as the switches the modules ask.   node --test plugin/settings/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { ALIASES, EFFORTS, modelOf, shownName } from '../../core/models.js'
import { DEFAULTS, DEFAULTS_FIELD, RETIRED, defaultsFrom, SWITCHES, checkerEffort, checkerModel, choiceOf, choicesIn, citationsFrom, claudeCites, featureOn, lensesAfterReply, minimalOn, PRESET, atPreset, currentValues, noteChange, noteDefaults, setOptions, switchesFrom } from '../features.mjs'

test("the manifest's userConfig is the features, each on by default and turned off by an option; the observer's look runs while a feature one of its lenses serves is on", () => {
  // the manifest's userConfig is the features: one boolean each, with its name, its words and its default
  {
    const manifest = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
    // the fields Citations replaced stay last, so a value saved under them still reaches the plugin
    assert.deepEqual(Object.keys(manifest.userConfig), [...SWITCHES.map(s => s.key), ...Object.keys(RETIRED), ...Object.keys(DEFAULTS_FIELD)])
    assert.deepEqual(SWITCHES.map(s => s.key), ['minimal', 'citations', 'checkerModel', 'checkerEffort', 'cards', 'squeezeAnswers', 'catchUp', 'explain', 'details', 'claimsMode', 'labels', 'coverage'])
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
  // a value saved under the retired fields stands while Citations holds its default; a Citations the person sets wins
  {
    assert.equal(citationsFrom({ marks: false, citationChecks: 'auto' }), 'off')
    assert.equal(citationsFrom({ marks: true, citationChecks: 'auto' }), 'auto cite + verify')
    assert.equal(citationsFrom({ marks: true, citationChecks: 'off' }), 'auto cite')
    assert.equal(citationsFrom({ marks: true, citationChecks: 'on demand' }), null)
    setOptions({ citations: 'auto cite', marks: false })
    assert.equal(choiceOf('citations'), 'off')
    setOptions({ citations: 'auto cite + verify', marks: false })
    assert.equal(choiceOf('citations'), 'off')
    setOptions({ citations: 'manual', marks: false })
    assert.equal(choiceOf('citations'), 'manual')
    setOptions({ marks: false })
    noteChange('citations', 'auto cite')
    assert.equal(choiceOf('citations'), 'auto cite')
    setOptions({})
  }
  // the look after each reply runs while a feature one of its lenses serves is on; the claims join it only when Claims
  // is auto (auto by default, a value outside its modes too); Claims off is no claims, and the old Claims switch saved
  // off stands for it
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
    setOptions({ explain: false, details: false, claims: false, claimsMode: 'on demand' })
    assert.equal(choiceOf('claims'), 'off')
    assert.equal(featureOn('claims'), false)
    setOptions({ claimsMode: true })
    assert.equal(choiceOf('claimsMode'), 'auto')
    setOptions({})
  }
  // no default moves now: a value saved at an old default (auto cite, 0.10.3's) stays, before and after the first
  // session notes the defaults; and a value at an old default still counts as unset for a retired field's move
  {
    assert.deepEqual(defaultsFrom({ citations: 'auto cite' }), {})
    assert.deepEqual(defaultsFrom({ claimsMode: 'on demand' }), {})
    setOptions({ citations: 'auto cite' })
    noteDefaults()
    assert.equal(choiceOf('citations'), 'auto cite')
    setOptions({ claimsMode: 'on demand' })
    noteDefaults()
    assert.equal(choiceOf('claimsMode'), 'on demand')
    setOptions({ claimsMode: 'on demand', claims: false })
    assert.equal(choiceOf('claimsMode'), 'off')
    setOptions({})
  }
  // Minimal is a preset: its modes (PRESET) keep every lens from the look after each reply, Claude from citing, and the
  // claims waiting for f; h acts while Heads-ups is on demand. Explainers and Heads-ups saved as the switches they were
  // read as auto (on) and off (off)
  {
    setOptions({})
    assert.equal(minimalOn(), false)
    assert.equal(choiceOf('explain'), 'auto')
    assert.equal(featureOn('heads'), false)
    assert.equal(atPreset({}), false)
    setOptions({ minimal: true, ...PRESET })
    assert.equal(minimalOn(), true)
    assert.equal(atPreset(currentValues()), true)
    assert.equal(featureOn('observer'), false)
    assert.equal(lensesAfterReply('explain'), false)
    assert.equal(lensesAfterReply('claims'), false)
    assert.equal(claudeCites(), false)
    assert.equal(featureOn('cite'), true)
    assert.equal(featureOn('explain'), true)
    assert.equal(featureOn('heads'), true)
    assert.equal(featureOn('cards'), true)
    // h is Heads-ups' on demand, Minimal or not
    setOptions({ details: 'on demand' })
    assert.equal(featureOn('heads'), true)
    assert.equal(lensesAfterReply('details'), false)
    assert.equal(lensesAfterReply('explain'), true)
    setOptions({ details: 'auto' })
    assert.equal(featureOn('heads'), false)
    assert.equal(lensesAfterReply('details'), true)
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


test("Checker names the models thimble keeps (core/models.js), each as Claude Code shows it with its version, which /config shows and Claude Code saves; its Effort offers the levels Claude Code offers for that model, and a level the model lacks gives way to the highest below it", () => {
  const checker = SWITCHES.find(s => s.key === 'checkerModel')
  const effort = SWITCHES.find(s => s.key === 'checkerEffort')
  // the list where the plugin keeps its models, Fable among them, each with its version: the choices themselves, so the
  // pane and /config (the manifest's options, the first test) show the same words
  assert.deepEqual(ALIASES, ['haiku', 'sonnet', 'opus', 'fable'])
  assert.deepEqual(checker.choices, ['same as Claude', 'Haiku 5.5', 'Sonnet 5.5', 'Opus 5.5', 'Fable 5.1'])
  assert.deepEqual(checker.choices.slice(1), ALIASES.map(shownName))
  assert.equal(checker.labels, undefined)
  assert.match(checker.does, /same as Claude: the model of the conversation\. Haiku 5\.5, Sonnet 5\.5, Opus 5\.5 or Fable 5\.1: that model/)
  for (const m of checker.choices.slice(1)) assert.equal(checker.says[m], `The second Claude checks citations on ${m}.`)
  // Effort: under Citations and off the first-party API as Checker is, its levels Claude Code's words for them
  assert.deepEqual(effort.choices, ['same as Claude', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual([effort.under, effort.firstParty, effort.group, effort.default], [checker.under, checker.firstParty, checker.group, 'same as Claude'])
  assert.deepEqual(choicesIn('checkerEffort', { checkerModel: 'Fable 5.1' }), ['same as Claude', ...EFFORTS])
  assert.deepEqual(choicesIn('checkerEffort', {}), ['same as Claude', ...EFFORTS])
  assert.deepEqual(choicesIn('checkerModel', {}), checker.choices)
  // each request of the checker names the model's id and the level set
  setOptions({ checkerModel: 'Fable 5.1', checkerEffort: 'xhigh' })
  assert.equal(checkerModel(), 'claude-fable-5-1')
  assert.equal(checkerEffort('claude-fable-5-1'), 'xhigh')
  // an alias, as the 0.10.6 test branch saved it, stands for that model by its name with the version
  setOptions({ checkerModel: 'haiku' })
  assert.equal(choiceOf('checkerModel'), 'Haiku 5.5')
  assert.equal(checkerModel(), 'claude-haiku-5-5')
  // unset, or same as Claude: the conversation's
  setOptions({ checkerModel: 'Haiku 5.5' })
  assert.equal(checkerModel(), 'claude-haiku-5-5')
  assert.equal(checkerEffort('claude-haiku-5-5'), null)
  setOptions({ checkerEffort: 'max' })
  assert.equal(checkerModel(), null)
  assert.equal(checkerEffort('claude-opus-5-5[1m]'), 'max')
  // a model thimble does not list takes the level as set: Claude Code fits it to that model
  assert.equal(checkerEffort('claude-made-up-7'), 'max')
  // a value outside the levels is the default
  setOptions({ checkerEffort: 'turbo' })
  assert.equal(choiceOf('checkerEffort'), 'same as Claude')
  assert.equal(checkerEffort('claude-opus-5-5'), null)
  setOptions({})
  // a model that offered fewer levels (a made-up one, as an older model offers no xhigh or max) offers only those, and
  // a level it lacks gives way to the highest it offers below it
  const opus = modelOf('opus')
  const kept = opus.efforts
  try {
    opus.efforts = ['low', 'medium', 'high']
    assert.deepEqual(choicesIn('checkerEffort', { checkerModel: 'Opus 5.5' }), ['same as Claude', 'low', 'medium', 'high'])
    setOptions({ checkerModel: 'Opus 5.5', checkerEffort: 'max' })
    assert.equal(checkerEffort('claude-opus-5-5'), 'high')
  } finally {
    opus.efforts = kept
    setOptions({})
  }
})
