// The panel: a side thread that answers (what it is about, `stop`, its field), the views pane (each view by its glyph
// and name, `new` once built, a click opens it), and home with no files, `/thimble files` opening Coverage.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, WS, shown, takesKeys, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

// a pane tall enough for home whole
const PANE = { plugin: 'thimble', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 120, rows: 124 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 120 }, view: {} } } as never

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

async function home($: E, w: World): Promise<M> {
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  return (await $.ui.mount(PANE)) as unknown as M
}

/** A click on the home panel's row that shows `text`; the panel drawn again. */
async function homeClick($: E, w: World, pane: M, text: string, x = 4): Promise<M> {
  const rows = ((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []
  const y = rows.findIndex(r => shown(r).includes(text))
  expect(y).toBeGreaterThan(0)
  await pane.pointer({ type: 'down', x, y, button: 'left', in: 'm:home' } as never)
  await w.clock.settle()
  await takesKeys($)
  await pane.unmount()
  return (await $.ui.mount(PANE)) as unknown as M
}

test("a thread that answers: what it is about, dim, before its first question; `stop` (s) ends it; Enter or a give the field the keys; a question asked meanwhile waits", { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  w.chats.t2 = { meta: { ...w.states.threads[2] }, events: [{ type: 'user', text: 'which pages were deleted?' }, { type: 'tool_use', id: 'u1', name: 'Bash', input: {} }] }
  await start($, w)
  let pane = await home($, w)
  pane = await homeClick($, w, pane, '"which pages were deleted?"')
  const text = shown(await pane.drawn())
  expect(text).toContain('about "the deletions"')
  expect(text).toContain('◌ 1 tool call')
  expect(text).toContain('stop')
  expect(text).toContain('↑↓ to choose · Enter or a to ask · s to stop · b to go back · x to close')
  await pane.press({ key: 'hk-stop' })
  await w.clock.settle()
  expect(w.acts).toContainEqual({ kind: 'stop', payload: { agent: 't2' } })
  // a gives the ask field the keys
  await pane.press({ key: 'hk-ask' })
  await w.clock.settle()
  const field = ((await pane.findAll({ type: 'Input' })) as { key?: string }[]).find(i => String(i.key).startsWith('ask-'))!
  await pane.input({ key: field.key!, text: 'And in June?' })
  await w.clock.settle()
  expect(w.toasts).toContain('the side thread is still answering: your question waits until it ends')
  await pane.unmount()
})

test('home names what a side thread is about by its place when thimble named the thread by its question', async ($, on) => {
  // bug hunt D7: a thread asked with no title of its own is named by its question (agents.question_title), which is no
  // citation's words to show as its subject
  const w = world(on)
  const question = 'what did bot-07 write on the welcome page?'
  w.states.threads = [...w.states.threads, { id: 't3', kind: 'thread', role: 'thread', title: question, question, anchor: 'pages.jsonl#L3', anchor_text: 'Bot-07 wrote it in June.', parent: 'main', created_at: '2026-10-06T10:05:00+00:00', running: false, answers: 1, seen: 1 }] as never
  await start($, w)
  const pane = await home($, w)
  const rows = (((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r))
  const row = rows.find(r => r.includes('what did bot-07 write'))
  expect(row).toContain('about pages.jsonl line 3')
  await pane.unmount()
})

test("home lists no files and `/thimble files` opens Coverage: the terminal has no file browser", async ($, on) => {
  // Matt (10-16): a file viewer in the terminal reinvents the wheel; files show only to verify a place, and the Files
  // section folds into Coverage
  const w = world(on)
  w.states.files = Array.from({ length: 25 }, (_, i) => ({ path: `logs/run-${i + 1}.txt`, kind: 'text', size_bytes: 100 }))
  await start($, w)
  const pane = await home($, w)
  const rows = (((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r))
  expect(rows.some(r => /run-\d+\.txt|logs\//.test(r))).toBe(false)
  await pane.unmount()
  await $.command.run({ command: 'thimble:thimble', args: 'files' } as never)
  await w.clock.settle()
  expect(w.panes.at(-1)!.title).toBe('Coverage')
})

test('the views pane: each view by its glyph and name, its files at R, `new` once built; ↑↓ choose, a click opens its line', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  w.states.home = { ...w.states.home, views: [{ slug: 'board', name: 'Board', status: 'building', ts: '2026-10-07T02:00:00Z', files: ['board.jsonl'] }] } as never
  await start($, w)
  w.states.home = { ...w.states.home, views: [{ slug: 'board', name: 'Board', status: 'built', ts: '2026-10-07T02:00:00Z', files: ['board.jsonl'] }, { slug: 'x', name: 'Broken', status: 'failed', ts: '2026-10-07T01:00:00Z', files: [] }] } as never
  w.stamps.set(`${WS}/views/proposals.json`, 3)
  await w.clock.advance(1100)
  let pane = await home($, w)
  pane = await homeClick($, w, pane, 'Views (2)')
  const text = shown(await pane.drawn())
  expect(text).toContain('2 views · 1 built')
  const list = (((await pane.drawn({ in: 'm:views-list' })) as { children?: unknown[] }).children ?? []).map(r => shown(r))
  expect(list[0]).toMatch(/● Board +board\.jsonl {2}new$/)
  expect(list[1]).toMatch(/× Broken$/)
  expect(text).toContain('↑↓ to choose · Enter to open · b to go back · x to close')
  await pane.press({ key: 'view-open-0' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('Board')
  expect(w.panes.at(-1)!.title).toBe('Board')
  await pane.unmount()
})
