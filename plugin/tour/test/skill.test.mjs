// The tour's skill (skills/tour/SKILL.md): it is named tour, the person may start it as /thimble:tour, and it holds
// the sample answer alone, step 0, which states its numbers with no citation and holds none of the tour's own words:
// thimble draws the steps itself (tour/tour.ts), and its last step asks Claude for an answer that cites them. It holds
// the words step e names, and the number wrong on purpose. It names the sample by the plugin's folder, and the answer
// names the file that the explainer of its words reads.
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
  // the answer: no citation, and no step's words, which v, s and the observer would read as answer
  const answer = /\n-{10}\n([\s\S]*?)\n-{10}\n/.exec(text)?.[1] ?? ''
  assert.ok(answer)
  assert.doesNotMatch(answer, /\]\(#\)/)
  assert.doesNotMatch(answer, /press|wrong on purpose/i)
  // the words step e names (tour.ts E_WORDS), and the refunds, the number wrong on purpose (the data has 4), which
  // thimble's check corrects when Claude cites it at the cite step
  const named = /E_WORDS = '([^']+)'/.exec(readFileSync(join(ROOT, 'tour', 'tour.ts'), 'utf8'))?.[1]
  assert.ok(named && answer.toLowerCase().includes(named))
  assert.match(answer, /The shop refunded 7 orders\./)
  // no step texts: the skill names no key and no step
  assert.doesNotMatch(text, /## Step|press [evsc]\b/i)
  // Claude Code fills in the plugin's folder, wherever it is installed
  assert.ok(text.includes('${CLAUDE_PLUGIN_ROOT}/tour/sample/orders.csv'))
  assert.ok(existsSync(join(ROOT, 'tour', 'sample', 'orders.csv')))
  // the answer names the file that the explainer of its words reads (tour.ts TOUR_DATA)
  const data = /TOUR_DATA = '([^']+)'/.exec(readFileSync(join(ROOT, 'tour', 'tour.ts'), 'utf8'))?.[1]
  assert.ok(data && answer.includes(`(\`${data}\`)`) && existsSync(join(ROOT, 'tour', 'sample', data)))
})
