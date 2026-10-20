// The observer's reply: how it reads the pass's answer.
// `node --test plugin/observer/test/*.test.mjs`
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'

import { parseAnswer } from '../evidence.js'

test("the pass's answer is read leniently: its lenses' parts, and nothing of the parts no lens gives", () => {
  const a = parseAnswer('Here: {"notes": [{"note": "412 counts all months."}], "verbs": {"v": {"note": "1 view"}}, "glosses": [{"term": "p95"}], "line": {"line": "x", "decision": "send it"}, "settled": true, "hints": {"orders-by-region": [{"verb": "trace"}]}}')
  assert.deepEqual(Object.keys(a).sort(), ['claims', 'clusters', 'glosses', 'heads', 'verbs'])
  assert.deepEqual(a.glosses, [{ term: 'p95' }])
  assert.equal(parseAnswer('no json'), null)
})
