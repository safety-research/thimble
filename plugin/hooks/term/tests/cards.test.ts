// The card pane: how the card's last run ended, `run again` (r) asking main to run it, and what its code printed; a
// card's takeaway one blank row under its label row; every citation inside a card in the citation's purple; a plan's
// steps, each a bold title after its number and state glyph with its words, output and note under it.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { cardOfCell } from '../cell'
import type { ThimbleCell } from '../cell'
import { cardLayout, stepParts } from '../draw'
import { citations } from '../lib'
import { verdictOf } from '../model'
import type { Line } from '../draw'
import { COLORS } from '../paint'
import { CELLS, CWD, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: 'thimble', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
const PANE = { plugin: 'thimble', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 36 }, view: {} } } as never

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

async function turn($: E, w: World, card: string): Promise<void> {
  w.toolText = `card:${card}\n[out0: table]`
  await $.turn.start({ text: 'How many?', turnId: 't1' } as never)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'r1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Here.' }] } } as never).catch(() => undefined)
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u1' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Here.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
}

test("the card pane says how the card's last run ended; `run again` (r) asks main to run it; its code shows what it printed", { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  Object.assign(w.cells.k0code00!, { code: "print('revisions.jsonl', 14591)" })
  await start($, w)
  await turn($, w, 'k0code00')
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  await ui.unmount()
  // home lists the card; open its pane from the home panel's row
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  let pane = (await $.ui.mount(PANE)) as unknown as M
  const rows = ((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []
  const y = rows.findIndex(r => shown(r).includes('How many lines?'))
  expect(y).toBeGreaterThan(0)
  await pane.pointer({ type: 'down', x: 6, y, button: 'left', in: 'm:home' } as never)
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  let text = shown(await pane.drawn())
  expect(text).toContain('How many lines?')
  expect(text).toContain('code · made by main · last run ok')
  expect(text).toContain('run again')
  expect(text).toContain('c for its code · r to run again · a to ask · b to go back · x to close')
  await pane.press({ key: 'card-again' })
  expect(w.submitted.at(-1)).toBe('Run this card again. Use Bash to run this command exactly as it is, with no `cd` before it: thimble-run card k0code00')
  // its code, then what its last run printed
  await pane.press({ key: 'card-code' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  text = shown(await pane.drawn())
  expect(text).toContain('card "How many lines?" · code')
  expect(text).toContain('output')
  expect(text).toContain('events.jsonl 19913')
  expect(text).toContain('c for the card · r to run again · a to ask · b to go back · x to close')
  await pane.unmount()
})

test("a card whose run ended and whose check waits to start: the card says `◌ checking`, the pane offers `run again`, never `◌ running` (bug hunt B19)", { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  Object.assign(w.cells.k0code00!, { code: 'print(8)', run: { state: 'done', by: 'bash' }, check: 'pending' })
  await start($, w)
  await turn($, w, 'k0code00')
  await $.command.run({ command: 'thimble:thimble', args: 'card k0code00' } as never)
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const text = shown(await pane.drawn())
  expect(shown(await pane.drawn({ in: 'card-pane-k0code00' }))).toContain('◌ checking')
  expect(text).toContain('last run ok')
  expect(text).not.toContain('◌ running')
  expect(text).toContain('run again')
  expect(text).toContain('r to run again')
  await pane.press({ key: 'card-again' })
  expect(w.submitted.at(-1)).toBe('Run this card again. Use Bash to run this command exactly as it is, with no `cd` before it: thimble-run card k0code00')
  await pane.unmount()
})

// the card's region (a Client), a blank row, then the takeaway
const GAP = /"client":\{"plugin":"thimble"\}\},\{"type":"Text","children":\[" "\]\},\{"type":"Box".*The dse wiki has the most revisions\./

test('a card with a label: a blank row between the label row and the takeaway', async ($, on) => {
  const w = world(on)
  Object.assign(w.cells.b0bar000!, { labels: ['d9b51617'], takeaway: 'The dse wiki has the most revisions.' })
  await start($, w)
  await turn($, w, 'b0bar000')
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  const json = JSON.stringify(await ui.drawn())
  // the card's region ends with its label row; then the blank row; then the takeaway
  expect(json).toMatch(GAP)
  await ui.resize({ columns: 110, rows: 20, in: 'card-t0-b0bar000' })
  expect(shown(await ui.drawn({ in: 'card-t0-b0bar000' }))).toMatch(/label {2}links through a fetch proxy ↗ {2}● proxy-link {2}● none$/)
  await ui.unmount()
})

test('a card with no label: its takeaway right under the card', async ($, on) => {
  const w = world(on)
  w.cells.b0bar000!.takeaway = 'The dse wiki has the most revisions.'
  await start($, w)
  await turn($, w, 'b0bar000')
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  const json = JSON.stringify(await ui.drawn())
  expect(json).toContain('The dse wiki has the most revisions.')
  expect(json).not.toMatch(GAP)
  await ui.unmount()
})

test("inside a card every citation and evidence mark is in the citation's purple: an example's ● and its ↗ and place, a timeline's ↗; one underline color; bold, not inverse, under the pointer", () => {
  // MATT-NOTES "Mockup feedback": "no two underline colors"; the link color stays for actions (↗ open, buttons)
  const example = cardOfCell({ id: 'x0quot00', notebook: 'g1', kind: 'example', title: 'Was anything force-pushed?', takeaway: '', labels: [], created_by: 'main', status: 'ok', payload: { refs: [{ ref: 'events.jsonl#L197', quote: '{"forced": true}' }] } } as unknown as ThimbleCell).card
  const segs = cardLayout(example, 80, -1).lines.flat()
  // its bullet too: one evidence color in a card (the owner, 10-17: "card bullet and citations are different colors")
  expect(segs.find(g => g.s === '● ')).toEqual({ s: '● ', fg: COLORS.cite })
  expect(segs.find(g => g.s === '↗')).toEqual({ s: '↗', fg: COLORS.cite })
  expect(segs.find(g => g.s.startsWith('events.jsonl'))).toEqual({ s: 'events.jsonl line 197', fg: COLORS.cite, u: true })
  expect(segs.some(g => g.fg === COLORS.link)).toBe(false)
  expect(new Set(segs.filter(g => g.fg).map(g => g.fg))).toEqual(new Set([COLORS.cite]))
  // the record under the pointer: its place bold, never inverse
  const on = cardLayout(example, 80, 0).lines.flat()
  expect(on.find(g => g.s.startsWith('events.jsonl'))).toEqual({ s: 'events.jsonl line 197', fg: COLORS.cite, u: true, b: true })
  expect(on.some(g => g.inv || g.bg)).toBe(false)
  const timeline = cardOfCell({ ...(CELLS.e0time00 as object), outputs: [{ 'application/vnd.thimble.timeline+json': { events: [{ time: '2026-05-24', label: 'first saves', ref: 'events.jsonl#L3' }, { time: '2026-06-18', label: 'peak afternoon' }] } }] } as unknown as ThimbleCell).card
  const marks = cardLayout(timeline, 60, -1).lines.flat().filter(g => g.s === '↗')
  expect(marks).toEqual([{ s: '↗', fg: COLORS.cite }])
})

/** The 5-step plan the owner's live test drew (10-17), its statuses one of each kind. */
const PLAN_STEPS = [
  { text: 'Read each session closely: one agent per participant reads the transcript and what they typed into thimble, and writes a memo of initial codes, each with a timestamped quote.', makes: ['7 participant memos'], status: 'done', started: '2026-10-16T10:00:00Z', ended: '2026-10-16T10:42:00Z' },
  { text: 'Merge the codes: group the initial codes of all seven memos into a shared codebook with a definition and two quotes per code.', makes: ['codebook'], status: 'running', time: '12 m' },
  { text: 'Label every session with the codebook', makes: ['a label per code'], status: 'not started' },
  { text: 'Check the labels against the memos: sample ten units per code and read them against its definition; note where they disagree.', makes: ['agreement per code'], status: 'needs you', note: 'Two codes overlap; which to keep is your call.' },
  { text: 'Write it up: one section per theme, each with its codes, how many sessions show it, and three quotes.', makes: ['report'], status: 'not started' },
]

const plain = (l: Line) => l.map(g => g.s).join('')

test("a plan step's title is the clause before its first colon; a colon inside a time or an address is no clause's end", () => {
  expect(stepParts('Read each session closely: one agent per participant reads it.')).toEqual({ title: 'Read each session closely', rest: 'one agent per participant reads it.' })
  expect(stepParts('Run the 10:53 job again')).toEqual({ title: 'Run the 10:53 job again', rest: '' })
  expect(stepParts('Fetch https://example.org/a then read it')).toEqual({ title: 'Fetch https://example.org/a then read it', rest: '' })
})

test("a plan card: each step's number, its state glyph and its title in bold, its words under the title at one width, its output dim on its own row, a blank row between steps", () => {
  const card = cardOfCell({ id: 'p0plan00', notebook: 'g1', kind: 'plan', title: 'How do participants use thimble?', takeaway: '', labels: [], created_by: 'main', status: 'ok', payload: { steps: PLAN_STEPS } } as unknown as ThimbleCell).card
  const cols = 80
  const lines = cardLayout(card, cols, -1).lines
  const text = lines.map(plain)
  // no bracketed status word on any step (the owner: "[not started] repeats on every step")
  expect(text.some(t => /\[(?:not started|running|done|needs you)/.test(t))).toBe(false)
  // the first step: `1. ● Read each session closely` with its time at the right edge, dim
  expect(text[0]!.startsWith('1. ● Read each session closely')).toBe(true)
  expect(lines[0]!.find(g => g.s === 'Read each session closely')).toEqual({ s: 'Read each session closely', b: true })
  expect(lines[0]!.at(-1)).toEqual({ s: '42 m', fg: COLORS.dim })
  expect(text[0]!.length).toBe(cols)
  // each status's glyph: done ●, running ◌ in the accent, not started ○ dim, needs you ! in red
  const heads = lines.filter(l => /^\d\. /.test(plain(l)))
  expect(heads.length).toBe(5)
  expect(heads.map(l => l[1])).toEqual([{ s: '●' }, { s: '◌', fg: COLORS.accent }, { s: '○', fg: COLORS.dim }, { s: '!', fg: COLORS.problem }, { s: '○', fg: COLORS.dim }])
  // a blank row before every step but the first
  for (const h of heads.slice(1)) expect(lines[lines.indexOf(h) - 1]).toEqual([])
  // the rest of a step's words in the text color, indented under its title, wrapped at one width for every step: a row
  // ends only where its next word would not fit
  const room = cols - 5
  const body = lines.filter(l => l.length === 2 && l[0]!.s === '     ' && !l[1]!.fg && !l[1]!.b)
  expect(body.length).toBeGreaterThan(4)
  for (const l of lines) expect(plain(l).length).toBeLessThanOrEqual(cols)
  for (const [i, l] of body.entries()) {
    const next = body[i + 1]
    if (next && lines.indexOf(next) === lines.indexOf(l) + 1) expect(l[1]!.s.length + 1 + next[1]!.s.split(' ')[0]!.length).toBeGreaterThan(room)
  }
  // what a step makes on its own row, dim, under the title; a note dim under it
  const made = lines.find(l => plain(l).trim() === '→ 7 participant memos')!
  expect(made).toEqual([{ s: '     ' }, { s: '→ 7 participant memos', fg: COLORS.dim }])
  expect(text).toContain('     Two codes overlap; which to keep is your call.')
  // a step with no colon is all title
  expect(text).toContain('3. ○ Label every session with the codebook')
})

test("an example quotes a database row by its fields, never as one line of JSON: those the card quotes or cites first, its line ends kept, then those it names (bug hunt B17)", { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  const pr = 'runs/s3/forge.db#prs/66972'
  const review = 'runs/s3/forge.db#reviews/14'
  const prRow = { number: 66972, title: 'DEPS: Remove hypothesis', body: '- [ ] closes #66675\r\n\r\n- [x] I used AI to develop this pull request.', author: 'gh:mroeschke', state: 'merged', claimed_by: 'agent-16', merged_by: 'agent-16', closed_by: null }
  const reviewRow = { id: 14, pr: 66972, reviewer: 'agent-16', verdict: 'approve', body: 'Reviewed: verified clean merge onto current main\r\nand ran the full set of touched test modules.' }
  w.resolve[pr] = { ref: pr, kind: 'row', path: 'runs/s3/forge.db', table: 'prs', pk: '66972', record: prRow, excerpt: JSON.stringify(prRow) }
  w.resolve[review] = { ref: review, kind: 'row', path: 'runs/s3/forge.db', table: 'reviews', pk: '14', record: reviewRow, excerpt: JSON.stringify(reviewRow) }
  w.cells.x0rows00 = {
    id: 'x0rows00', notebook: 'g1', kind: 'example', title: 'What do merges look like when one agent claimed and merged a PR alone?', labels: [], created_by: 'main', ts: '2026-10-06T10:00:00+00:00',
    takeaway: 'Agent-16 merged [["DEPS: Remove hypothesis"|runs/s3/forge.db#prs/66972]] a minute after claiming it.',
    payload: { refs: [pr, review], quotes: ['', 'verified clean merge'] },
  }
  await start($, w)
  await turn($, w, 'x0rows00')
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  const client = (await ui.find({ type: 'Client', key: 'card-t0-x0rows00' })) as unknown as { props: { props: { card: Parameters<typeof cardLayout>[0] } } }
  const lines = cardLayout(client.props.props.card, 100, -1).lines.map(l => l.map(x => x.s).join(''))
  const text = lines.join('\n')
  expect(text).not.toContain('{"')
  expect(text).not.toContain('\\r\\n')
  // the PR: the title its takeaway cites first, then the fields the card names (claimed, merged), then the others
  expect(lines[0]).toBe('● title  "DEPS: Remove hypothesis"')
  expect(lines[1]).toMatch(/^ {2}claimed_by agent-16 · merged_by agent-16 · number 66972/)
  // the review: the body the card quotes from it, its line end kept, then its other fields
  const at = lines.findIndex(l => l.startsWith('● body'))
  expect(lines[at]).toBe('● body  "Reviewed: verified clean merge onto current main')
  expect(lines[at + 1]).toBe('        and ran the full set of touched test modules."')
  expect(lines[at + 2]).toMatch(/^ {2}id 14 · pr 66972 · reviewer agent-16 · verdict approve/)
  await ui.unmount()
})

test("an example of a wiki save draws its edit summary before its page text, and a citation of the summary's words is at its place (bug hunt J6)", { timeoutMs: 30_000 }, async ($, on) => {
  // the card drew the save's text alone, and the summary its quote came from read as not in the record
  const w = world(on)
  const ref = 'revisions.jsonl#L2'
  const record = { rev_id: 'Tomatoes@4', name: 'Tomatoes', label: 'Rowan', body: '= Tomatoes =\nPlant them out after the last frost.', change_summary: 'undo the seed shop advert' }
  const res = { ref, kind: 'record', path: 'revisions.jsonl', line: 2, record, blocks: [{ kind: 'text', text: record.body }], excerpt: record.body, meta: {}, fields: [{ key: 'change_summary', text: record.change_summary }] }
  w.resolve[ref] = res
  w.cells.x0save00 = {
    id: 'x0save00', notebook: 'g1', kind: 'example', title: "What did Rowan's save on the Tomatoes page undo?", labels: [], created_by: 'main', ts: '2026-10-06T10:00:00+00:00',
    takeaway: `Rowan's save says [["undo the seed shop advert"|${ref}]].`,
    payload: { refs: [ref], quotes: ['undo the seed shop advert'] },
  }
  await start($, w)
  await turn($, w, 'x0save00')
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  const client = (await ui.find({ type: 'Client', key: 'card-t0-x0save00' })) as unknown as { props: { props: { card: Parameters<typeof cardLayout>[0] } } }
  const lines = cardLayout(client.props.props.card, 100, -1).lines.map(l => l.map(x => x.s).join(''))
  expect(lines[0]).toBe('● change_summary  "undo the seed shop advert"')
  expect(lines[1]).toContain('Plant them out after the last frost.')
  const v = verdictOf(citations(`[["undo the seed shop advert"|${ref}]]`)[0]!, res as never)
  expect(v.status).toBe('ok')
  expect(v.lines.at(-1)).toMatchObject({ text: 'change_summary: undo the seed shop advert', hit: true, field: true })
  await ui.unmount()
})

test('an example of a record whose text holds garbled control characters draws, each such character shown as a visible sign, never raw', { timeoutMs: 30_000 }, async ($, on) => {
  // text decoded twice leaves C1 controls (U+0080-U+009F) where a character's bytes were; a log line can hold an
  // escape sequence or a bell: a drawing whose text holds one does not validate, and the card did not draw
  const w = world(on)
  const ref = 'revisions.jsonl#L3'
  const body = 'Plant them\u0080 out after the \u001b[31mlast\u001b[0m frost\u0007 â\u0080\u0099s day\u009d.'
  const record = { rev_id: 'Beans@2', name: 'Beans', label: 'Rowan', body, change_summary: 'tidy\u0085 up' }
  w.resolve[ref] = { ref, kind: 'record', path: 'revisions.jsonl', line: 3, record, blocks: [{ kind: 'text', text: body }], excerpt: body, meta: {}, fields: [{ key: 'change_summary', text: record.change_summary }] }
  w.cells.x0ctrl00 = {
    id: 'x0ctrl00', notebook: 'g1', kind: 'example', title: "What did Rowan's save on the Beans page say?", labels: [], created_by: 'main', ts: '2026-10-06T10:00:00+00:00',
    takeaway: 'Rowan planted beans.', payload: { refs: [ref] },
  }
  await start($, w)
  await turn($, w, 'x0ctrl00')
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  const drawn = (((await ui.drawn({ in: 'card-t0-x0ctrl00' })) as { children?: unknown[] }).children ?? []).map(r => shown(r)).join('\n')
  expect(drawn).toContain('Plant them� out after the ␛[31mlast␛[0m frost␇ ’s day�.')
  expect(drawn).toContain('tidy� up')
  expect(drawn).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
  await ui.unmount()
})

test("an example of a JSON document's message draws the passage the card quotes from its tool call, on the citation's highlight, never the message's JSON (bug hunt round 10, K3)", { timeoutMs: 30_000 }, async ($, on) => {
  // the card drew `{ "id": "m7", "role": "assistant", "content": [ { "type": "tool_use", …` cut after three rows
  const w = world(on)
  const ref = 'picnic/rowan_chat.json#/messages/m7'
  const command = "cat >> NOTES.md <<'EOF'\n## Picnic, Saturday\n\n" + 'We weighed the park, the beach and the garden at length. '.repeat(8) + "\n\n`CHOICE: north gate` — Rowan\n\n(Maya brings the tables.)\nEOF"
  const record = { id: 'm7', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x1', name: 'Bash', input: { command, description: 'Add my choice' } }], first_seen_ts: 1782799367.69 }
  const res = { ref, kind: 'pointer', path: 'picnic/rowan_chat.json', record, blocks: [{ kind: 'tool_use', text: `Bash\n${JSON.stringify({ command, description: 'Add my choice' }, null, 2)}` }], excerpt: JSON.stringify(record, null, 2), meta: { n: 7, line: 40, end_line: 52 } }
  w.resolve[ref] = res
  w.cells.x0vote00 = {
    id: 'x0vote00', notebook: 'g1', kind: 'example', title: 'How did Rowan cast a choice?', labels: [], created_by: 'main', ts: '2026-10-06T10:00:00+00:00',
    takeaway: `Rowan [[wrote "\`CHOICE: north gate\` — Rowan"|${ref}]] in a Bash call.`,
    payload: { refs: [ref], quotes: ['`CHOICE: north gate` — Rowan'] },
  }
  await start($, w)
  await turn($, w, 'x0vote00')
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  const client = (await ui.find({ type: 'Client', key: 'card-t0-x0vote00' })) as unknown as { props: { props: { card: Parameters<typeof cardLayout>[0] } } }
  const lay = cardLayout(client.props.props.card, 100, -1).lines
  const text = lay.map(l => l.map(x => x.s).join(''))
  expect(text.join('\n')).not.toContain('"role"')
  expect(text[0]).toMatch(/^● Bash {2}/)
  // the passage on the highlight, over a row's break where it wraps
  const lit = lay.map(l => l.filter(x => x.bg).map(x => x.s).join('')).filter(Boolean).join(' ')
  expect(lit).toBe('`CHOICE: north gate` — Rowan')
  await ui.unmount()
})

test("an example of a JSON lines record of no known shape draws its fields, not its JSON; two spans of one record each draw their own passage, marked (bug hunt round 10, K3)", { timeoutMs: 30_000 }, async ($, on) => {
  // the card drew `“{ "record": "message", "index": 84, …` for each, and the record cited twice twice the same
  const w = world(on)
  const rec = (index: number, result: string) => ({ record: 'message', index, role: 'Assistant', type: 'ToolMessage', tool_name: 'terminal', tool_call: { session_name: 'garden', timeout: '20' }, tool_result: result })
  const one = rec(84, '\nWelcome to the shed.\nError: the gate is locked for path 8443\n\nG_FAIL\n')
  const two = rec(87, '\nWelcome to the shed.\nError: the gate is locked for path 8443\n\nG_LO_FAIL\nWelcome to the shed.\nError: the gate is locked for path 18080\n\nG_FAIL\n')
  const raw = (r: unknown) => JSON.stringify(r, null, 2)
  const span = (line: number, r: unknown, words: string) => {
    const text = raw(r)
    const a = text.lastIndexOf(words)
    const ref = `shed/log.jsonl#L${line}.b0:c${a}-${a + words.length}`
    w.resolve[ref] = { ref, kind: 'span', path: 'shed/log.jsonl', line, block: 0, start: a, end: a + words.length, record: r, blocks: [{ kind: 'raw', text }], excerpt: words, meta: {} }
    return ref
  }
  w.resolve['shed/log.jsonl#L4'] = { ref: 'shed/log.jsonl#L4', kind: 'record', path: 'shed/log.jsonl', line: 4, record: one, blocks: [{ kind: 'raw', text: raw(one) }], excerpt: raw(one), meta: {} }
  const refs = ['shed/log.jsonl#L4', span(7, two, 'path 8443'), span(7, two, 'path 18080')]
  w.cells.x0shed00 = {
    id: 'x0shed00', notebook: 'g1', kind: 'example', title: 'Which tool results say the gate is locked?', labels: [], created_by: 'main', ts: '2026-10-06T10:00:00+00:00',
    takeaway: 'Two tool results say the gate is locked.', payload: { refs },
  }
  await start($, w)
  await turn($, w, 'x0shed00')
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  const client = (await ui.find({ type: 'Client', key: 'card-t0-x0shed00' })) as unknown as { props: { props: { card: Parameters<typeof cardLayout>[0] } } }
  const lay = cardLayout(client.props.props.card, 140, -1).lines
  const text = lay.map(l => l.map(x => x.s).join(''))
  expect(text.join('\n')).not.toContain('"record"')
  expect(text[0]).toMatch(/^● tool_result {2}/)
  // the two spans of one record one example, each passage on the highlight
  expect(text.filter(t => t.startsWith('●'))).toHaveLength(2)
  const lit = lay.flatMap(l => l.filter(x => x.bg).map(x => x.s))
  expect(lit).toEqual(['path 8443', 'path 18080'])
  expect(text.join('\n')).toContain('shed/log.jsonl line 7')
  await ui.unmount()
})

test("an example whose ref names only a line draws the passage its takeaway quotes from that record, marked, in a field the record's words leave out too (bug hunt L5)", { timeoutMs: 30_000 }, async ($, on) => {
  // the card's refs named lines, its quotes stood only in its takeaway: each record drew from its start, the quoted
  // error of the second unseen and nothing marked
  const w = world(on)
  const result = '\n<counter>42</counter> wren@shed:/tmp/pkg$ \n' + '/usr/bin/kettle\n'.repeat(12) + "Traceback (most recent call last):\n  File \"<string>\", line 1, in <module>\nModuleNotFoundError: No module named 'gizmo'\n<counter>43</counter> wren@shed:/tmp/pkg$ "
  const rec = { record: 'message', index: 61, role: 'Assistant', type: 'ToolMessage', tool_name: 'terminal', tool_call: { session_name: 'main', text: 'which kettle; python3 -c "import gizmo"' }, tool_result: result }
  w.resolve['shed/log.jsonl#L62'] = { ref: 'shed/log.jsonl#L62', kind: 'record', path: 'shed/log.jsonl', line: 62, record: rec, blocks: [{ kind: 'text', text: rec.tool_call.text }], fields: [{ key: 'tool_result', text: result.trim() }], excerpt: rec.tool_call.text, meta: {} }
  const words = 'Hello from the shed. '.repeat(30) + 'Error: the gate is locked for port 8443. Bye.'
  w.resolve['shed/log.jsonl#L4'] = { ref: 'shed/log.jsonl#L4', kind: 'record', path: 'shed/log.jsonl', line: 4, record: { text: words }, blocks: [{ kind: 'text', text: words }], excerpt: words, meta: {} }
  w.cells.x0line00 = {
    id: 'x0line00', notebook: 'g1', kind: 'example', title: 'Which commands failed?', labels: [], created_by: 'main', ts: '2026-10-06T10:00:00+00:00',
    takeaway: `The gate said [["Error: the gate is locked for port 8443"|shed/log.jsonl#L4]] and Python gave [["ModuleNotFoundError: No module named 'gizmo'"|shed/log.jsonl#L62]].`,
    payload: { refs: ['shed/log.jsonl#L4', 'shed/log.jsonl#L62'] },
  }
  await start($, w)
  await turn($, w, 'x0line00')
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  const client = (await ui.find({ type: 'Client', key: 'card-t0-x0line00' })) as unknown as { props: { props: { card: Parameters<typeof cardLayout>[0] } } }
  const lay = cardLayout(client.props.props.card, 120, -1).lines
  const text = lay.map(l => l.map(x => x.s).join(''))
  const lit = lay.flatMap(l => l.filter(x => x.bg).map(x => x.s)).join('|')
  expect(lit).toContain('Error: the gate is locked for port 8443')
  expect(lit).toContain("ModuleNotFoundError: No module named 'gizmo'")
  // the second record at its tool's result, where the error stands, not its command or the result's first lines
  expect(text.find(t => t.startsWith('●') && t.includes('tool_result'))).toBeDefined()
  expect(text.join('\n')).not.toContain('<counter>42</counter>')
  await ui.unmount()
})

test("a failed check of a citation in a card main made is told to main once, as a note for its next reply; a fork's card's is not (bug hunt L4)", { timeoutMs: 30_000 }, async ($, on) => {
  // thimble marked main's three quotes × and told main nothing, so main's answer kept claims none of the records held
  const w = world(on)
  const rec = (n: number, text: string) => ({ ref: `shed/log.jsonl#L${n}`, kind: 'record', path: 'shed/log.jsonl', line: n, record: { text }, blocks: [{ kind: 'text', text }], excerpt: text, meta: {} })
  w.resolve['shed/log.jsonl#L85'] = rec(85, 'A picture of the shed door.')
  w.resolve['shed/log.jsonl#L4'] = rec(4, 'Error: the gate is locked for port 8443')
  const card = (id: string, by: string) => ({
    id, notebook: 'g1', kind: 'example', title: 'Which commands failed?', labels: [], created_by: by, ts: '2026-10-06T10:00:00+00:00',
    takeaway: 'The gate said [["Error: the gate is locked for port 8443"|shed/log.jsonl#L85]] and again [["Error: the gate is locked for port 8443"|shed/log.jsonl#L4]].',
    payload: { refs: ['shed/log.jsonl#L85', 'shed/log.jsonl#L4'] },
  })
  w.cells.x0fail00 = card('x0fail00', 'main')
  await start($, w)
  await turn($, w, 'x0fail00')
  await w.clock.advance(300)
  const told = w.acts.filter(a => a.kind === 'cite-failed')
  expect(told).toHaveLength(1)
  expect(told[0]!.payload.cites).toEqual([{ shown: '"Error: the gate is locked for port 8443"', ref: 'shed/log.jsonl#L85', why: 'the value is not at its place', card: 'x0fail00' }])
  // told once, also when the card is read again
  await w.clock.advance(5000)
  expect(w.acts.filter(a => a.kind === 'cite-failed')).toHaveLength(1)
  // a card a fork made: its failed citation is not main's
  w.resolve['shed/log.jsonl#L86'] = rec(86, 'Another picture.')
  w.cells.x0fork00 = { ...card('x0fork00', 'thread'), takeaway: 'It said [["the kettle is cold"|shed/log.jsonl#L86]].' }
  w.toolText = 'card:x0fork00\n[out0: table]'
  await $.turn.start({ text: 'And?', turnId: 't2' } as never)
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u2', agentId: 'a0fork' } as never)
  await $.turn.complete({ turnId: 't2', answer: '', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(5300)
  expect(w.acts.filter(a => a.kind === 'cite-failed')).toHaveLength(1)
})
