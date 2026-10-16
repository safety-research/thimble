// Notices (notices.tsx, band.tsx, SPEC-v2 3.20): the workspace's and the terminal's own draw with every feature off;
// each new key posts one toast, once. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, WS, aboveAt, featuresOff, panelWorld, pressBrowser, words } from './fixtures-panel'
import type { PanelWorld } from './fixtures-panel'

type M = Mounted<'terminal'>
type E = Engine

const T = { timeoutMs: 30_000 }
const NOTICE = { id: 'n1', key: 'check:important-details', kind: 'check', text: 'The check Important details failed: its model call was refused.', agent: 'Important details', chat: '', at: '2026-10-16T16:10:00Z', acts: [] }

async function start($: E, w: PanelWorld): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

test('notices draw with every feature off: the workspace\'s and the terminal\'s own', T, async ($, on) => {
  const w = panelWorld(on)
  w.t.settings = featuresOff('autoActivate', 'viewProposals', 'labels', 'checks', 'citationMarks', 'coverage', 'cardCheck')
  w.states.home.notices = [NOTICE]
  w.open = { ok: false, error: { code: 'START', message: 'no server', fix: '' } }
  await start($, w)
  await pressBrowser($, w)
  const m = (await $.ui.mount(aboveAt(120))) as unknown as M
  expect(words(await m.find({ type: 'Box', key: 'above-notice-n1' }))).toBe(`  notice${NOTICE.text}dismiss`)
  expect(words(await m.find({ type: 'Box', key: 'above-mod-open-failed' }))).toContain("thimble's page did not start: no server")
  // no summary line: every feature is off and nothing is new
  expect(await m.find({ type: 'Box', key: 'above-summary' })).toBeUndefined()
  await m.unmount()
})

test('each new notice posts one toast, once; the notices there at activation post none', T, async ($, on) => {
  const w = panelWorld(on)
  w.states.home.notices = [{ ...NOTICE, id: 'n0', text: 'An old failure.' }]
  await start($, w)
  const m = (await $.ui.mount(aboveAt(120))) as unknown as M
  await w.clock.settle()
  expect(w.toasts.filter(t => t.includes('An old failure.'))).toEqual([])
  w.states.home.notices = [NOTICE, { ...NOTICE, id: 'n0', text: 'An old failure.' }]
  w.stamps.set(`${WS}/notices.json`, 9)
  await w.clock.advance(1100)
  await w.clock.settle()
  await w.clock.advance(1100)
  await w.clock.settle()
  expect(w.toasts.filter(t => t === `thimble: ${NOTICE.text}`)).toEqual([`thimble: ${NOTICE.text}`])
  // the terminal's own: one toast for a key posted twice
  w.open = { ok: false, error: { code: 'START', message: 'no server', fix: '' } }
  await pressBrowser($, w)
  await w.clock.advance(6000)
  await pressBrowser($, w)
  expect(w.toasts.filter(t => t.startsWith("thimble: thimble's page did not start")).length).toBe(1)
  await m.unmount()
})

test('a writer that starts or ends while no browser shows thimble\'s page: one toast each, saying the report is in the browser workbench', T, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  const agents = w.states.agents as { rows: Record<string, unknown>[] }
  agents.rows = [...agents.rows, { name: 'thimble:writer', label: 'writer: The relay', state: 'running', kind: 'subagent', chat: 'wr1', role: 'writer' }]
  // the writer's document, written meanwhile (the docs area, which the summary's counts follow)
  w.stamps.set(`${WS}/trusted/subagents.json`, 5)
  w.stamps.set(`${WS}/investigations/main/report.json`, 5)
  await w.clock.advance(1100)
  await w.clock.settle()
  expect(w.toasts.filter(t => t.includes('is in the browser workbench'))).toEqual(['thimble: the report "The relay" is in the browser workbench · /thimble open'])
  agents.rows = agents.rows.map(r => (r.chat === 'wr1' ? { ...r, state: 'done' } : r))
  w.stamps.set(`${WS}/trusted/subagents.json`, 6)
  w.stamps.set(`${WS}/investigations/main/report.json`, 6)
  await w.clock.advance(1100)
  await w.clock.settle()
  expect(w.toasts.filter(t => t.includes('is in the browser workbench')).length).toBe(2)
})
