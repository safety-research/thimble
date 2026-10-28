// The prompt command /thimble-fix runs (commands/thimble-fix.md): with no words after it and no fix offered in Claude's
// last reply, Claude gives the same two lines /thimble-fix alone gives at once (fix/fixes.ts FIX_ALONE): how to ask,
// and where the fixes are listed and managed.
//   node --test plugin/fix/test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test("with no fix offered, the command's text has Claude give both lines of /thimble-fix alone", () => {
  const fixes = readFileSync(join(ROOT, 'fix', 'fixes.ts'), 'utf8')
  const lines = [.../export const FIX_ALONE = \[([\s\S]*?)\]\.join/.exec(fixes)[1].matchAll(/'([^']+)'/g)].map(m => m[1])
  assert.equal(lines.length, 2)
  const text = readFileSync(join(ROOT, 'commands', 'thimble-fix.md'), 'utf8')
  const none = text.slice(text.indexOf('When you offered none'))
  for (const line of lines) assert.ok(none.includes(line), `the no-offer reply has: ${line}`)
})
