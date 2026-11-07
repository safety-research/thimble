// The tour's skill (skills/tour/SKILL.md) and its hooks (tour/tour.ts): the skill is named tour, the person may start
// it as /thimble:tour, it names the sample by the plugin's folder, and it holds each step that the hooks' prompts name
// (tour.ts stepName: 1 to 5, and 3k), each under its own heading.
//   node --test plugin/tour/test/skill.test.mjs
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('the skill is tour, the person may start it, and it holds each step the hooks name', () => {
  const text = readFileSync(join(ROOT, 'skills', 'tour', 'SKILL.md'), 'utf8')
  const head = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? ''
  assert.match(head, /^name: tour$/m)
  assert.match(head, /^description: \S/m)
  assert.doesNotMatch(head, /user-invocable: false/)
  for (const step of ['1', '2', '3', '3k', '4', '5']) assert.ok(text.includes(`\n## Step ${step}\n`), `step ${step}`)
  // Claude Code fills in the plugin's folder, wherever it is installed
  assert.ok(text.includes('${CLAUDE_PLUGIN_ROOT}/tour/sample/orders.csv'))
  assert.ok(existsSync(join(ROOT, 'tour', 'sample', 'orders.csv')))
  // the prompts the hooks send open with the words the skill tells Claude to watch for
  const tag = /export const TAG = '([^']+)'/.exec(readFileSync(join(ROOT, 'tour', 'tour.ts'), 'utf8'))?.[1]
  assert.ok(tag && text.includes(`"${tag}"`), 'the skill names the tag of the prompts')
})
