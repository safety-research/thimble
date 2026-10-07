// The file browser and a file as thimble-term draws them: a name cut in
// its middle, a folder of one type's dim dots, what a file opens as, Space to fold; a file opened at a cited record with
// that record lit and its place and `?` under the view; a transcript by thimble's sniff, its tool calls folded; a table
// of records sorted by a column; ← back to the files; a file that cannot be read. `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, WS, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: 'thimble-term', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
const PANE = { plugin: 'thimble-term', component: 'Pane', requestId: 'thimble-term', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 36 }, view: {} } } as never

const CHAT = {
  path: 'chat.jsonl',
  kind: 'records',
  total_lines: 4,
  start: 1,
  transcript: { format: 'messages', score: 0.95, keys: { speaker: 'author', text: 'body', time: 'at' }, tools: true },
  records: [
    { line: 1, record: { author: 'alice', body: 'Who saved the page?', at: '10:00' } },
    { line: 2, record: { author: 'bob', body: 'An agent did, twice.', at: '10:01' } },
    { line: 3, record: { type: 'tool_use', name: 'Read', at: '10:02' } },
    { line: 4, record: { author: 'alice', body: 'Which one?', at: '10:03' } },
  ],
}

const RUNS = {
  path: 'runs.jsonl',
  kind: 'records',
  total_lines: 3,
  start: 1,
  records: [
    { line: 1, record: { run: 'a', score: 3, ok: true } },
    { line: 2, record: { run: 'b', score: 12, ok: false } },
    { line: 3, record: { run: 'c', score: 7, ok: true } },
  ],
}

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

/** The file browser, through a tool's layout record. */
async function browser($: E, w: World): Promise<M> {
  w.states.ui = [{ n: 1, kind: 'layout', args: { layout: 'one', surfaces: ['files'] } }]
  w.stamps.set(`${WS}/ui.jsonl`, 7)
  await w.clock.advance(1100)
  return (await $.ui.mount(PANE)) as unknown as M
}

/** A click on the tree's row that shows `text`, twice (the first chooses, the second opens). */
async function openRow($: E, w: World, pane: M, text: string, times = 2): Promise<M> {
  for (let i = 0; i < times; i++) {
    const rows = ((await pane.drawn({ in: 'm:files-tree' })) as { children?: unknown[] }).children ?? []
    await pane.pointer({ type: 'down', x: 6, y: rows.findIndex(r => shown(r).includes(text)), button: 'left', in: 'm:files-tree' } as never)
    await w.clock.settle()
    await pane.redraw()
  }
  return pane
}

test("the file browser: a long name cut in its middle, its extension kept; a folder of one type's dots dim; the chosen file says what it opens as; Space folds its folder", async ($, on) => {
  const w = world(on)
  w.states.files = [
    { path: 'README.md', kind: 'markdown', size_bytes: 10 },
    { path: 'chat.jsonl', kind: 'records', size_bytes: 10 },
    { path: 'logs/a-very-long-file-name-that-will-not-fit-in-the-column-at-all-really-not.jsonl', kind: 'records', size_bytes: 10 },
    { path: 'logs/b.jsonl', kind: 'records', size_bytes: 10 },
  ]
  w.pages['chat.jsonl'] = CHAT
  await start($, w)
  let pane = await browser($, w)
  pane = await openRow($, w, pane, 'chat.jsonl', 1)
  const tree = ((await pane.drawn({ in: 'm:files-tree' })) as { children?: unknown[] }).children ?? []
  const chosen = tree.find(r => shown(r).includes('chat.jsonl'))
  // the chosen row in the accent across, `❯` before it
  expect(shown(chosen)).toMatch(/^❯/)
  expect(JSON.stringify(chosen)).toContain('"color":"suggestion"')
  expect(shown(await pane.drawn())).toContain('opens as transcript')
  // Space folds the chosen file's folder
  await pane.key({ key: 'space', in: 'm:files-tree' } as never)
  await w.clock.settle()
  await pane.redraw()
  expect(shown(await pane.drawn({ in: 'm:files-tree' }))).toContain('▸ wiki/')
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  const rows = ((await pane.drawn({ in: 'm:files-tree' })) as { children?: unknown[] }).children ?? []
  await pane.pointer({ type: 'down', x: 4, y: rows.findIndex(r => shown(r).includes('logs/')), button: 'left', in: 'm:files-tree' } as never)
  await w.clock.settle()
  await pane.redraw()
  const logs = (((await pane.drawn({ in: 'm:files-tree' })) as { children?: unknown[] }).children ?? []).filter(r => /\.jsonl/.test(shown(r)) && /a-very/.test(shown(r)))
  expect(shown(logs[0])).toMatch(/a-very-long-file-name-th[^ ]*…[^ ]*-not\.jsonl/)
  expect(JSON.stringify(logs[0])).toContain('"color":"inactive"},"children":["●"]')
  await pane.unmount()
})

test("a citation's file opens at its record, lit, with its place a link and a blue `?` under the view; ← goes back to the files", async ($, on) => {
  const w = world(on)
  await start($, w)
  let ui = (await $.ui.mount(MESSAGE('m1', 'The README says [4,579](README.md#L3) pages.'))) as unknown as M
  await w.clock.advance(300)
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('m1', 'The README says [4,579](README.md#L3) pages.'))) as unknown as M
  await ui.pointer({ type: 'down', x: 18, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.pointer({ type: 'up', x: 18, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.unmount()
  await w.clock.settle()
  let pane = (await $.ui.mount(PANE)) as unknown as M
  // f opens the file at the cited record
  await pane.press({ key: 'hk-files' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(JSON.stringify(await pane.drawn({ in: 'm:file-body' }))).toContain('{"type":"Text","props":{"backgroundColor":"selectionBg"},"children":["An export of 4,579 wiki pages and their revisions."]}')
  expect(shown(await pane.drawn({ in: 'file-detail' }))).toBe('↗ README.md line 3  ?')
  await pane.key({ key: 'left', in: 'm:file-body' } as never)
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(await pane.find({ type: 'Client', key: 'm:files-tree' })).toBeDefined()
  await pane.unmount()
})

test("a transcript by thimble's sniff: per turn the speaker bold and the words under the name, a tool call one dim line; tabs Transcript and Raw (1 2)", async ($, on) => {
  const w = world(on)
  w.states.files = [{ path: 'chat.jsonl', kind: 'records', size_bytes: 10 }]
  w.pages['chat.jsonl'] = CHAT
  await start($, w)
  let pane = await browser($, w)
  pane = await openRow($, w, pane, 'chat.jsonl')
  const text = shown(await pane.drawn())
  for (const s of [' Transcript ', ' Raw ', '1 2 3 for the tabs']) expect(text).toContain(s)
  // the selected tab inverse with a cell of space at each side; the first, not selected, starts at the edge
  expect(JSON.stringify(await pane.drawn())).toContain('{"type":"Text","props":{"inverse":true},"children":[" Transcript "]}')
  expect((await pane.find({ type: 'Button', key: 'tab-table' }))?.props).toMatchObject({ label: 'Table ' })
  // the tabs' digits are hidden keys: a Button's hotkey would draw `1:` before its name
  expect(((await pane.find({ type: 'Button', key: 'tab-table' })) as { props?: Record<string, unknown> } | undefined)?.props?.hotkey).toBeUndefined()
  expect(await pane.find({ type: 'Button', key: 'hk-tab0' })).toBeDefined()
  const body = shown(await pane.drawn({ in: 'm:file-body' }))
  for (const s of ['alice', 'Who saved the page?', 'bob', 'An agent did, twice.', '⎿ Read', 'Which one?']) expect(body).toContain(s)
  await pane.unmount()
})

test("a transcript's turn shows its words in up to three rows; its time column the clock alone, the day on a row where it changes", async ($, on) => {
  const w = world(on)
  const long = 'It looks like the agents used the wiki as a relay: each page saved held a note for the next agent, and the notes ran on for days, one after another, with no reply from anyone outside. '.repeat(3)
  w.states.files = [{ path: 'agent-chat.jsonl', kind: 'text', size_bytes: 10 }]
  w.pages['agent-chat.jsonl'] = {
    ...CHAT,
    path: 'agent-chat.jsonl',
    kind: 'text',
    records: [
      { line: 1, record: { author: 'alice', body: long, at: '2026-06-18T07:40:01Z' } },
      { line: 2, record: { author: 'bob', body: 'Yes.', at: '2026-06-18T07:41:30Z' } },
      { line: 3, record: { author: 'alice', body: 'And the next day?', at: '2026-06-19T09:00:00Z' } },
    ],
  }
  await start($, w)
  let pane = await browser($, w)
  pane = await openRow($, w, pane, 'agent-chat.jsonl')
  const rows = ((((await pane.drawn({ in: 'm:file-body' })) as { children?: unknown[] }).children ?? []) as unknown[]).map(r => shown(r).replace(/\s+$/, ''))
  expect(rows[0]!.trim()).toBe('18 Jun 2026')
  expect(rows[1]).toMatch(/^ {2}07:40:01 {2}● alice$/)
  // the long words: three rows, the last cut with `…`
  const words = rows.slice(2, 5)
  expect(words.every(r => r.startsWith(' '.repeat(2 + 8 + 2 + 2)))).toBe(true)
  expect(words[2]).toMatch(/…$/)
  expect(rows[5]).toMatch(/^ {2}07:41:30 {2}● bob$/)
  expect(rows).toContain('  19 Jun 2026')
  expect(rows.join('\n')).not.toContain('T07:40')
  // its type: the file's format, not `text`, which its Transcript tab would contradict
  expect(shown(await pane.drawn())).toContain('jsonl · 3 records')
  await pane.unmount()
})

test('the file browser lists each folder in natural order, as home does; a folder\'s count after its name', async ($, on) => {
  const w = world(on)
  w.states.files = [
    { path: 'pages.jsonl', kind: 'text', size_bytes: 10 },
    { path: 'run-10.jsonl', kind: 'text', size_bytes: 10 },
    { path: 'run-2.jsonl', kind: 'text', size_bytes: 10 },
    { path: 'events.jsonl', kind: 'events', size_bytes: 10 },
  ]
  await start($, w)
  const pane = await browser($, w)
  const tree = ((((await pane.drawn({ in: 'm:files-tree' })) as { children?: unknown[] }).children ?? []) as unknown[]).map(r => shown(r))
  const names = tree.filter(r => /\.jsonl/.test(r)).map(r => r.trim().split(/\s+/)[1])
  expect(names).toEqual(['events.jsonl', 'pages.jsonl', 'run-2.jsonl', 'run-10.jsonl'])
  expect(tree.find(r => r.includes('run-2.jsonl'))).toMatch(/jsonl +10 B$/)
  await pane.unmount()
})

test('a file of records opens as a table of their keys; a click on a column sorts by it, again the other way', async ($, on) => {
  const w = world(on)
  w.states.files = [{ path: 'runs.jsonl', kind: 'records', size_bytes: 10 }]
  w.pages['runs.jsonl'] = RUNS
  await start($, w)
  let pane = await browser($, w)
  pane = await openRow($, w, pane, 'runs.jsonl')
  await pane.press({ key: 'tab-table' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  const rows = () => pane.drawn({ in: 'm:file-body' }).then(t => (((t as { children?: unknown[] }).children ?? []) as unknown[]).map(r => shown(r).trim()))
  let got = await rows()
  expect(got[0]).toMatch(/^run +score +ok$/)
  expect(got.slice(1).map(r => r.split(/\s+/)[0])).toEqual(['a', 'b', 'c'])
  // a click on `score`
  const x = 2 + shown((await rows())[0]).indexOf('score')
  await pane.pointer({ type: 'down', x, y: 0, button: 'left', in: 'm:file-body' } as never)
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  got = await rows()
  expect(got[0]).toContain('score ▲')
  expect(got.slice(1).map(r => r.split(/\s+/)[0])).toEqual(['a', 'c', 'b'])
  await pane.unmount()
})

test('a file that cannot be read says why in the panel and in a toast', async ($, on) => {
  const w = world(on)
  w.states.files = [{ path: 'gone.jsonl', kind: 'records', size_bytes: 10 }]
  w.pages['gone.jsonl'] = null
  await start($, w)
  let pane = await browser($, w)
  pane = await openRow($, w, pane, 'gone.jsonl')
  expect(shown(await pane.drawn())).toContain('× could not read gone.jsonl')
  expect(w.toasts).toContain('thimble: could not read gone.jsonl: could not read gone.jsonl')
  await pane.unmount()
})
