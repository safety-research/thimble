// Main's chat as thimble-term draws it: a citation purple and underlined, a purple ◌ a space after it while checked,
// checked as soon as it streams, no mark once found, red with × once it failed, bold under the pointer with nothing
// beside it; a time's tip; a value the check
// corrected; the footer's `◌ checking N` and `N failed`; a reply as it streams handed to Claude Code as links, stored as
// written; a card's value checked again when the card changes; the writer's finished line linking the document out;
// with "Citation marks" off a plain link and no check. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { chipLook, paraLayout } from '../cite'
import { COLORS } from '../paint'
import { CWD, WS, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine
type ChipProps = { props: { props: { chips: { label: string; state: string; mark: string; spin: boolean; tip: string }[] } } }

const MESSAGE = (requestId: string, text: string, surface = 'terminal') =>
  ({ plugin: 'thimble', component: 'AssistantMessage', requestId, surface, viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
const PANE = { plugin: 'thimble', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 36 }, view: {} } } as never

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

const append = ($: E, uuid: string, content: unknown[]) =>
  $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid, message: { type: 'assistant', role: 'assistant', content } } as never).catch(() => undefined)

/** A turn of main's: its prompt, a call, its reply rows (by uuid), its end. */
async function turn($: E, w: World, rows: [string, string][], call = { tool: 'mcp__plugin_thimble_thimble__add_card', text: 'card:ff73e071\n[out0: table]', input: {} as Record<string, unknown> }, prompt = 'How many pages?'): Promise<void> {
  w.toolText = call.text
  await $.turn.start({ text: prompt, turnId: 't1' } as never)
  await append($, rows[0]![0], [{ type: 'text', text: rows[0]![1] }])
  await $.tool.call({ tool: call.tool, tool_use_id: 'u1', ...call.input } as never)
  for (const [uuid, text] of rows.slice(1)) await append($, uuid, [{ type: 'text', text }])
  await $.turn.complete({ turnId: 't1', answer: rows.at(-1)![1], durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
}

async function chipsOf(m: M, key: string) {
  return ((await m.find({ type: 'Client', key })) as unknown as ChipProps).props.props.chips
}

test("a takeaway's citations take thimble's links check: no mark once it found the value (never ✓), a red × with what the place shows, ◌ while it runs", { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  Object.assign(w.cells.ff73e071!, {
    verification: { status: 'ok', links: { status: 'partial', checked: true, resolved: [{ value: '4579', ref: 'card:ff73e071#pages/TOTAL' }], broken: [{ value: '14592', ref: 'card:ff73e071#revisions/TOTAL', why: 'the place shows 14591', source: '14591' }] } },
  })
  await start($, w)
  await turn($, w, [['r1', 'Here.']])
  let ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  let chips = await chipsOf(ui, 'para-tk-t0-1')
  expect(chips[0]).toMatchObject({ label: '4579', state: 'link', mark: '', spin: false })
  expect(chips[0]!.tip).toBe('found on the card, and a script got the same number')
  expect(chips[1]).toMatchObject({ label: '14592', state: 'failed', mark: '×' })
  expect(chips[1]!.tip).toBe('not found on the card, but a script got 14591 · the place shows 14591')
  await ui.unmount()
  // the check runs again: ◌ after each
  Object.assign(w.cells.ff73e071!, { verification: { status: 'checking', links: { status: 'pending', checked: false, resolved: [], broken: [] } } })
  w.stamps.set(`${WS}/notebooks`, 2)
  await w.clock.advance(1100)
  ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  chips = await chipsOf(ui, 'para-tk-t0-1')
  expect(chips[0]).toMatchObject({ spin: true, mark: '' })
  expect(chips[0]!.tip).toBe('found on the card; ◌ being checked')
  await ui.unmount()
})

test("a time's tip says one state: found where its line writes it, red where it writes another; words with no value say only their place is checked, and never what a script got", async ($, on) => {
  // MATT-NOTES "Mockup feedback": a time like 14:52:11 read "its value is not checked, and a script got the same
  // number" in its tip and "only its place is checked" in its panel
  const w = world(on)
  const line = '{"id": 197, "ts": "2026-08-30T14:52:11.325+00:00", "agent": "agent-07", "action": "git.ref"}'
  w.resolve['events.jsonl#L197'] = { ref: 'events.jsonl#L197', kind: 'record', path: 'events.jsonl', line: 197, blocks: [{ text: line }], excerpt: line }
  await start($, w)
  const text = 'agent-07 pushed at [14:52:11](events.jsonl#L197), not at [14:58](events.jsonl#L197), as [the event](events.jsonl#L197) says.'
  let ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  await w.clock.advance(300)
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  const chips = await chipsOf(ui, 'para-1')
  expect(chips.map(c => c.tip)).toEqual(['found in events.jsonl line 197', 'not found in events.jsonl line 197 · the value is not at its place', 'found in events.jsonl line 197; only its place is checked'])
  expect(chips.map(c => c.state)).toEqual(['link', 'failed', 'link'])
  await ui.unmount()
  // in a card's takeaway, once the links check passed: a time got the same value; words with no value add nothing
  Object.assign(w.cells.ff73e071!, {
    takeaway: 'agent-07 pushed at [[14:52:11|events.jsonl#L197]], as [[the event|events.jsonl#L197]] says.',
    verification: { status: 'ok', links: { status: 'ok', checked: true, resolved: [{ value: '14:52:11', ref: 'events.jsonl#L197' }, { value: 'the event', ref: 'events.jsonl#L197' }], broken: [] } },
  })
  await turn($, w, [['r1', 'Here.']])
  ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  await w.clock.advance(300)
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  const tk = await chipsOf(ui, 'para-tk-t0-1')
  expect(tk.map(c => c.tip)).toEqual(['found in events.jsonl line 197, and a script got the same value', 'found in events.jsonl line 197; only its place is checked'])
  await ui.unmount()
})

test("the footer says `◌ checking N` while its citations are checked, no `failed` when none failed; a press on `N failed` opens the panel's Citations view", async ($, on) => {
  const w = world(on)
  await start($, w)
  const answer = 'The export holds [[4579|card:ff73e071#pages/TOTAL]] pages and [[14592|card:ff73e071#revisions/TOTAL]] revisions.'
  w.toolText = 'card:ff73e071\n[out0: table]'
  await $.turn.start({ text: 'How big?', turnId: 't1' } as never)
  await append($, 'r1', [{ type: 'text', text: answer }])
  await $.turn.complete({ turnId: 't1', answer, durationMs: 5, reason: 'answer', isAborted: false } as never)
  // before the batch that checks them: both checking, nothing failed
  let ui = (await $.ui.mount(MESSAGE('r1', answer))) as unknown as M
  let text = shown(await ui.find({ key: 'footer-r1' }))
  expect(text).toContain('2 citations · ◌ checking 2')
  expect(text).not.toContain('failed')
  await ui.unmount()
  await w.clock.advance(300)
  ui = (await $.ui.mount(MESSAGE('r1', answer))) as unknown as M
  text = shown(await ui.find({ key: 'footer-r1' }))
  expect(text).not.toContain('checking')
  expect(text).toContain('2 citations · 1 failed')
  await ui.press({ key: 'failed-r1' })
  await ui.unmount()
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('Citations')
  await pane.unmount()
})

test("a citation is purple and underlined, a purple ◌ a space after it while it is checked, neither underlined (`4,579 ◌`), nothing once found, red with × once it failed for good", () => {
  const runs = [{ text: 'It holds ' }, { text: '4,579', cite: { raw: '[[4,579|README.md#L3]]', ref: 'README.md#L3', display: '4,579' } }, { text: ' pages.' }]
  const lay = (look: { state: 'link' | 'failed'; mark: string; spin: boolean }, hover = -1) => paraLayout({ prefix: '', heading: 0, quote: false, runs }, [{ label: '4,579', tip: '', ...look }], 80, hover)
  const draw = (look: { state: 'link' | 'failed'; mark: string; spin: boolean }) => lay(look).lines.flat()
  // checking: the value purple and underlined, then a plain space and a purple ◌, not underlined (MATT-NOTES "Mockup
  // feedback": `14:52` underlined, space, `◌` purple plain)
  let segs = draw(chipLook('pending', undefined, undefined) as never)
  expect(segs.find(g => g.s === '4,579')).toMatchObject({ fg: COLORS.cite, u: true })
  expect(segs.find(g => g.s.includes('◌'))).toEqual({ s: '◌', fg: COLORS.cite })
  expect(segs.filter(g => g.u).map(g => g.s).join('')).toBe('4,579')
  expect(segs.map(g => g.s).join('')).toBe('It holds 4,579 ◌ pages.')
  // the spinner's cells are the citation's: a pointer over the ◌ is over the link; under it the value is bold, still
  // purple and underlined, never inverse (the owner, 10-17: "the citation text on hover is very hard to see")
  const checking = lay(chipLook('pending', undefined, undefined) as never)
  expect(checking.spans[0]).toMatchObject({ x0: 9, x1: 16 })
  const hovered = lay(chipLook('pending', undefined, undefined) as never, 0).lines.flat()
  expect(hovered.find(g => g.s === '4,579')).toEqual({ s: '4,579', fg: COLORS.cite, u: true, b: true })
  expect(hovered.some(g => g.inv || g.bg)).toBe(false)
  // found, and a script got the same number: no mark at all
  expect(chipLook('ok', undefined, 'verified')).toEqual({ state: 'link', mark: '', spin: false })
  segs = draw(chipLook('ok', undefined, 'verified') as never)
  expect(segs.map(g => g.s).join('')).toBe('It holds 4,579 pages.')
  // the links check still runs on a value the place does not show: purple and ◌, not red yet
  expect(chipLook('differs', undefined, 'running')).toEqual({ state: 'link', mark: '', spin: true })
  // not there for good: red, × right after it
  segs = draw(chipLook('differs', undefined, undefined) as never)
  expect(segs.find(g => g.s === '4,579')).toMatchObject({ fg: COLORS.problem, u: true })
  expect(segs.find(g => g.s.includes('×'))).toMatchObject({ s: ' ×', fg: COLORS.problem })
  expect(chipLook('ok', undefined, 'refuted')).toEqual({ state: 'failed', mark: '×', spin: false })
})

test("a takeaway's value the check corrected in place reads as corrected with no mark and no words beside it; its panel's `history 1` shows what Claude wrote, what the check made it, and why", async ($, on) => {
  const w = world(on)
  // the links check put 14591 in place of the 14592 Claude wrote (backend heal.py `corrected`)
  Object.assign(w.cells.ff73e071!, {
    takeaway: 'The export holds [[14591|card:ff73e071#revisions/TOTAL]] revisions.',
    verification: { status: 'ok', links: { status: 'ok', checked: true, resolved: [], broken: [{ value: '14591', ref: 'card:ff73e071#revisions/TOTAL', why: 'the cited place shows 14591', source: '14591', was: '14592', corrected: true }] } },
  })
  w.resolve['card:ff73e071#revisions/TOTAL'] = { ref: 'card:ff73e071#revisions/TOTAL', kind: 'cell', cell_id: 'ff73e071', excerpt: 'revisions × TOTAL = 14591', meta: { span: { col: 'revisions', row: 'TOTAL', value: '14591' } } }
  await start($, w)
  await turn($, w, [['r1', 'Here.']])
  let ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  await w.clock.advance(300)
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  const chips = await chipsOf(ui, 'para-tk-t0-1')
  expect(chips[0]).toMatchObject({ label: '14591', state: 'link', mark: '', spin: false })
  expect(chips[0]!.tip).not.toContain('correct')
  // no inline words for the rewrite (MATT-NOTES "Mockup feedback"): the card reads as it is now, nothing names 14592
  const card = JSON.stringify(await ui.drawn())
  expect(card).toContain('"label":"14591"')
  expect(card).not.toMatch(/14592|rewritten|history on click/)
  // `The export holds 14591 revisions.`: the value at column 17
  await ui.pointer({ type: 'down', x: 18, y: 0, button: 'left', in: 'para-tk-t0-1' } as never)
  await ui.pointer({ type: 'up', x: 18, y: 0, button: 'left', in: 'para-tk-t0-1' } as never)
  await ui.unmount()
  await w.clock.settle()
  let pane = (await $.ui.mount(PANE)) as unknown as M
  // at rest only the bar says it: `checked ›   history 1 ›`
  expect(shown(await pane.find({ key: 'cite-bar' }))).toBe('checked ›history 1 ›')
  expect(shown(await pane.drawn())).not.toContain('Claude wrote')
  await pane.press({ key: 'cite-history' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  const text = shown(await pane.drawn())
  expect(shown(await pane.find({ key: 'cite-history-0' }))).toBe('Claude wrote 14592')
  expect(shown(await pane.find({ key: 'cite-history-1' }))).toBe('the check made it 14591 · the cited place shows 14591')
  expect(shown(await pane.find({ key: 'cite-bar' }))).toBe('checked ›history 1 ⌄')
  expect(text).not.toContain('×')
  await pane.unmount()
})

test("a citation is checked as soon as it streams whole, before its block is drawn", async ($, on) => {
  const w = world(on)
  let chunks: { kind: string; index?: number; text?: string }[] = []
  on('turn.step', async function* ($, e) {
    for (const c of chunks) yield c as never
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await start($, w)
  await $.turn.start({ text: 'How many?', turnId: 't1' } as never)
  const reply = 'It holds [[4,579|README.md#L3]] pages and more'
  chunks = [{ kind: 'text', index: 0, text: reply }]
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as never)) void _
  // the line is not finished, and nothing drew it: the next batch checks its citation
  await w.clock.advance(300)
  const resolves = w.calls.filter(c => c[2] === 'resolve')
  expect(resolves.length).toBe(1)
  expect(resolves[0]!.join(' ')).toContain('README.md#L3')
})

test("while main's reply streams, Claude Code is handed links and a card's placeholder, never `[[`; the row is stored as written", { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  let chunks: { kind: string; index?: number; text?: string }[] = []
  const stored: string[] = []
  on('turn.step', async function* ($, e) {
    for (const c of chunks) yield c as never
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  on('session.append', ($, e, next) => {
    for (const b of e.message.content as { type: string; text?: string }[]) if (b.type === 'text') stored.push(b.text!)
    return next(e)
  })
  await start($, w)
  await $.turn.start({ text: 'How many?', turnId: 't1' } as never)
  const reply = 'It holds [[4,579|README.md#L3]] pages.\n[[card:ff73e071]]\nDone.'
  const cuts = [0, 12, 30, 44, 52]
  chunks = cuts.map((at, i) => ({ kind: 'text', index: 0, text: reply.slice(at, cuts[i + 1]) }))
  chunks.push({ kind: 'stop', stopReason: 'end_turn', usage: null } as never)
  const got: { kind: string; text?: string }[] = []
  for await (const c of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as never)) got.push(c as never)
  const text = got.filter(c => c.kind === 'text').map(c => c.text).join('')
  expect(text).not.toContain('[[')
  expect(text).toContain(`It holds [4,579](file://${CWD}/README.md) pages.`)
  expect(text).toContain('◌ drawing the card')
  await append($, 'r1', [{ type: 'text', text }])
  expect(stored.at(-1)).toBe(reply)
})

test("a citation of a card's value in main's prose is checked again when the card changes: a stale one turns red", { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  await start($, w)
  const text = 'dse holds [[3908|card:ff73e071#pages/dse]] pages.'
  let ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  await w.clock.advance(300)
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  expect((await chipsOf(ui, 'para-1'))[0]!.state).toBe('link')
  await ui.unmount()
  // the card ran again and now shows 4000 for dse
  w.resolve['card:ff73e071#pages/dse'] = { ref: 'card:ff73e071#pages/dse', kind: 'cell', cell_id: 'ff73e071', excerpt: 'pages × dse = 4000', meta: { span: { col: 'pages', row: 'dse', value: '4000' } } }
  w.stamps.set(`${WS}/notebooks`, 2)
  await w.clock.advance(1100)
  ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  const chip = (await chipsOf(ui, 'para-1'))[0]!
  expect(chip).toMatchObject({ state: 'failed', mark: '×' })
  expect(chip.tip).toBe('not found on the card · the place shows 4000')
  await ui.unmount()
})

test("under main's `↳ The writer finished …` row, a line links the document out to the browser workbench, once", async ($, on) => {
  // Matt (10-16): documents are read-only in the terminal; when the writer finishes, a line under the turn links out to
  // the browser workbench, where the document is read whole, edited, and its figures and history shown
  const w = world(on)
  const writer = { name: 'thimble:writer', label: 'writer: report', state: 'running', kind: 'subagent', chat: 'w1', role: 'writer', started: '2026-10-06T10:10:00+00:00' }
  ;(w.states.agents.rows as unknown[]).push(writer)
  await start($, w)
  await w.clock.advance(1100)
  // the writer ends: its chat and the documents change, and the documents are read again (band.tsx noteWriters)
  writer.state = 'done'
  w.stamps.set(`${WS}/chats`, 2)
  w.stamps.set(`${WS}/investigations/main`, 2)
  await w.clock.advance(1100)
  const line = '↳ The writer finished the report; thimble shows it.'
  const ui = (await $.ui.mount(MESSAGE('r1', line))) as unknown as M
  expect(shown(await ui.drawn())).toContain('↳ document "Agents used the dse wiki as a relay" · read and edit it in the browser ↗')
  await ui.press({ key: 'written-open-r1' })
  await w.clock.settle()
  await ui.unmount()
  // the press (offramp.ts): `thimble open` on the document's ref
  expect(w.calls.some(c => c[1] === 'open' && c.includes('report:report'))).toBe(true)
  // a later row about the same run says nothing more
  const again = (await $.ui.mount(MESSAGE('r2', `${line}\n\nThe thread is asked.`))) as unknown as M
  expect(shown(await again.drawn())).not.toContain('↳ document')
  await again.unmount()
})

// ------------------------------------------------------------------------------------------------ 0.9.0

test('"Citation marks" off: a citation is a plain link, with no mark and no check of its place', { timeoutMs: 30000, options: { citationMarks: false } }, async ($, on) => {
  const w = world(on)
  w.features.citationMarks = false
  await start($, w)
  await turn($, w, [['r1', 'The export holds [[14592|card:ff73e071#revisions/TOTAL]] revisions.']])
  const ui = (await $.ui.mount(MESSAGE('r1', 'The export holds [[14592|card:ff73e071#revisions/TOTAL]] revisions.'))) as unknown as M
  const chips = await chipsOf(ui, 'para-1')
  expect(chips[0]).toMatchObject({ label: '14592', state: 'link', mark: '', spin: false, tip: '' })
  await ui.unmount()
  await w.clock.advance(1000)
  expect(w.calls.filter(c => c[2] === 'resolve')).toEqual([])
})

test('under the pointer a citation turns bold and nothing more: no inverse, no box beside it; a press still opens it', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  await start($, w)
  const text = 'The board holds [4,579](README.md#L3) pages in all.'
  await turn($, w, [['r1', text]])
  const ui = (await $.ui.mount(MESSAGE('r1', text))) as unknown as M
  const json = JSON.stringify(await ui.drawn())
  const para = /"key":"(para-\d+)"/.exec(json)![1]!
  const x = 'The board holds '.length
  await ui.pointer({ type: 'move', x, y: 0, in: para } as never)
  await w.clock.advance(50)
  const drawn = JSON.stringify(await ui.drawn({ in: para } as never))
  expect(drawn).toContain(`"color":"${COLORS.cite}","bold":true,"underline":true},"children":["4,579"]`)
  expect(drawn).not.toContain('"inverse":true')
  expect(drawn).not.toContain('backgroundColor')
  await ui.pointer({ type: 'down', x, y: 0, button: 'left', in: para } as never)
  await ui.pointer({ type: 'up', x, y: 0, button: 'left', in: para } as never)
  await w.clock.settle()
  expect(w.panes.at(-1)).toMatchObject({ title: 'Citation' })
  await ui.unmount()
})
