// thimble-term in a session, against the fixture states (tests/fixtures.ts): its scope, a turn's cards drawn once under
// the turn's last reply, citations as links (red when they do not hold), main's end token hidden, the rows above the
// prompt, /thimble, the panel's views, a label verdict, a side thread asked and answered.
// `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { HOME_LINE } from '../hooks/register'
import { CLI, CWD, WS, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const MESSAGE = (requestId: string, text: string, first = true) =>
  ({ plugin: 'thimble-term', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: first } }) as never
const PANE = { plugin: 'thimble-term', component: 'Pane', requestId: 'thimble-term', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 36 }, view: {} } } as never
const ABOVE = { plugin: 'thimble-term', component: 'AbovePrompt', requestId: 'above', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 130, scroll: { bodyRows: 10 }, view: {} } } as never

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

/** A turn of main's: its prompt, a call that made a card, its reply rows (by uuid), its end. */
async function turn($: E, w: World, rows: [string, string][], call = { tool: 'mcp__plugin_thimble_thimble__add_card', text: 'card:ff73e071\n[out0: table]' }): Promise<void> {
  w.toolText = call.text
  await $.turn.start({ text: 'How many pages?', turnId: 't1' } as never)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: rows[0]![0], message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: rows[0]![1] }] } } as never).catch(() => undefined)
  await $.tool.call({ tool: call.tool, tool_use_id: 'u1', question: 'q', code: 'df' } as never)
  for (const [uuid, text] of rows.slice(1)) await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] } } as never).catch(() => undefined)
  await $.turn.complete({ turnId: 't1', answer: rows.at(-1)![1], durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
}

test('outside terminal mode thimble-term draws nothing and runs nothing', async ($, on) => {
  const w = world(on, { mode: 'browser' })
  await start($, w)
  const ui = await $.ui.mount(MESSAGE('m1', 'The export holds [4579](card:ff73e071#pages/TOTAL) pages. (shown in the dashboard)'))
  expect(shown(await ui.drawn())).toBe('(the engine row)')
  await ui.unmount()
  const above = await $.ui.mount(ABOVE)
  expect(shown(await above.drawn())).toBe('(the engine row)')
  await above.unmount()
  expect(w.calls).toEqual([])
  const r = await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  expect(JSON.stringify(r)).not.toContain('terminal mode')
})

test('with no workspace in the environment it stays idle too', async ($, on) => {
  const w = world(on, { ws: null })
  await start($, w)
  expect(w.calls).toEqual([])
})

test("a turn's card is drawn once, under the turn's last reply, with its takeaway; no hex id; a wrong value is red", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r0', 'Let me count.'], ['r1', 'Here is the count.']])
  // the earlier reply row of the turn carries no card
  const early = (await $.ui.mount(MESSAGE('r0', 'Let me count.'))) as unknown as M
  expect(await early.find({ type: 'Client', key: 'card-t0-ff73e071' })).toBeUndefined()
  await early.unmount()
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here is the count.', false))) as unknown as M
  expect((await ui.findAll({ type: 'Client', key: 'card-t0-ff73e071' })).length).toBe(1)
  const card = shown(await ui.drawn({ in: 'card-t0-ff73e071' }))
  expect(card).toContain('What does the export hold per wiki?')
  expect(card).toContain('probier')
  expect(card).not.toContain('ff73e071')
  // the takeaway under the card: its citations checked, the one whose place shows another value red
  const tk = JSON.stringify(await ui.drawn({ in: 'para-tk-t0-1' }))
  expect(tk).toContain('4579')
  expect(tk).toMatch(/"color":"error"[^}]*\},"children":\["14592"\]/)
  expect(tk).not.toMatch(/"color":"error"[^}]*\},"children":\["4579"\]/)
  await ui.unmount()
  // the card was read with `thimble state card`, its citations with one `thimble state resolve`
  expect(w.calls.some(c => c.join(' ') === `${CLI} state card --cwd ${CWD} ff73e071`)).toBe(true)
  expect(w.calls.filter(c => c[2] === 'resolve').length).toBe(1)
})

test('a card shows its last state: a change on disk draws it again', async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Here.']])
  w.cells.ff73e071!.title = 'Pages and revisions per wiki'
  w.stamps.set(`${WS}/notebooks`, 2)
  await w.clock.advance(1100)
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  expect(shown(await ui.drawn({ in: 'card-t0-ff73e071' }))).toContain('Pages and revisions per wiki')
  await ui.unmount()
  expect(w.calls.some(c => c[2] === 'cards' && c.includes('--since'))).toBe(true)
})

test("main's end token is hidden; a reply that is only the token draws nothing", async ($, on) => {
  const w = world(on)
  await start($, w)
  const only = await $.ui.mount(MESSAGE('m2', '(shown in the dashboard)'))
  expect(shown(await only.drawn())).toBe('')
  await only.unmount()
  const some = await $.ui.mount(MESSAGE('m3', 'Done. (shown in the dashboard)'))
  const text = shown(await some.drawn())
  expect(text).toContain('Done.')
  expect(text).not.toContain('shown in the dashboard')
  await some.unmount()
})

test("a reply's citation is a link; a click opens the panel on its place with the value marked", async ($, on) => {
  const w = world(on)
  await start($, w)
  const ui = (await $.ui.mount(MESSAGE('m4', 'The README says [4,579](README.md#L3) pages.'))) as unknown as M
  await w.clock.advance(300)
  await ui.redraw()
  const para = await ui.drawn({ in: 'para-1' })
  expect(shown(para)).toContain('4,579')
  expect(JSON.stringify(para)).toContain('"underline":true')
  // the citation sits after "The README says " on the paragraph's first row
  await ui.pointer({ type: 'down', x: 18, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.pointer({ type: 'up', x: 18, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.unmount()
  expect(w.opened).toContain('thimble-term')
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const text = shown(await pane.drawn())
  expect(text).toContain('4,579')
  expect(text).toContain('the value is at its place')
  expect(text).toContain('README.md line 3')
  expect(text).toContain('An export of 4,579 wiki pages')
  // the cited value on the selection background
  expect(JSON.stringify(await pane.drawn())).toContain('{"type":"Text","props":{"backgroundColor":"selectionBg"},"children":["4,579"]}')
  await pane.unmount()
})

test('the rows above the prompt: what the workspace holds, the agents at work, threads with news', async ($, on) => {
  const w = world(on)
  await start($, w)
  const above = (await $.ui.mount(ABOVE)) as unknown as M
  const text = shown(await above.drawn())
  expect(text).toContain('12 cards · 1 label · 1 document · 2 threads')
  expect(text).toContain('home ›')
  expect(text).toContain('orientation: the whole corpus')
  expect(text).toContain('working')
  expect(text).toContain('1 new')
  expect(text).toContain('1 answering')
  await above.press({ key: 'above-home-open' })
  expect(w.opened).toContain('thimble-term')
  await above.unmount()
})

test('/thimble opens the home panel with no model turn; the panel lists the documents, threads, cards, labels and files', async ($, on) => {
  const w = world(on)
  await start($, w)
  const r = (await $.command.run({ command: 'thimble:thimble', args: '' } as never)) as { text?: string }
  expect(r.text).toBe(HOME_LINE)
  // its row says the line as thimble's, not under the plugin's name
  const row = await $.ui.mount({ plugin: 'thimble-term', component: 'CommandOutput', requestId: 'c1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { command: 'thimble:thimble', args: '', text: `thimble-term: ${HOME_LINE}`, isErrored: false } } as never)
  expect(shown(await row.drawn())).toBe(HOME_LINE)
  await row.unmount()
  expect(w.opened).toEqual(['thimble-term'])
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const home = shown(await pane.drawn({ in: 'home' }))
  for (const s of ['Reports', 'Agents used the dse wiki as a relay', 'Side threads', '"why is events.jsonl bigger?"', 'Cards', 'Your work', 'Labels', 'links through a fetch proxy', 'Files', 'revisions.jsonl']) expect(home).toContain(s)
  await pane.unmount()
})

test("a right-click on a card's cell: the menu opens its cell, asks about it, opens the card", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Here.']])
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  const key = 'card-t0-ff73e071'
  await ui.resize({ columns: 100, rows: 14, in: key })
  // the table's first row of cells (rule, title, column names, then dse): its pages
  const lines = ((await ui.drawn({ in: key })) as { children?: unknown[] }).children ?? []
  const y = lines.findIndex(l => /^dse/.test(shown(l)))
  expect(y).toBeGreaterThan(0)
  await ui.pointer({ type: 'down', x: 12, y, button: 'right', in: key } as never)
  await ui.pointer({ type: 'up', x: 12, y, button: 'right', in: key } as never)
  await ui.unmount()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('dse · pages: 3908')
  expect((await pane.find({ key: 'menu-open' }))?.text).toBe('open its cell')
  expect(await pane.find({ key: 'menu-thread' })).toBeDefined()
  expect(await pane.find({ key: 'menu-card' })).toBeDefined()
  await pane.press({ key: 'menu-open' })
  await w.clock.settle()
  await pane.redraw()
  const text = shown(await pane.drawn())
  expect(text).toContain('the value is at its place')
  expect(text).toContain('What does the export hold per wiki?')
  // the cited cell on the selection background, in the card drawn under it
  expect(JSON.stringify(await pane.drawn())).toMatch(/"backgroundColor":"selectionBg"\},"children":\["3908"\]/)
  await pane.unmount()
})

test("a label card's verdict goes to thimble as the analyst's, and the label is read again", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Labelled.']], { tool: 'mcp__plugin_thimble_thimble__apply_label', text: "applied label links [[concept:d9b51617]] over 14591 record(s): proxy-link 5191, none 9400. The label's card is [[card:l0label0]]." })
  const ui = (await $.ui.mount(MESSAGE('r1', 'Labelled.'))) as unknown as M
  const key = 'card-t0-l0label0'
  expect(shown(await ui.drawn({ in: key }))).toContain('proxy-link')
  await ui.post({ type: 'label-verdict', card: 'l0label0', slug: 'd9b51617', ref: 'revisions.jsonl#L10566', value: 'none', origin: 'x', gestures: [] }, { in: key })
  await ui.unmount()
  expect(w.acts).toContainEqual({ kind: 'verdict', payload: { label: 'd9b51617', ref: 'revisions.jsonl#L10566', value: 'none' } })
  expect(w.calls.filter(c => c[2] === 'label').length).toBeGreaterThanOrEqual(2)
})

test("a side thread asked about a card: the ask field posts the thread, and the panel shows it", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Here.']])
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  await ui.press({ key: 'ask-card-0' })
  await ui.unmount()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('ask about card')
  await pane.input({ key: 'ask-new', text: 'Why is dse so big?' })
  await w.clock.settle()
  expect(w.acts).toContainEqual({ kind: 'thread', payload: { anchor: 'card:ff73e071', message: 'Why is dse so big?' } })
  await pane.redraw()
  expect(shown(await pane.drawn())).toContain('"a question"')
  await pane.unmount()
})

test("an answer that comes in while the panel shows something else: a row under main's latest row, and news above the prompt", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Asked.']])
  const t2 = w.states.threads.find(t => t.id === 't2')! as Record<string, unknown>
  Object.assign(t2, { running: false, answers: 1, seen: 0 })
  w.stamps.set(`${WS}/chats`, 5)
  await w.clock.advance(1100)
  const ui = (await $.ui.mount(MESSAGE('r1', 'Asked.'))) as unknown as M
  const text = shown(await ui.drawn())
  expect(text).toContain('↳ thread · "which pages were deleted?" new · answered')
  await ui.press({ key: 'signal-open-t2' })
  await ui.unmount()
  // opening it marks it seen in the chat's meta
  await w.clock.settle()
  expect(w.acts).toContainEqual({ kind: 'seen', payload: { thread: 't2' } })
})

/** The row of a Client's drawing that shows `text`. */
async function rowOf(m: M, key: string, text: string): Promise<number> {
  const tree = (await m.drawn({ in: key })) as { children?: unknown[]; props?: { children?: unknown[] } }
  const rows = (tree.children ?? tree.props?.children ?? []) as unknown[]
  return rows.findIndex(r => shown(r).includes(text))
}

test('from home, a document opens with its sections, its figures as cards and its citations as links', async ($, on) => {
  const w = world(on)
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const y = await rowOf(pane, 'home', 'Agents used the dse wiki as a relay')
  expect(y).toBeGreaterThan(0)
  await pane.pointer({ type: 'down', x: 4, y, button: 'left', in: 'home' } as never)
  await w.clock.settle()
  await pane.redraw()
  const text = shown(await pane.drawn())
  for (const s of ['home', 'Agents used the dse wiki as a relay', 'document · 2 sections · 2 citations · 1 card', 'Contents', 'The data', 'The main claim', 'The export per wiki.']) expect(text).toContain(s)
  expect(await pane.find({ type: 'Client', key: 'card-f0-0-ff73e071' })).toBeDefined()
  expect(shown(await pane.drawn({ in: 'para-d0-0-1' }))).toContain('4579')
  // back leads home again
  await pane.press({ key: 'nav-back' })
  await w.clock.settle()
  await pane.redraw()
  expect(await pane.find({ type: 'Client', key: 'home' })).toBeDefined()
  await pane.unmount()
})

test("a tool's layout record opens the files; a file opens on its lines; an agent's pane opens from the row above the prompt", async ($, on) => {
  const w = world(on)
  await start($, w)
  // set_layout(files) in a tool call of main's: a record in ui.jsonl, which the renderer follows
  w.states.ui = [{ n: 1, kind: 'layout', args: { layout: 'one', surfaces: ['files'] } }]
  w.stamps.set(`${WS}/ui.jsonl`, 7)
  await w.clock.advance(1100)
  expect(w.opened).toEqual(['thimble-term'])
  const pane = (await $.ui.mount(PANE)) as unknown as M
  let text = shown(await pane.drawn())
  for (const s of ['Files', '3 files', 'README.md', 'data/', 'events.jsonl', 'records', '52.0 MB']) expect(text).toContain(s)
  await pane.press({ key: 'file-open-1' })
  await w.clock.settle()
  await pane.redraw()
  text = shown(await pane.drawn())
  for (const s of ['README.md', 'markdown · 20 lines · lines 1-3', 'Collusion wiki', 'An export of 4,579']) expect(text).toContain(s)
  expect(w.calls.some(c => c[2] === 'files' && c[5] === 'README.md')).toBe(true)
  await pane.unmount()
  // an agent at work, from the row above the prompt
  const above = (await $.ui.mount(ABOVE)) as unknown as M
  await above.press({ key: 'above-agent-open-0' })
  await above.unmount()
  await w.clock.settle()
  const agent = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await agent.drawn())).toContain('orientation: the whole corpus')
  await agent.unmount()
  expect(w.calls.some(c => c[2] === 'thread' && c[5] === 'o1')).toBe(true)
})

test("a label's panel: its definition, its counts and its records with agree and disagree", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Labelled.']], { tool: 'mcp__plugin_thimble_thimble__apply_label', text: "The label's card is [[card:l0label0]]." })
  const ui = (await $.ui.mount(MESSAGE('r1', 'Labelled.'))) as unknown as M
  await ui.post({ type: 'label-open', slug: 'd9b51617', origin: 'y', gestures: [] }, { in: 'card-t0-l0label0' })
  await ui.unmount()
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const text = shown(await pane.drawn())
  for (const s of ['links through a fetch proxy', 'regex · revisions.jsonl', 'A revision whose text links']) expect(text).toContain(s)
  const card = shown(await pane.drawn({ in: 'label-d9b51617' }))
  expect(card).toContain('proxy-link')
  expect(card).toContain('disagree')
  await pane.unmount()
})
