// The tour's skill (skills/tour/SKILL.md): it is named tour, the person may start it as /thimble:tour, and it holds
// the sample answer alone, step 0, which cites six numbers and holds none of the tour's own words: thimble draws the
// steps itself (tour/tour.ts). It names the sample by the plugin's folder.
//   node --test plugin/tour/test/skill.test.mjs
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('the skill is tour, the person may start it, and it holds the sample answer alone', () => {
  const text = readFileSync(join(ROOT, 'skills', 'tour', 'SKILL.md'), 'utf8')
  const head = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? ''
  assert.match(head, /^name: tour$/m)
  assert.match(head, /^description: \S/m)
  assert.doesNotMatch(head, /user-invocable: false/)
  // the answer: its citations, and no step's words, which v, s and the observer would read as answer
  const answer = /\n-{10}\n([\s\S]*?)\n-{10}\n/.exec(text)?.[1] ?? ''
  assert.equal(answer.match(/\]\(#\)/g)?.length, 6)
  assert.doesNotMatch(answer, /press|wrong on purpose/i)
  // the words the tour marks for its steps (tour.ts markedWords) are in it
  assert.match(answer, /average order value/)
  assert.match(answer, /refunded \[[^\]]+\]\(#\)/)
  // no step texts: the skill names no key and no step
  assert.doesNotMatch(text, /## Step|press [evs]\b/i)
  // Claude Code fills in the plugin's folder, wherever it is installed
  assert.ok(text.includes('${CLAUDE_PLUGIN_ROOT}/tour/sample/orders.csv'))
  assert.ok(existsSync(join(ROOT, 'tour', 'sample', 'orders.csv')))
})
