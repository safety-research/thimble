// The feature switches kept in step between /config and thimble's config (SPEC-v2 3.6): a person's /config change
// pushes `thimble features --set`, and the reloaded copy that finds /config equal to `settings.synced` stops (no reload
// loop). `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { CLI, CWD, startSession, world } from './fixtures'

const SLOW = { timeoutMs: 30000 }
const ALL_ON = { autoActivate: true, viewProposals: true, labels: true, checks: true, citationMarks: true, coverage: true, cardCheck: true }
const composer = (key: string, value: boolean, previous: boolean) => ({ key, value, previous, provider: { plugin: 'thimble', tier: 'user' }, origin: { kind: 'composer' } }) as never

test("a person's /config change of a thimble switch pushes `features --set` with the new value, and synced follows", SLOW, async ($, on) => {
  const w = world(on, { store: { 'settings.synced': ALL_ON } })
  await startSession($, w)
  await w.clock.advance(10)
  w.sets.length = 0
  // config.set fires before the write: `options` still says labels on; e.value says off
  await $.config.set(composer('thimble.labels', false, true))
  expect(w.sets).toEqual(['labels=off'])
  expect(w.calls.filter(c => c[1] === 'features').at(-1)).toEqual([CLI, 'features', '--cwd', CWD, '--json', '--set', 'labels=off'])
  expect((w.store.get('settings.synced') as Record<string, boolean>).labels).toBe(false)
})

test('the reloaded copy that finds /config equal to synced pushes nothing and sets nothing: no reload loop', { ...SLOW, options: { labels: false, checks: false } }, async ($, on) => {
  const w = world(on, { store: { 'settings.synced': { ...ALL_ON, labels: false, checks: false } } })
  w.features.labels = false
  w.features.checks = false
  await startSession($, w)
  await w.clock.advance(10)
  expect(w.sets).toEqual([])
  expect(w.configSets).toEqual([])
})
