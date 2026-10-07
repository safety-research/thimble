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
// a pane tall enough for home whole: keys.test.ts draws the lists in a pane shorter than they are
const PANE = { plugin: 'thimble-term', component: 'Pane', requestId: 'thimble-term', surface: 'terminal', viewport: { columns: 120, rows: 124 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 120 }, view: {} } } as never

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

/** The tree's row that shows `text` chosen: a click on it, unless it is chosen already (the first file is, as the
 *  browser opens: live check term-fix9, quirk 7), where a click would open it. */
async function chooseRow($: E, w: World, pane: M, text: string): Promise<M> {
  const rows = ((await pane.drawn({ in: 'm:files-tree' })) as { children?: unknown[] }).children ?? []
  if (shown(rows.find(r => shown(r).includes(text))).startsWith('❯')) return pane
  return openRow($, w, pane, text, 1)
}

/** A click on the tree's row that shows `text`, twice (the first chooses, the second opens); a row chosen already (the
 *  first file, chosen as the browser opens) opens at the first. */
async function openRow($: E, w: World, pane: M, text: string, times = 2): Promise<M> {
  for (let i = 0; i < times; i++) {
    const tree = await pane.drawn({ in: 'm:files-tree' }).catch(() => null)
    if (!tree) break
    const rows = (tree as { children?: unknown[] }).children ?? []
    await pane.pointer({ type: 'down', x: 6, y: rows.findIndex(r => shown(r).includes(text)), button: 'left', in: 'm:files-tree' } as never)
    await w.clock.settle()
    await pane.redraw()
  }
  return pane
}

test("the file browser: a long name cut in its middle, its extension kept; no dots, a folder's size; the chosen file says what it opens as; Space folds its folder", async ($, on) => {
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
  pane = await chooseRow($, w, pane, 'chat.jsonl')
  const tree = ((await pane.drawn({ in: 'm:files-tree' })) as { children?: unknown[] }).children ?? []
  const chosen = tree.find(r => shown(r).includes('chat.jsonl'))
  // the chosen row in the accent across, `❯` before it
  expect(shown(chosen)).toMatch(/^❯/)
  expect(JSON.stringify(chosen)).toContain('"color":"suggestion"')
  expect(shown(await pane.drawn())).toContain('opens as transcript')
  // no file has a dot, as home lists them: the type column names the type (live check New 10); its name at A4
  const readme = tree.find(r => shown(r).includes('README.md'))
  expect(shown(tree)).not.toContain('●')
  expect(shown(readme)).toMatch(/^ {6}README\.md /)
  // each folder's size against R, as home shows it
  expect(shown(tree.find(r => shown(r).includes('wiki/')))).toMatch(/▾ wiki\/ {2}2 +20 B$/)
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
  expect(shown(tree.find(r => shown(r).includes('logs/')) ?? '')).toMatch(/logs\/ {2}2 +20 B$/)
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

test("a transcript by thimble's sniff: per turn the speaker bold and the words under the name, a tool call one dim line; tabs Table, Transcript, JSON and Raw (1 2 3 4)", async ($, on) => {
  const w = world(on)
  w.states.files = [{ path: 'chat.jsonl', kind: 'records', size_bytes: 10 }]
  w.pages['chat.jsonl'] = CHAT
  await start($, w)
  let pane = await browser($, w)
  pane = await openRow($, w, pane, 'chat.jsonl')
  const text = shown(await pane.drawn())
  for (const s of [' Transcript ', ' JSON ', ' Raw ', '1 2 3 4 for the tabs']) expect(text).toContain(s)
  // every tab with a cell of space at each side, selected or not, the selected one inverse; the row starts a cell left
  // of the edge, in the margin, so the first tab's name starts at the edge, where the title starts
  expect(JSON.stringify(await pane.drawn())).toContain('{"type":"Text","props":{"inverse":true},"children":[" Transcript "]}')
  expect((await pane.find({ type: 'Button', key: 'tab-table' }))?.props).toMatchObject({ label: ' Table ' })
  expect((await pane.find({ type: 'Box', key: 'm:file-tabs' }))?.props).toMatchObject({ paddingLeft: 1 })
  const tabsBefore = shown(await pane.find({ type: 'Box', key: 'm:file-tabs' }))
  expect(tabsBefore).toBe(' Table  Transcript  JSON  Raw ')
  // the tabs' digits are hidden keys: a Button's hotkey would draw `1:` before its name
  expect(((await pane.find({ type: 'Button', key: 'tab-table' })) as { props?: Record<string, unknown> } | undefined)?.props?.hotkey).toBeUndefined()
  expect(await pane.find({ type: 'Button', key: 'hk-tab0' })).toBeDefined()
  const body = shown(await pane.drawn({ in: 'm:file-body' }))
  for (const s of ['alice', 'Who saved the page?', 'bob', 'An agent did, twice.', '⎿ Read', 'Which one?']) expect(body).toContain(s)
  // another tab chosen: the row reads the same, cell for cell, so no tab moves
  await pane.press({ key: 'hk-tab0' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(JSON.stringify(await pane.drawn())).toContain('{"type":"Text","props":{"inverse":true},"children":[" Table "]}')
  expect(shown(await pane.find({ type: 'Box', key: 'm:file-tabs' }))).toBe(tabsBefore)
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
  // its type: what it opens as, a transcript (its tab says so), not `text` or its format
  expect(shown(await pane.drawn())).toContain('transcript · 3 records')
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
  const names = tree.filter(r => /\.jsonl/.test(r)).map(r => r.replace(/^❯/, '').trim().split(/\s+/)[0])
  expect(names).toEqual(['events.jsonl', 'pages.jsonl', 'run-2.jsonl', 'run-10.jsonl'])
  // the first file is chosen as the browser opens (live check term-fix9, quirk 7)
  expect(tree.find(r => r.includes('events.jsonl'))).toMatch(/^❯/)
  expect(tree.find(r => r.includes('run-2.jsonl'))).toMatch(/jsonl +10 B$/)
  await pane.unmount()
})

test('a file of uniform records opens as a table of their keys, as the browser scores it; a click on a column sorts by it, again the other way', async ($, on) => {
  const w = world(on)
  w.states.files = [{ path: 'runs.jsonl', kind: 'records', size_bytes: 10 }]
  w.pages['runs.jsonl'] = RUNS
  await start($, w)
  let pane = await browser($, w)
  pane = await openRow($, w, pane, 'runs.jsonl')
  // the Table tab first: records that share their keys (frontend views/table.tsx tableScore 0.85)
  expect(JSON.stringify(await pane.drawn())).toContain('{"type":"Text","props":{"inverse":true},"children":[" Table "]}')
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

test("a file thimble knows only as text that opens as a transcript says `transcript` in the type column, in the file browser and on home, as its preview and its view do", async ($, on) => {
  const w = world(on)
  w.states.files = [{ path: 'agent-chat.jsonl', kind: 'text', size_bytes: 10 }, { path: 'pages.jsonl', kind: 'text', size_bytes: 10 }]
  // thimble's sniff, read for the files of plain text (live check Q17)
  w.opens = { 'agent-chat.jsonl': 'transcript' }
  w.pages['agent-chat.jsonl'] = { ...CHAT, path: 'agent-chat.jsonl', kind: 'text' }
  await start($, w)
  let pane = await browser($, w)
  await w.clock.settle()
  await pane.redraw()
  const tree = ((await pane.drawn({ in: 'm:files-tree' })) as { children?: unknown[] }).children ?? []
  expect(shown(tree.find(r => shown(r).includes('agent-chat.jsonl')))).toMatch(/agent-chat\.jsonl +transcript +10 B$/)
  expect(shown(tree.find(r => shown(r).includes('pages.jsonl')))).toMatch(/pages\.jsonl +jsonl +10 B$/)
  expect(w.calls.some(c => c[2] === 'opens' && JSON.parse(c[5]!).includes('agent-chat.jsonl'))).toBe(true)
  pane = await chooseRow($, w, pane, 'agent-chat.jsonl')
  expect(shown(await pane.drawn())).toContain('opens as transcript')
  await pane.unmount()
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  const home = (await $.ui.mount(PANE)) as unknown as M
  const lines = (((await home.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r))
  expect(lines.find(l => l.includes('agent-chat.jsonl'))).toMatch(/agent-chat\.jsonl +transcript +10 B$/)
  await home.unmount()
})

test("the Raw tab shows a file's lines as the file holds them: a transcript's records as their JSON lines; the file browser's preview shows the mode the file opens in", async ($, on) => {
  const w = world(on)
  w.states.files = [{ path: 'chat.jsonl', kind: 'records', size_bytes: 10 }]
  w.pages['chat.jsonl'] = CHAT
  await start($, w)
  let pane = await browser($, w)
  pane = await chooseRow($, w, pane, 'chat.jsonl')
  // the preview: the file's first turns, as it opens, each on one row, not its lines
  const preview = shown(await pane.drawn())
  expect(preview).toContain('opens as transcript')
  expect(preview).toContain('Who saved the page?')
  expect(preview).not.toContain('{"author": "alice"')
  // a second click on the chosen file opens it
  pane = await openRow($, w, pane, 'chat.jsonl', 1)
  await pane.press({ key: 'hk-tab3' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  const body = shown(await pane.drawn({ in: 'm:file-body' }))
  // live check New 12: Raw showed each record's words
  expect(body).toContain('{"author": "bob", "body": "An agent did, twice.", "at": "10:01"}')
  expect(body).toContain('{"type": "tool_use", "name": "Read", "at": "10:02"}')
  await pane.unmount()
})

test("a click on the path's `files` step goes back to the file browser, never a step pushed after the file", async ($, on) => {
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
  await pane.press({ key: 'hk-files' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.find({ key: 'way' }))).toMatch(/home › citation 4,579 › files › README\.md/)
  const up = ((await pane.findAll({ type: 'Button' })) as { key?: string }[]).find(b => String(b.key).startsWith('crumb-up-'))!
  await pane.press({ key: up.key! })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  const way = shown(await pane.find({ key: 'way' }))
  expect(way).toMatch(/home › citation 4,579 › files(?! ›)/)
  expect(way).not.toContain('README.md')
  expect(await pane.find({ type: 'Client', key: 'm:files-tree' })).toBeDefined()
  await pane.unmount()
})

// a one-line JSON file of an agent's conversations, kept as a store of messages that each conversation lists by id:
// thimble parses the whole file into turns, all on line 1, the system prompt first and each conversation a group
const STORE_LINE = '{"agent": "a7", "system": [{"type": "text", "text": "You maintain a small app."}], "messages": {"m0": {"role": "user", "content": "Why does the build fail?"}}, "conversations": {"c1": {"id": "c1", "messages": ["m0"]}}}'
const STORE = { path: 'agent.json', kind: 'text', total_lines: 1, start: 1, transcript: { format: 'json', score: 0.95 }, records: [{ line: 1, record: { text: STORE_LINE } }] }
const STORE_TURNS = {
  path: 'agent.json',
  total: 6,
  start: 0,
  n_groups: 2,
  groups: { '0': { title: 'a7 · c1', first: 1 }, '1': { title: 'a7 · c2 (forked from c1 after message 2)', first: 3 } },
  turns: [
    { i: 0, line: 1, speaker: 'system', role: 'system', text: 'You maintain a small app.' },
    { i: 1, line: 1, speaker: 'user', role: 'user', text: 'Why does the build fail?', group: 0, time: '2026-09-21T14:13:20Z' },
    { i: 2, line: 1, speaker: 'assistant', role: 'assistant', text: 'The groupby test drops the NaN key.', group: 0, time: '2026-09-21T14:13:21Z' },
    { i: 3, line: 1, speaker: 'user', role: 'user', text: 'Try the other branch.', group: 1, time: '2026-09-21T14:13:22Z' },
    { i: 4, line: 1, speaker: 'assistant', role: 'assistant', text: 'On the other branch the build passes.', group: 1, time: '2026-09-21T14:13:23Z' },
    // a tool's colored output, as a transcript keeps it: its escape sequences are not drawn
    { i: 5, line: 1, speaker: 'user', role: 'user', text: '\u001b[32m3 passed\u001b[0m in 0.4s\u0007', group: 1, time: '2026-09-21T14:13:24Z' },
  ],
}

test("a whole-file JSON transcript shows the turns thimble parses from the whole file: each conversation's title on a row where it starts, and the turns of its one line told apart", async ($, on) => {
  const w = world(on)
  w.states.files = [{ path: 'agent.json', kind: 'text', size_bytes: 10 }]
  w.opens = { 'agent.json': 'transcript' }
  w.pages['agent.json'] = STORE
  w.turns['agent.json'] = STORE_TURNS
  await start($, w)
  let pane = await browser($, w)
  pane = await chooseRow($, w, pane, 'agent.json')
  expect(shown(await pane.drawn())).toContain('opens as transcript')
  pane = await openRow($, w, pane, 'agent.json', 1)
  expect(w.calls.some(c => c[2] === 'turns' && c[5] === 'agent.json')).toBe(true)
  const text = shown(await pane.drawn())
  expect(text).toContain('transcript · turns 1-6 of 6')
  expect(shown(await pane.find({ type: 'Box', key: 'm:file-tabs' }))).toBe(' Transcript  JSON  Raw ')
  const rows = ((((await pane.drawn({ in: 'm:file-body' })) as { children?: unknown[] }).children ?? []) as unknown[]).map(r => shown(r).trim())
  const at = (s: string) => rows.findIndex(r => r.includes(s))
  // the system prompt before the conversations, then each conversation's title over its turns
  expect(at('You maintain a small app.')).toBeLessThan(at('a7 · c1'))
  expect(at('a7 · c1')).toBeLessThan(at('Why does the build fail?'))
  expect(at('a7 · c2 (forked from c1 after message 2)')).toBeLessThan(at('Try the other branch.'))
  expect(at('a7 · c2 (forked from c1 after message 2)')).toBeGreaterThan(at('The groupby test drops the NaN key.'))
  expect(rows).toContain('3 passed in 0.4s')
  expect(JSON.stringify(await pane.drawn())).not.toMatch(/\\u001b|\\u0007/)
  // ↓ chooses the next turn, though every turn stands on line 1: one turn is lit, not all
  await pane.key({ key: 'down', in: 'm:file-body' } as never)
  await w.clock.settle()
  await pane.key({ key: 'down', in: 'm:file-body' } as never)
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  const lit = ((((await pane.drawn({ in: 'm:file-body' })) as { children?: unknown[] }).children ?? []) as unknown[]).filter(r => /^❯/.test(shown(r)))
  expect(lit.map(r => shown(r))).toEqual([expect.stringContaining('user')])
  expect(shown(await pane.drawn({ in: 'file-detail' }))).toBe('↗ agent.json line 1  ?')
  await pane.unmount()
})

test("a whole-file JSON transcript whose parse finds no turns opens as its lines, and the type column stops saying transcript", async ($, on) => {
  const w = world(on)
  w.states.files = [{ path: 'agent.json', kind: 'text', size_bytes: 10 }]
  w.opens = { 'agent.json': 'transcript' }
  w.pages['agent.json'] = STORE
  await start($, w)
  let pane = await browser($, w)
  pane = await openRow($, w, pane, 'agent.json')
  const text = shown(await pane.drawn())
  expect(text).not.toContain('Transcript')
  expect(text).not.toContain('holds no messages')
  expect(text).toContain('json · lines 1-1 of 1')
  expect(shown(await pane.drawn({ in: 'm:file-body' }))).toContain('{"agent": "a7"')
  await pane.key({ key: 'backspace', in: 'm:file-body' } as never)
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  const tree = ((await pane.drawn({ in: 'm:files-tree' })) as { children?: unknown[] }).children ?? []
  expect(shown(tree.find(r => shown(r).includes('agent.json')))).toMatch(/agent\.json +json +10 B$/)
  await pane.unmount()
})
