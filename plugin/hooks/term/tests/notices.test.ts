// Notices (notices.tsx, SPEC-v2 3.20): each new notice, the workspace's or the terminal's own, posts one toast, once;
// those there at activation post none. Each is one row above the prompt (band.tsx): `notice` in red, its words in the
// text color cut with `…` where its acts begin (a press shows them whole), its acts at the right in the accent, each
// saying what its press does. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { ABOVE_LABEL } from '../band'
import { cut, width } from '../lib'
import { modActWords, noticeActWords, seeWords } from '../notices'
import { COLORS } from '../paint'
import { CWD, WS, aboveAt, panelWorld, pressBrowser, words } from './fixtures-panel'
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
  // a notice whose text names thimble first toasts as it is (no `thimble: thimble's …`)
  expect(w.toasts.filter(t => t.startsWith("thimble's page did not start")).length).toBe(1)
  await m.unmount()
})

// ------------------------------------------------------------------------------------------------ the notice rows

const SWITCHED = "Claude's safeguards switched a reply of the orientation from Opus 5.5 to Opus 4.8."
const ORIENT = { id: 'n2', key: 'safeguards:c-orient', kind: 'safeguards', text: SWITCHED, agent: 'Orientation', chat: 'c-orient', open: 'agent', at: '2026-10-17T00:05:00Z', acts: [] }

type Node = { type?: string; key?: unknown; props?: Record<string, unknown> & { children?: unknown }; children?: unknown }

/** The Text runs inside an element, each with its look. */
function texts(n: unknown, out: { s: string; color?: unknown; bold?: unknown; dim?: unknown; hover?: unknown; wrap?: unknown }[] = []): typeof out {
  if (Array.isArray(n)) n.forEach(x => texts(x, out))
  else if (n && typeof n === 'object') {
    const o = n as Node & { hover?: unknown }
    if (o.type === 'Text') out.push({ s: words(o), color: o.props?.color, bold: o.props?.bold, dim: o.props?.dimColor, hover: o.hover ?? o.props?.hover, wrap: o.props?.wrap })
    else texts(o.children ?? o.props?.children, out)
  }
  return out
}

test("a notice is one row: `notice` in red on the label column, its words in the text color cut with `…` where its acts begin, the act that opens its agent's chat named for it (`see the orientation ›`)", T, async ($, on) => {
  const w = panelWorld(on)
  w.states.home.notices = [ORIENT]
  await start($, w)
  // 100 columns: the label column (17), the words, two cells, `see the orientation ›  dismiss` (30) at the right
  const m = (await $.ui.mount(aboveAt(100))) as unknown as M
  const row = await m.find({ type: 'Box', key: 'above-notice-n2' })
  const room = 100 - ABOVE_LABEL - 30 - 2
  expect(words(row)).toBe(`  notice${cut(SWITCHED, room)}see the orientation ›dismiss`)
  expect(cut(SWITCHED, room).endsWith('…')).toBe(true)
  expect(width(cut(SWITCHED, room))).toBeLessThanOrEqual(room)
  const looks = texts(row)
  // the label in red; the words in the text color, not a red paragraph
  expect(looks[0]).toMatchObject({ s: '  notice', color: COLORS.problem })
  expect(looks[1]!.color).toBeUndefined()
  // the acts in the accent, underlined under the pointer, the first bold
  expect(looks.find(l => l.s === 'see the orientation ›')).toMatchObject({ color: COLORS.accent, bold: true, hover: { underline: true } })
  expect(looks.find(l => l.s === 'dismiss')).toMatchObject({ color: COLORS.accent, hover: { underline: true } })
  expect(looks.find(l => l.s === 'dismiss')!.bold).toBeUndefined()
  expect(JSON.stringify(row)).not.toContain('open ›')
  // the press opens the orientation's chat in the panel, as its words say
  await m.press({ key: 'above-notice-n2-open' })
  await w.clock.settle()
  expect(w.panes.at(-1)!.title).toBe('Orientation')
  // a press on the words cut short shows them whole, wrapped; a second press cuts them again
  await m.press({ key: 'above-notice-n2-more' })
  await w.clock.settle()
  await m.unmount()
  const open = (await $.ui.mount(aboveAt(100))) as unknown as M
  expect(texts(await open.find({ type: 'Box', key: 'above-notice-n2' }))[1]).toMatchObject({ s: SWITCHED, wrap: 'wrap' })
  await open.press({ key: 'above-notice-n2-more' })
  await w.clock.settle()
  await open.unmount()
  const again = (await $.ui.mount(aboveAt(100))) as unknown as M
  expect(words(await again.find({ type: 'Box', key: 'above-notice-n2' }))).toContain(cut(SWITCHED, room))
  await again.unmount()
  // 150 columns: the words whole, nothing to press on them
  const wide = (await $.ui.mount(aboveAt(150))) as unknown as M
  expect(words(await wide.find({ type: 'Box', key: 'above-notice-n2' }))).toBe(`  notice${SWITCHED}see the orientation ›dismiss`)
  expect(await wide.find({ type: 'Button', key: 'above-notice-n2-more' })).toBeUndefined()
  await wide.unmount()
})

test("a notice's acts say what their press does: `how to fix it` for a toast that says how, `allow in the browser ›` for a ticket, the agent or the thread a press opens", () => {
  expect(noticeActWords({ act: 'settings', label: 'open settings' })).toBe('how to fix it')
  expect(noticeActWords({ act: 'ticket-open', label: 'open ›' })).toBe('allow in the browser ›')
  expect(noticeActWords({ act: 'view-retry', label: 'retry' })).toBe('retry')
  expect(noticeActWords({ act: 'view-propose-now', label: 'Try again' })).toBe('try again')
  expect(modActWords('doctor')).toBe('how to fix it')
  expect(modActWords('copy link')).toBe('copy link')
  expect(seeWords({ open: 'agent', agent: 'Orientation' })).toBe('see the orientation ›')
  expect(seeWords({ open: 'agent', agent: 'View build: Agent Network' })).toBe('see the view build ›')
  expect(seeWords({ open: 'agent', agent: 'the writer' })).toBe('see the writer ›')
  expect(seeWords({ open: 'agent', agent: '' })).toBe('see the agent ›')
  expect(seeWords({ open: 'thread', agent: 'Side thread: Which line?' })).toBe('see the thread ›')
})

test("the terminal's own notice: `doctor` reads `how to fix it`, and its press says in a toast where to look", T, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  w.open = { ok: false, error: { code: 'START', message: 'no server', fix: '' } }
  await pressBrowser($, w)
  await w.clock.settle()
  const m = (await $.ui.mount(aboveAt(120))) as unknown as M
  const row = await m.find({ type: 'Box', key: 'above-mod-open-failed' })
  expect(words(row)).toBe("  noticethimble's page did not start: no servertry againhow to fix itdismiss")
  expect(texts(row).find(l => l.s === 'try again')).toMatchObject({ color: COLORS.accent, bold: true })
  await m.press({ key: 'above-mod-open-failed-act-1' })
  await w.clock.settle()
  expect(w.toasts.at(-1)).toContain('thimble doctor')
  await m.unmount()
})
