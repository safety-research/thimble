// thimble-term in a session, against the fixture states (tests/fixtures.ts): its scope, a turn's cards drawn once under
// the turn's last reply, citations as links (red when they do not hold), main's end token hidden, the rows above the
// prompt, /thimble, the panel's views, a label verdict, a side thread asked and answered.
// `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { HOME_LINE } from '../hooks/register'
import { CLI, CWD, LABEL, SLIDES, WS, shown, world } from './fixtures'
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

test("a turn's card is drawn once, under the turn's last reply, in its border with its takeaway, as wide as the prose; no hex id; a wrong value is red", async ($, on) => {
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
  // the card in a full round border as wide as the reply's prose (the terminal's 140 columns less 2 and the margin of
  // 4), its takeaway inside it; no blank row between the reply and the card's border
  const json = JSON.stringify(await ui.drawn())
  expect(json).toContain('"width":134,"borderStyle":"round","borderColor":"subtle","paddingX":1')
  expect(json).toMatch(/"width":134,"flexShrink":1\}/)
  expect(json).toContain('{"type":"Box","props":{"key":"turn-card-0","flexDirection":"row"}')
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

test("a card tool's result row names the card by its question, never its id", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Here.']])
  const row = await $.ui.mount({ plugin: 'thimble-term', component: 'ToolResult', requestId: 'u1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { tool_use_id: 'u1', tool: 'mcp__plugin_thimble_thimble__add_card', output: [{ type: 'text', text: 'card:ff73e071\n[out0: table]' }], isErrored: false } } as never)
  const text = shown(await row.drawn())
  expect(text).toBe('  ⎿  card "What does the export hold per wiki?"')
  await row.unmount()
  // another tool's row is Claude Code's own
  const other = await $.ui.mount({ plugin: 'thimble-term', component: 'ToolResult', requestId: 'u2', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { tool_use_id: 'u2', tool: 'mcp__plugin_thimble_thimble__read_ref', output: 'card:ff73e071', isErrored: false } } as never)
  expect(shown(await other.drawn())).toBe('(the engine row)')
  await other.unmount()
  void w
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

test("a card made by add_card waits for its run, then shows what `thimble-run` wrote, though its stamp did not move", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Running it.']], { tool: 'mcp__plugin_thimble_thimble__add_card', text: 'card:w0wait00\nRun this command with Bash to run the card: thimble-run card w0wait00' })
  const ui = (await $.ui.mount(MESSAGE('r1', 'Running it.'))) as unknown as M
  expect(shown(await ui.drawn({ in: 'card-t0-w0wait00' }))).toContain('waiting for its run')
  // thimble-run writes the cell's outputs; the cell keeps its stamp
  Object.assign(w.cells.w0wait00!, { run: { state: 'done', by: 'bash' }, status: 'ok', outputs: (w.cells.a0frame0 as { outputs: unknown }).outputs })
  w.stamps.set(`${WS}/notebooks`, 3)
  await w.clock.advance(1100)
  await ui.redraw()
  const text = shown(await ui.drawn({ in: 'card-t0-w0wait00' }))
  expect(text).not.toContain('waiting for its run')
  expect(text).toContain('events.jsonl')
  await ui.unmount()
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

test("a reply's citation is a link, blue and underlined; a click opens the citation panel on its place with the value marked", async ($, on) => {
  const w = world(on)
  await start($, w)
  const ui = (await $.ui.mount(MESSAGE('m4', 'The README says [4,579](README.md#L3) pages.'))) as unknown as M
  await w.clock.advance(300)
  await ui.redraw()
  const para = await ui.drawn({ in: 'para-1' })
  expect(shown(para)).toContain('4,579')
  expect(JSON.stringify(para)).toMatch(/"color":"remember"[^}]*"underline":true[^}]*\},"children":\["4,579"\]/)
  // the citation sits after "The README says " on the paragraph's first row
  await ui.pointer({ type: 'down', x: 18, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.pointer({ type: 'up', x: 18, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.unmount()
  expect(w.opened).toContain('thimble-term')
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const text = shown(await pane.drawn())
  // the title is the value as a link to its place; its status in plain words under it; then where it is from and its lines
  expect(shown(await pane.drawn({ in: 'cite-title' }))).toBe('4,579')
  expect(text).toContain('found in README.md line 3')
  expect(text).toContain('from')
  expect(text).toContain('An export of 4,579 wiki pages')
  expect(text).toContain('ask about it')
  // the sentence it stands in, its value a link; no way back from main, so no `b`; no `in files` (the title opens it)
  expect(text).toContain('source')
  expect(text).toContain('"The README says 4,579 pages."')
  expect(text).toContain('a to ask · f for its file · x to close')
  expect(text).not.toContain('in files')
  // the cited value on the selection background; no right-click menu anywhere
  expect(JSON.stringify(await pane.drawn())).toContain('{"type":"Text","props":{"backgroundColor":"selectionBg"},"children":["4,579"]}')
  expect(text).not.toContain('open its lines')
  await pane.unmount()
})

test('a click or a right-click on plain words opens nothing; the "?" beside a passage asks a side thread about its words', async ($, on) => {
  const w = world(on)
  await start($, w)
  const ui = (await $.ui.mount(MESSAGE('m5', 'Most saves came in June. The README says [4,579](README.md#L3) pages.'))) as unknown as M
  for (const button of ['left', 'right'] as const) {
    await ui.pointer({ type: 'down', x: 2, y: 0, button, in: 'para-1' } as never)
    await ui.pointer({ type: 'up', x: 2, y: 0, button, in: 'para-1' } as never)
  }
  expect(w.opened).toEqual([])
  await ui.press({ key: 'ask-1' })
  await ui.unmount()
  expect(w.opened).toEqual(['thimble-term'])
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const text = shown(await pane.drawn())
  expect(text).toContain('New thread')
  expect(text).toContain('Most saves came in June.')
  await pane.input({ key: 'ask-new', text: 'Which day?' })
  await w.clock.settle()
  expect(w.acts.find(a => a.kind === 'thread')?.payload).toMatchObject({ anchor: null, message: 'Which day?' })
  await pane.unmount()
})

test('the one row above the prompt is a toast: what is new since home was opened, `new` in green, gone once home opens; no row of threads or agents', async ($, on) => {
  const w = world(on)
  await start($, w)
  let above = (await $.ui.mount(ABOVE)) as unknown as M
  // what the workspace held when the session started is not new; threads have their `↳` rows, agents Claude Code's tray
  expect(shown(await above.drawn())).toBe('(the engine row)')
  await above.unmount()
  // two cards arrive: the row says so, and open › opens home
  w.states.home = { ...w.states.home, cards: 14 }
  w.stamps.set(`${WS}/notebooks`, 2)
  await w.clock.advance(1100)
  above = (await $.ui.mount(ABOVE)) as unknown as M
  const drawn = await above.drawn()
  const text = shown(drawn)
  expect(text).toContain('2 new cards')
  expect(text).toContain('open ›')
  expect(JSON.stringify(drawn)).toContain('{"type":"Text","props":{"color":"success"},"children":["new"]}')
  await above.press({ key: 'above-home-open' })
  expect(w.opened).toContain('thimble-term')
  await above.unmount()
  await w.clock.settle()
  // once home is open, the row is gone until something new arrives
  above = (await $.ui.mount(ABOVE)) as unknown as M
  expect(shown(await above.drawn())).not.toContain('new card')
  await above.unmount()
})

test('no agent is listed above the prompt, whatever its state', async ($, on) => {
  const w = world(on)
  w.states.agents = { ...w.states.agents, rows: [{ ...w.states.agents.rows[0]!, state: 'working' }, { name: 'thimble:writer', label: 'writer: report', state: 'waiting for a permission', kind: 'subagent', chat: 'w1', role: 'writer' }] }
  await start($, w)
  const above = (await $.ui.mount(ABOVE)) as unknown as M
  const text = shown(await above.drawn())
  expect(text).not.toContain('orientation: the whole corpus')
  expect(text).not.toContain('writer: report')
  await above.unmount()
})

test('/thimble opens the home panel with no model turn: one column, the title Home, each section bold with its count', async ($, on) => {
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
  const drawn = await pane.drawn({ in: 'm:home' })
  const home = shown(drawn)
  for (const s of ['Home', 'Documents', ' (1)', 'Agents used the dse wiki as a relay', 'Threads', '"why is events.jsonl bigger?"', 'Cards', '▾ ', 'Your work', 'Labels', 'links through a fetch proxy', 'Files', 'revisions.jsonl', '↑↓ to choose · Enter to open · Space to fold · x to close']) expect(home).toContain(s)
  // the title in the accent and bold, the headings bold, `new` in green after an unread thread
  const json = JSON.stringify(drawn)
  expect(json).toMatch(/"color":"suggestion","bold":true\},"children":\["Home"\]/)
  expect(json).toMatch(/"bold":true\},"children":\["Threads"\]/)
  expect(json).toContain('"color":"success"},"children":["new"]')
  // the path row: home, and `show all threads` with its news at the right
  const text = shown(await pane.drawn())
  expect(text).toContain('show all threads')
  expect(text).toContain('1 new')
  await pane.unmount()
})

test("a right-click on a card's cell does what a click does: a side thread about the cell, named by it; no menu", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Here.']])
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  const key = 'card-t0-ff73e071'
  await ui.resize({ columns: 100, rows: 16, in: key })
  // the card's insides (its border is the drawing's): the row of dse's cells
  const lines = ((await ui.drawn({ in: key })) as { children?: unknown[] }).children ?? []
  const y = lines.findIndex(l => /^dse/.test(shown(l)))
  expect(y).toBeGreaterThan(0)
  // on dse's pages
  await ui.pointer({ type: 'down', x: 12, y, button: 'right', in: key } as never)
  await ui.pointer({ type: 'up', x: 12, y, button: 'right', in: key } as never)
  await ui.unmount()
  expect(w.opened).toEqual(['thimble-term'])
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const text = shown(await pane.drawn())
  expect(text).toContain('New thread')
  expect(text).toContain('dse')
  expect(await pane.find({ key: 'menu-open' })).toBeUndefined()
  await pane.input({ key: 'ask-new', text: 'Why so many?' })
  await w.clock.settle()
  expect(w.acts.find(a => a.kind === 'thread')?.payload).toMatchObject({ anchor: 'card:ff73e071', message: 'Why so many?' })
  expect(String(w.acts.find(a => a.kind === 'thread')?.payload.anchor_text)).toContain('dse')
  await pane.unmount()
})

test("a label card is a bar card of its counts with the label's row; a press on the label's name opens the label panel", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Labelled.']], { tool: 'mcp__plugin_thimble_thimble__apply_label', text: "applied label links [[concept:d9b51617]] over 14591 record(s): proxy-link 5191, none 9400. The label's card is [[card:l0label0]]." })
  const ui = (await $.ui.mount(MESSAGE('r1', 'Labelled.'))) as unknown as M
  const key = 'card-t0-l0label0'
  await ui.resize({ columns: 100, rows: 14, in: key })
  const card = shown(await ui.drawn({ in: key }))
  expect(card).toContain('proxy-link')
  expect(card).toContain('links through a fetch proxy')
  expect(card).not.toContain('agree')
  // the title in bold, a blank row, the bars, then below them the readout row and the label row: its name after "label  "
  const lines = ((await ui.drawn({ in: key })) as { children?: unknown[] }).children ?? []
  expect(shown(lines[0])).toBe("links through a fetch proxy")
  expect(JSON.stringify(lines[0])).toContain('"bold":true')
  expect(shown(lines[2])).toMatch(/^proxy-link/)
  const y = lines.findIndex(l => /^label {2}links through a fetch proxy/.test(shown(l)))
  expect(y).toBeGreaterThan(2)
  await ui.pointer({ type: 'down', x: 7 + 3, y, button: 'left', in: key } as never)
  await ui.pointer({ type: 'up', x: 7 + 3, y, button: 'left', in: key } as never)
  await ui.unmount()
  await w.clock.settle()
  expect(w.opened).toEqual(['thimble-term'])
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('labels › links through a fetch proxy')
  await pane.unmount()
})

test("a side thread asked about a card: the ask field posts the thread, and the threads panel shows it selected under the tree", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Here.']], { tool: 'mcp__plugin_thimble_thimble__add_card', text: 'card:a0frame0\n[out0: table]' })
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  await ui.press({ key: 'ask-card-0' })
  await ui.unmount()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('New thread')
  await pane.input({ key: 'ask-new', text: 'Why is dse so big?' })
  await w.clock.settle()
  // the thread is told the card by its question, never its id
  expect(w.acts).toContainEqual({ kind: 'thread', payload: { anchor: 'card:a0frame0', anchor_text: 'card "How many records does each file hold?"', message: 'Why is dse so big?' } })
  await pane.redraw()
  const text = shown(await pane.drawn())
  expect(text).toContain('Threads')
  expect(text).toContain('"a question"')
  expect(shown(await pane.drawn({ in: 'm:threads-tree' }))).toContain('main')
  expect((await pane.findAll({ type: 'Input' })).length).toBe(1)
  await pane.unmount()
})

test("an answer that comes in while the panel shows something else: a `↳ thread` row under main's latest row, `new` in green", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Asked.']])
  const t2 = w.states.threads.find(t => t.id === 't2')! as Record<string, unknown>
  Object.assign(t2, { running: false, answers: 1, seen: 0 })
  w.chats.t2 = { meta: { ...t2 }, events: [{ type: 'user', text: 'which pages were deleted?' }, { type: 'text', delta: 'Forty.' }, { type: 'done', result: 'Forty.' }] }
  w.stamps.set(`${WS}/chats`, 5)
  await w.clock.advance(1100)
  const ui = (await $.ui.mount(MESSAGE('r1', 'Asked.'))) as unknown as M
  const text = shown(await ui.drawn())
  expect(text).toContain('↳ thread · "which pages were deleted?" · answered · new')
  expect(JSON.stringify(await ui.drawn())).toContain('{"type":"Text","props":{"color":"success"},"children":[" · new"]}')
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

test('from home, a document opens drawn as a reply: its title, its contents, each section bold, its figures as cards in their borders', async ($, on) => {
  const w = world(on)
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const y = await rowOf(pane, 'm:home', 'Agents used the dse wiki as a relay')
  expect(y).toBeGreaterThan(0)
  await pane.pointer({ type: 'down', x: 4, y, button: 'left', in: 'm:home' } as never)
  await w.clock.settle()
  await pane.redraw()
  const text = shown(await pane.drawn())
  for (const s of ['home', 'documents', 'Agents used the dse wiki as a relay', '## The data', '## The main claim', 'The export per wiki.', 'all documents ›', 'as slides', 'as a story']) expect(text).toContain(s)
  // two sections: no contents (it shows from three headings)
  expect(text).not.toContain('Contents')
  const cards = (await pane.findAll({ type: 'Client' })).filter(c => String((c as { key?: string }).key).includes('ff73e071'))
  expect(cards.length).toBe(1)
  expect(shown(await pane.drawn({ in: 'para-d0-2' }))).toContain('4579')
  // back leads home again
  await pane.press({ key: 'nav-back' })
  await w.clock.settle()
  await pane.redraw()
  expect(await pane.find({ type: 'Client', key: 'm:home' })).toBeDefined()
  await pane.unmount()
})

test("a tool's layout record opens the file browser: folders that fold, a file chosen shows its first lines, Enter opens it", async ($, on) => {
  const w = world(on)
  await start($, w)
  // set_layout(files) in a tool call of main's: a record in ui.jsonl, which the renderer follows
  w.states.ui = [{ n: 1, kind: 'layout', args: { layout: 'one', surfaces: ['files'] } }]
  w.stamps.set(`${WS}/ui.jsonl`, 7)
  await w.clock.advance(1100)
  expect(w.opened).toEqual(['thimble-term'])
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const tree = shown(await pane.drawn({ in: 'm:files-tree' }))
  for (const s of ['▾ wiki/', 'README.md', '▸ data/', 'markdown', '52.0 MB']) expect(tree).toContain(s)
  expect(shown(await pane.drawn())).toContain('3 files')
  // a click on a file chooses it: its first lines under the second rule
  const y = await rowOf(pane, 'm:files-tree', 'README.md')
  await pane.pointer({ type: 'down', x: 6, y, button: 'left', in: 'm:files-tree' } as never)
  await w.clock.settle()
  await pane.redraw()
  expect(shown(await pane.drawn())).toContain('Collusion wiki')
  // a second click opens it on its lines
  await pane.pointer({ type: 'down', x: 6, y, button: 'left', in: 'm:files-tree' } as never)
  await w.clock.settle()
  await pane.redraw()
  const text = shown(await pane.drawn())
  for (const s of ['files › README.md', 'markdown · 20 lines · lines 1-3', 'Collusion wiki', 'An export of 4,579']) expect(text).toContain(s)
  expect(w.calls.some(c => c[2] === 'files' && c[5] === 'README.md')).toBe(true)
  await pane.unmount()
})

test("a label's panel: its name, type and scope, a rule, its pattern to edit; run on a sample or on all; counts, examples and cards folded", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Labelled.']], { tool: 'mcp__plugin_thimble_thimble__apply_label', text: "The label's card is [[card:l0label0]]." })
  const ui = (await $.ui.mount(MESSAGE('r1', 'Labelled.'))) as unknown as M
  await ui.post({ type: 'label-open', slug: 'd9b51617', origin: 'y', gestures: [] }, { in: 'card-t0-l0label0' })
  await ui.unmount()
  await w.clock.settle()
  let pane = (await $.ui.mount(PANE)) as unknown as M
  let drawn = await pane.drawn()
  let text = shown(drawn)
  // the header block: the name in the accent and bold after a ● in its colour, the type in use on the selection
  // background, the scope (its files, a field, and how many records); then the rule and the pattern, a field
  for (const s of ['name', 'links through a fetch proxy', 'type', 'prompt', 'regex', 'code', 'scope', '· 14,591 records', '──', 'pattern', 'run on a sample', 'run on all 14,591', '▸ counts', '▸ examples', '▸ cards']) expect(text).toContain(s)
  const json = JSON.stringify(drawn)
  expect(json).toMatch(/"color":"suggestion","bold":true\},"children":\["links through a fetch proxy"\]/)
  expect(json).toContain('{"type":"Text","props":{"backgroundColor":"selectionBg"},"children":["regex"]}')
  // the pattern whole in its field (field.tsx), in a border
  const field = (await pane.find({ type: 'Client', key: `lb-def-${LABEL.id}-regex` })) as unknown as { props: { module: string; props: { name: string; text: string } } }
  expect(field.props.module).toMatch(/field\.tsx$/)
  expect(field.props.props).toMatchObject({ name: 'label-body:d9b51617', text: 'r\\.jina\\.ai|proxy\\.' })
  expect((await pane.find({ type: 'Input', key: `lb-glob-${LABEL.id}` }))?.props).toMatchObject({ value: 'revisions.jsonl' })
  // nothing else until it is opened: no counts' bars, no records, no cards
  for (const s of ['SEC download', 'agree', 'r.jina.ai link', 'links through a fetch proxy ›', '9,400']) expect(text).not.toContain(s)
  // the examples open: each record under its value, its place a link, agree or another value, its words, why
  await pane.press({ key: 'lb-open-examples' })
  await pane.press({ key: 'lb-open-counts' })
  await pane.press({ key: 'lb-open-cards' })
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  text = shown(await pane.drawn())
  for (const s of ['▾ examples', 'SEC download', 'agree', 'it is', '✓ agreed', 'why  r.jina.ai link', '▾ counts', '9,400', '5,191', '▾ cards', 'links through a fetch proxy ›']) expect(text).toContain(s)
  await pane.press({ key: 'lb-agree-revisions.jsonl#L10566' })
  await w.clock.settle()
  expect(w.acts).toContainEqual({ kind: 'verdict', payload: { label: 'd9b51617', ref: 'revisions.jsonl#L10566', value: 'proxy-link' } })
  // an edit of the pattern: Enter in the field saves it through `thimble act label`
  await pane.post({ type: 'field', name: 'label-body:d9b51617', text: 'jina', save: true, origin: 'f1', gestures: [] }, { in: `lb-def-${LABEL.id}-regex` })
  await w.clock.settle()
  expect(w.acts).toContainEqual({ kind: 'label', payload: { label: 'd9b51617', body: 'jina' } })
  // another type picked, then a run: the kind and the words typed are saved first, then the label runs on a sample
  await pane.press({ key: 'lk-prompt' })
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(JSON.stringify(await pane.drawn())).toContain('{"type":"Text","props":{"backgroundColor":"selectionBg"},"children":["prompt"]}')
  expect(shown(await pane.drawn())).toContain('prompt')
  await pane.post({ type: 'field', name: 'label-body:d9b51617', text: 'Does the text link through a proxy?', save: false, origin: 'f2', gestures: [] }, { in: `lb-def-${LABEL.id}-prompt` })
  await pane.press({ key: 'lb-sample' })
  await w.clock.settle()
  const runs = w.acts.filter(a => a.kind === 'label-run')
  expect(runs.at(-1)).toEqual({ kind: 'label-run', payload: { label: 'd9b51617', limit: 30 } })
  expect(w.acts.filter(a => a.kind === 'label').at(-1)!.payload).toEqual({ label: 'd9b51617', kind: 'prompt', body: 'Does the text link through a proxy?' })
  await pane.redraw()
  expect(shown(await pane.drawn())).toContain('ran on a sample of 30: proxy-link 12 · none 18')
  // run on all: no limit
  await pane.press({ key: 'lb-all' })
  await w.clock.settle()
  expect(w.acts.filter(a => a.kind === 'label-run').at(-1)).toEqual({ kind: 'label-run', payload: { label: 'd9b51617' } })
  await pane.unmount()
})

test('a deck opens with its slides: each heading, its sentences as a list, its figure as a card', async ($, on) => {
  const w = world(on)
  w.states.home = { ...w.states.home, docs: { ...w.states.home.docs, slides: { exists: true, title: SLIDES.title } } as typeof w.states.home.docs }
  w.states.docs = { ...w.states.docs, slides: { exists: true, title: SLIDES.title, renderer: 'slides', name: 'Slides' } as typeof w.states.docs.slides }
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const y = await rowOf(pane, 'm:home', SLIDES.title)
  expect(y).toBeGreaterThan(0)
  await pane.pointer({ type: 'down', x: 4, y, button: 'left', in: 'm:home' } as never)
  await w.clock.settle()
  await pane.redraw()
  // one slide at a time: the first, its sentences as a list, its figure; the page row says where it is
  let text = shown(await pane.drawn())
  for (const s of [SLIDES.title, 'The export is large', 'Most are agents', 'The export per wiki.', 'next', 'notes', 'p n to step · o for notes · y to retell · l for all documents · b to go back · x to close']) expect(text).toContain(s)
  expect(shown(await pane.drawn({ in: 'doc-page' }))).toBe('‹  1 of 2  ›')
  expect(text).not.toContain('- - ')
  expect(text).not.toContain('What it leaves open')
  await w.clock.settle()  // the figures' cards are read, then drawn
  await pane.redraw()
  expect((await pane.findAll({ type: 'Client' })).map(c => String((c as { key?: string }).key)).some(k => k.includes('ff73e071'))).toBe(true)
  // its notes, then the next slide
  await pane.press({ key: 'hk-notes' })
  await w.clock.settle()
  await pane.redraw()
  expect(shown(await pane.drawn())).toContain('speaker notes')
  await pane.press({ key: 'hk-next' })
  await w.clock.settle()
  await pane.redraw()
  text = shown(await pane.drawn())
  for (const s of ['What it leaves open', 'One week only.', 'Who acted on what.', 'previous']) expect(text).toContain(s)
  expect(shown(await pane.drawn({ in: 'doc-page' }))).toBe('‹  2 of 2  ›')
  await w.clock.settle()
  await pane.redraw()
  expect((await pane.findAll({ type: 'Client' })).map(c => String((c as { key?: string }).key)).some(k => k.includes('d0diag00'))).toBe(true)
})
