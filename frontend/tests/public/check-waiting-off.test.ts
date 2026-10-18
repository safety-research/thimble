// A check whose run waits while thimble is off in the Claude Code session (/plugin) says what it waits for, as one held
// by plan mode does (bug hunt round 10, K8: it failed with a notice that main and its tools still work).
import { expect, test } from 'vitest'
import { checkRunLabel } from '../../src/report/Checks.tsx'

test('a check held while thimble is off says it runs once thimble is on again', () => {
  expect(checkRunLabel('Tea facts', { waiting: 'off' })).toBe('Tea facts runs once thimble is on again in your Claude Code session (/plugin in your terminal)')
  expect(checkRunLabel('Tea facts', { waiting: 'plan' })).toContain('plan mode')
})
