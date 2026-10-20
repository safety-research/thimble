// The features (settings/features.mjs): the manifest's userConfig, which Claude Code keeps and hands to the hooks
// module, holds the same fields as the switches the modules ask.   node --test plugin/settings/test
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { SWITCHES } from '../features.mjs'

test("the manifest's userConfig is the features: one boolean each, with its name, its words and its default", () => {
  const manifest = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(manifest.userConfig), SWITCHES.map(s => s.key))
  for (const s of SWITCHES) assert.deepEqual(manifest.userConfig[s.key], { type: 'boolean', title: s.label ?? s.title, description: `${s.does} ${s.costs}`, default: s.default })
  // no Observer parent, and no feature under another
  assert.ok(!SWITCHES.some(s => s.key === 'observer' || 'under' in s))
})
