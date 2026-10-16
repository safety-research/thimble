// The feature switches kept in step between /config and thimble's config (SPEC-v2 3.6): a person's /config change
// pushes `thimble features --set` from the config.set hook with `e.value`; the compare and pull at session start writes
// `settings.synced` to the store before any $.config.set, and the reloaded copy that then finds /config equal to it
// stops (no reload loop); before activation nothing runs a process. `claude plugin test plugin`.
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

test('the compare and pull: unpushed /config changes go to thimble, synced is stored before /config follows thimble', { ...SLOW, options: { labels: false } }, async ($, on) => {
  const w = world(on, { store: { 'settings.synced': ALL_ON } })
  // the browser turned checks off since the last sync
  w.features.checks = false
  await startSession($, w)
  await w.clock.advance(10)
  // labels: changed in /config, not pushed yet
  expect(w.sets).toEqual(['labels=off'])
  // checks: off in thimble, on in /config: /config follows, after synced holds thimble's values
  expect(w.configSets.map(c => [c.key, c.value])).toEqual([['thimble.checks', false]])
  expect(w.configSets[0]!.synced).toMatchObject({ labels: false, checks: false })
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

test("before activation a /config change runs no process and leaves synced; the sync at activation pushes it", { ...SLOW, options: { coverage: false } }, async ($, on) => {
  const w = world(on, { active: false, store: { 'settings.synced': ALL_ON } })
  await startSession($, w)
  await $.config.set(composer('thimble.coverage', false, true))
  expect(w.calls).toEqual([])
  expect((w.store.get('settings.synced') as Record<string, boolean>).coverage).toBe(true)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.advance(10)
  expect(w.sets).toEqual(['coverage=off'])
})

test("thimble's config changed in the browser while the session runs: the tick sees config.json change and /config follows", SLOW, async ($, on) => {
  const w = world(on, { store: { 'settings.synced': ALL_ON } })
  w.files.set('/home/a/.thimble/config.json', '{}')
  w.stamps.set('/home/a/.thimble/config.json', 1)
  await startSession($, w)
  await w.clock.advance(1100)
  expect(w.configSets).toEqual([])
  w.features.citationMarks = false
  w.stamps.set('/home/a/.thimble/config.json', 2)
  await w.clock.advance(1100)
  expect(w.configSets.map(c => [c.key, c.value])).toEqual([['thimble.citationMarks', false]])
})
