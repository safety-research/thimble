// The features (settings/features.mjs): the manifest's userConfig, which Claude Code keeps and hands to the hooks
// module, holds the same fields as the switches the modules ask.   node --test plugin/settings/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { SWITCHES, featureOn, setOptions } from '../features.mjs'

test("the manifest's userConfig is the features: one boolean each, with its name, its words and its default", () => {
  const manifest = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(manifest.userConfig), SWITCHES.map(s => s.key))
  assert.deepEqual(SWITCHES.map(s => s.key), ['marks', 'cards', 'counts'])
  for (const s of SWITCHES) assert.deepEqual(manifest.userConfig[s.key], { type: 'boolean', title: s.title, description: s.does, default: s.default })
})

test('a feature is on by default, and an option turns it off', () => {
  setOptions({})
  assert.equal(featureOn('marks'), true)
  setOptions({ marks: false, cards: 'yes' })
  assert.equal(featureOn('marks'), false)
  assert.equal(featureOn('cards'), true)
  setOptions({})
})
