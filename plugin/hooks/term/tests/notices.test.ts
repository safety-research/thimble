// Notices (notices.tsx, SPEC-v2 3.20): each new notice, the workspace's or the terminal's own, posts one toast, once;
// those there at activation post none. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, WS, aboveAt, panelWorld, pressBrowser } from './fixtures-panel'
import type { PanelWorld } from './fixtures-panel'

type M = Mounted<'terminal'>
type E = Engine

const T = { timeoutMs: 30_000 }
const NOTICE = { id: 'n1', key: 'check:important-details', kind: 'check', text: 'The check Important details failed: its model call was refused.', agent: 'Important details', chat: '', at: '2026-10-16T16:10:00Z', acts: [] }

async function start($: E, w: PanelWorld): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

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
