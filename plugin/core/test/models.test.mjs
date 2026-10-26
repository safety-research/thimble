// models.test.mjs: the models thimble's calls name, their list prices, and a rough price in words. node --test.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { aboutDollars, dollars, modelOf } from '../models.js'

test('an alias names its model and prices its tokens; a rough price reads in plain dollars', () => {
  assert.equal(modelOf('sonnet').name, 'Claude Sonnet 5.5')
  assert.equal(modelOf('made-up'), null)
  assert.equal(dollars('sonnet', 1e6, 1e5), 3)
  assert.equal(dollars('made-up', 1, 1), null)
  assert.deepEqual([0.004, 0.27, 3.6, 27].map(aboutDollars), ['under $0.01', 'about $0.25', 'about $4', 'about $25'])
})
