// The terminal UI in a session, against the fixture states (tests/fixtures.ts): nothing before activation and /thimble
// turning it on; a turn's card drawn once under the turn's last reply, its wrong value red; a card waiting for its run;
// main's end token hidden; a citation as a purple link that opens its place; the "?" asking a side thread; a layout
// record for Files opening Coverage. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CLI, CWD, WS, citedText, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const MESSAGE = (requestId: string, text: string, first = true) =>
  ({ plugin: 'thimble', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: first } }) as never
// a pane tall enough for home whole
const PANE = { plugin: 'thimble', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 120, rows: 124 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 120 }, view: {} } } as never
const ABOVE = { plugin: 'thimble', component: 'AbovePrompt', requestId: 'above', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 130, scroll: { bodyRows: 10 }, view: {} } } as never

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

// 0.9.0: thimble is on from the start of every session with a person at the terminal (a regular plugin). Where it is
// off (here a session with no person at the terminal) it draws nothing and runs nothing; /thimble turns it on
test('where thimble is off it draws nothing and runs nothing; /thimble turns it on', { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on, { active: false })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: false } as never)
  await w.clock.settle()
  const ui = await $.ui.mount(MESSAGE('m1', 'The export holds [4579](card:ff73e071#pages/TOTAL) pages. (shown in the dashboard)'))
  expect(shown(await ui.drawn())).toBe('(the engine row)')
  await ui.unmount()
  const above = await $.ui.mount(ABOVE)
  expect(shown(await above.drawn())).toBe('(the engine row)')
  await above.unmount()
  expect(w.calls).toEqual([])
  const r = await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  expect(JSON.stringify(r)).not.toContain('terminal mode')
  expect(w.activations.length).toBe(1)
  await w.clock.advance(1000)
})

test("a turn's card is drawn once, under the turn's last reply, in its border with its takeaway, as wide as the prose; no hex id; a wrong value is red", { timeoutMs: 30_000 }, async ($, on) => {
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
  // 2, Claude Code's own), its takeaway inside it; no blank row between the reply and the card's border
  const json = JSON.stringify(await ui.drawn())
  expect(json).toContain('"width":136,"borderStyle":"round","borderColor":"subtle","paddingX":1')
  expect(json).toMatch(/"width":136,"flexShrink":1\}/)
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

test("a card made before a subagent's turn started is drawn under the answer too: only main's own turn starts it over", { timeoutMs: 30_000 }, async ($, on) => {
  // README capture 10-17: four checks started while main made its second card, and only that card was drawn
  const w = world(on)
  await start($, w)
  const reply = (uuid: string, text: string) => $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] } } as never).catch(() => undefined)
  await $.turn.start({ text: 'How many pages?', turnId: 't1' } as never)
  w.toolText = 'card:ff73e071\n[out0: table]'
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u1', question: 'q', code: 'df' } as never)
  await $.turn.start({ text: 'Check the passages.', turnId: 't2', agentId: 'a1' } as never)
  await reply('r0', 'One card is done.')
  w.toolText = 'card:b0bar000\n[out0: chart]'
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u2', question: 'q', code: 'df' } as never)
  await reply('r1', 'Both cards.')
  await $.turn.complete({ turnId: 't1', answer: 'Both cards.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
  const ui = (await $.ui.mount(MESSAGE('r1', 'Both cards.', false))) as unknown as M
  expect(await ui.find({ type: 'Client', key: 'card-t0-ff73e071' })).toBeDefined()
  expect(await ui.find({ type: 'Client', key: 'card-t1-b0bar000' })).toBeDefined()
  await ui.unmount()
})

test("a list item has no dot of its own in the margin, as Claude Code draws a list; a paragraph keeps its dot", { timeoutMs: 30_000 }, async ($, on) => {
  // README capture 10-17: `· - dse: 13,403`, a dot beside the item's `-`
  const w = world(on)
  await start($, w)
  const text = 'The export holds two wikis.\n\nPer wiki [[card:ff73e071]]:\n- **dse:** [[4579|card:ff73e071#pages/TOTAL]]\n- **probier:** [[14592|card:ff73e071#revisions/TOTAL]]'
  await turn($, w, [['r1', text]])
  const ui = (await $.ui.mount(MESSAGE('r1', text))) as unknown as M
  // a row's first cell is its margin's glyph
  const margin = async (key: string) => shown(await ui.find({ key }))[0]
  expect(await margin('row-2')).toBe('·')
  expect(await margin('row-3')).toBe(' ')
  expect(await margin('row-4')).toBe(' ')
  await ui.unmount()
})

test("in fullscreen a card's ↗ lies on its border row in the flow, so it scrolls with the card, never laid out of it", { timeoutMs: 30_000 }, async ($, on) => {
  // README capture 10-17: an absolute ↗ drew on the screen's top row once its card scrolled partway off it
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Here is the count.']])
  const full = { plugin: 'thimble', component: 'AssistantMessage', requestId: 'r1', surface: 'terminal', viewport: { columns: 140, rows: 40, isFullscreen: true }, props: { text: 'Here is the count.', isFirstOfReply: true } } as never
  const ui = (await $.ui.mount(full)) as unknown as M
  const json = JSON.stringify(await ui.drawn())
  expect(json).toMatch(/"key":"arrow-t0-ff73e071","flexDirection":"row","marginBottom":-1/)
  expect(json).not.toContain('"position":"absolute","top":0,"left":130')
  expect(await ui.find({ key: 'open-t0-ff73e071' })).toBeDefined()
  await ui.unmount()
})

test("a card made by add_card waits for its run, then shows what `thimble-run` wrote, though its stamp did not move", { timeoutMs: 30_000 }, async ($, on) => {
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

test("main's end token is hidden; a reply that is only the token draws nothing", { timeoutMs: 30_000 }, async ($, on) => {
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

test("a reply's citation is a link, purple and underlined; a click opens the citation panel on its place with the value marked", { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  await start($, w)
  const ui = (await $.ui.mount(MESSAGE('m4', 'The README says [4,579](README.md#L3) pages.'))) as unknown as M
  await w.clock.advance(300)
  await ui.redraw()
  const para = await ui.drawn({ in: 'para-1' })
  expect(shown(para)).toContain('4,579')
  expect(JSON.stringify(para)).toMatch(/"color":"merged"[^}]*"underline":true[^}]*\},"children":\["4,579"\]/)
  // the citation sits after "The README says " on the paragraph's first row
  await ui.pointer({ type: 'down', x: 18, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.pointer({ type: 'up', x: 18, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.unmount()
  expect(w.opened).toContain('thimble')
  await w.clock.settle()
  let pane = (await $.ui.mount(PANE)) as unknown as M
  const text = shown(await pane.drawn())
  // the title is the value as a link to its place; then the sentence it stands in, its place as a link and its lines;
  // its state in the bar above the entry box (MATT-NOTES "Mockup feedback", panel C)
  expect(shown(await pane.drawn({ in: 'cite-title' }))).toBe('4,579')
  expect(shown(await pane.drawn({ in: 'cite-place' }))).toBe('↗ README.md line 3')
  expect(shown(await pane.find({ key: 'cite-bar' }))).toBe('checked ›history 0')
  // the cited lines: a window over the file (panel.tsx citeWindow), drawn by its Client
  const lines = await pane.drawn({ in: 'm:cite-lines' })
  expect(shown(lines)).toContain('An export of 4,579 wiki pages')
  // no `ask about it`: the entry box, its placeholder saying what it takes
  expect(text).not.toContain('ask about it')
  expect(((await pane.findAll({ type: 'Input' })) as { key?: string; props?: { placeholder?: string } }[]).find(i => String(i.key).startsWith('ask-cite-'))?.props?.placeholder).toBe('Ask about this citation')
  // the sentence it stands in, its value a link; no way back from main, so no `b`; no `in files` (the title opens it)
  expect(text).toContain('source')
  expect(text).toContain('"The README says 4,579 pages."')
  // how it was verified, and the way to ask for a script where no code verified it, once `checked` is pressed
  expect(text).toContain('a to ask · f for its file · v for how it was verified · s for a script · x to close')
  expect(text).not.toContain('in files')
  // the cited value on the citation's purple; no right-click menu anywhere
  expect(JSON.stringify(lines)).toMatch(citedText('4,579'))
  expect(text).not.toContain('open its lines')
  await pane.press({ key: 'cite-state' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.find({ key: 'cite-how' }))).toBe('thimble read the cited line and found the value there; no script recomputed itask for a script')
  await pane.unmount()
})

test('a click or a right-click on plain words opens nothing; the "?" beside a passage asks a side thread about its words', { timeoutMs: 30_000 }, async ($, on) => {
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
  expect(w.opened).toEqual(['thimble'])
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const text = shown(await pane.drawn())
  expect(text).toContain('New thread')
  expect(text).toContain('Most saves came in June.')
  await pane.input({ key: 'ask-new', text: 'Which day?' })
  await w.clock.settle()
  expect(w.acts.find(a => a.kind === 'thread')?.payload).toMatchObject({ anchor: null, message: 'Which day?' })
  await pane.unmount()
})

test("a tool's layout record for Files opens Coverage: the terminal has no file browser", async ($, on) => {
  const w = world(on)
  await start($, w)
  // set_layout(files) in a tool call of main's: a record in ui.jsonl, which the renderer follows
  w.states.ui = [{ n: 1, kind: 'layout', args: { layout: 'one', surfaces: ['files'] } }]
  w.stamps.set(`${WS}/ui.jsonl`, 7)
  await w.clock.advance(1100)
  expect(w.opened).toEqual(['thimble'])
  expect(w.panes.at(-1)!.title).toBe('Coverage')
})

test("bug hunt C16: a card made and deleted in the same turn is neither drawn (no `× card 1 cannot be drawn`) nor counted in the footer", { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  await start($, w)
  await $.turn.start({ text: 'Try a sample, then run it on all.', turnId: 't1' } as never)
  w.toolText = 'card:ff73e071\n[out0: table]'
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u1', question: 'q', code: 'df' } as never)
  // main deletes it: the card is gone from the workspace
  w.toolText = 'Deleted card:ff73e071, the card that asked: q'
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__delete_card', tool_use_id: 'u2', card: 'card:ff73e071' } as never)
  delete w.cells.ff73e071
  w.toolText = 'card:d0diag00\n[out0: diagram]'
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u3', question: 'q2', code: 'df' } as never)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'r1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'The label ran on every record.' }] } } as never).catch(() => undefined)
  await $.turn.complete({ turnId: 't1', answer: 'The label ran on every record.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
  const ui = (await $.ui.mount(MESSAGE('r1', 'The label ran on every record.'))) as unknown as M
  const json = JSON.stringify(await ui.drawn())
  expect(json).not.toContain('cannot be drawn')
  expect(json).not.toContain('ff73e071')
  expect(json).toContain('d0diag00')
  const footer = shown(await ui.find({ key: 'footer-r1' }))
  expect(footer).toContain('1 card')
  expect(footer).not.toContain('2 cards')
  await ui.unmount()
})
