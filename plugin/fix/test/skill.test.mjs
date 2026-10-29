// The fix-thimble skill's text (skills/fix-thimble/SKILL.md) and the hook that answers it (fix/register.ts): the line
// that holds Claude's argument opens with the lead wordsOfSkill looks for, so a skill expanded some other way
// (skill.prompt) still names the fix the person's words change.
//   node --test plugin/fix/test/skill.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test("the skill's argument line opens with the lead the hook reads", () => {
  const lead = /const SKILL_LEAD = "([^"]+)"/.exec(readFileSync(join(ROOT, 'fix', 'register.ts'), 'utf8'))?.[1]
  assert.ok(lead, 'register.ts names the lead')
  const skill = readFileSync(join(ROOT, 'skills', 'fix-thimble', 'SKILL.md'), 'utf8')
  assert.ok(skill.includes(`\n${lead} $ARGUMENTS\n`), `SKILL.md has the line: ${lead} $ARGUMENTS`)
})
