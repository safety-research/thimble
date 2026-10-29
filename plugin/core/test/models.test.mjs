// models.test.mjs: the models thimble's calls name, their list prices, and a rough price in words. node --test.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ALIASES, EFFORTS, aboutDollars, dollars, modelById, modelOf, shownName } from '../models.js'

test('an alias names its model and prices its tokens; a rough price reads in plain dollars', () => {
  assert.equal(modelOf('sonnet').name, 'Claude Sonnet 5.5')
  assert.equal(modelOf('made-up'), null)
  assert.equal(dollars('sonnet', 1e6, 1e5), 3)
  assert.equal(dollars('made-up', 1, 1), null)
  assert.deepEqual([0.004, 0.27, 3.6, 27].map(aboutDollars), ['under $0.01', 'about $0.25', 'about $4', 'about $25'])
})

test("Claude Code's four aliases, Fable among them: each model as Claude Code shows it, the id a request names, and the effort levels Claude Code offers for it", () => {
  assert.deepEqual(ALIASES, ['haiku', 'sonnet', 'opus', 'fable'])
  assert.deepEqual(ALIASES.map(shownName), ['Haiku 5.5', 'Sonnet 5.5', 'Opus 5.5', 'Fable 5.1'])
  assert.deepEqual(ALIASES.map(a => modelOf(a).id), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'])
  assert.equal(dollars('fable', 1e6, 1e5), 15)
  assert.deepEqual(EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max'])
  for (const a of ALIASES) assert.deepEqual(modelOf(a).efforts, EFFORTS)
  // a request's id, with or without its context window's suffix
  assert.equal(modelById('claude-fable-5-1'), modelOf('fable'))
  assert.equal(modelById('claude-opus-5-5[1m]'), modelOf('opus'))
  assert.equal(modelById('claude-made-up-7'), null)
  assert.equal(shownName('made-up'), 'made-up')
})
