// The live check term-fix8's code quirks: a link to a label or a document's passage named in words, never its id; a label
// with no run drawn as `not run yet` on its card; a card's path step named by its question on its first open; the toast
// after a relaunch for what came before the quit and was never opened; a note under a card the card check rewrote.
// `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { KEPT_FILE, parseKept, resetKept } from '../hooks/kept'
import { CWD, DOC, WS, shown, takesKeys, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine
type ChipProps = { props: { props: { chips: { label: string; state: string; tip: string }[] } } }

const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: 'thimble-term', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
const PANE = { plugin: 'thimble-term', component: 'Pane', requestId: 'thimble-term', surface: 'terminal', viewport: { columns: 120, rows: 124 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 120 }, view: {} } } as never
const ABOVE = { plugin: 'thimble-term', component: 'AbovePrompt', requestId: 'above', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { hasSurvey: false, isWorking: false, view: {} } } as never

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

const append = ($: E, uuid: string, text: string) =>
  $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] } } as never).catch(() => undefined)

/** A turn of main's that answers `text` in row `uuid`, with no tool call. */
async function turn($: E, w: World, uuid: string, text: string): Promise<void> {
  await $.turn.start({ text: 'What did the label find?', turnId: 't1' } as never)
  await append($, uuid, text)
  await $.turn.complete({ turnId: 't1', answer: text, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
}

test("a link to a label or to a document's passage with no words of its own names it in words, never by its id; a click opens it", async ($, on) => {
  // live check term-fix8, quirk 3: `[↗](concept:eb534ca4)` drew as `concept:eb534ca4`, `[↗](report:report#4255ef27)` as
  // `↗ (report:report#4255ef27)`
  const w = world(on)
  w.resolve = { ...w.resolve, 'report:report#x3': { ref: 'report:report#x3', kind: 'report', excerpt: 'One week of June holds most saves.', meta: { slug: 'report', title: DOC.title, section: 'The main claim', id: 'x3' } }, 'report:report': { ref: 'report:report', kind: 'report', excerpt: DOC.title, meta: { slug: 'report', title: DOC.title } } }
  await start($, w)
  const text = 'The label [↗](concept:d9b51617) counts the proxy links. The report says so [↗](report:report#x3). See the report [↗](report:report). [5191](concept:d9b51617/proxy%20link) link.'
  await turn($, w, 'r1', text)
  let ui = (await $.ui.mount(MESSAGE('r1', text))) as unknown as M
  await w.clock.advance(1100)
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('r1', text))) as unknown as M
  const para = shown(await ui.drawn({ in: 'para-1' }))
  expect(para).not.toMatch(/concept:|report:/)
  const chips = ((await ui.find({ type: 'Client', key: 'para-1' })) as unknown as ChipProps).props.props.chips
  // a label's value with a space, encoded, is a link too (live check term-fix9: `[40](concept:…/mentions%20June)`)
  expect(chips.map(c => c.label)).toEqual(['label "links through a fetch proxy"', '"One week of June holds most saves."', 'report "Agents used the dse wiki as a…"', '5191'])
  expect(chips[3]!.tip).toContain('opens the label at its value "proxy link"')
  expect(para).toContain('The report says so ("One week of June holds most saves.").')
  // a click on the passage's link opens the document at the section that holds it
  const at = para.indexOf('"One week')
  await ui.pointer({ type: 'down', x: at + 2, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.pointer({ type: 'up', x: at + 2, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.unmount()
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const doc = shown(await pane.drawn())
  expect(doc).toContain('Agents used the dse wiki as a relay')
  expect(doc).toContain('The main claim')
  expect(doc).not.toContain('The export per wiki.')
  await pane.unmount()
})

test("a label with no run: its card says `not run yet`, with no bars and no counts, as home does", async ($, on) => {
  // live check term-fix8, quirk 8: the card of the label a stopped thread left showed yes 0, no 0 and all 0
  const w = world(on)
  w.states.labels.push({ id: 'n0run000', name: 'test-or-probe', kind: 'prompt', unit: 'record', labels: ['yes', 'no'], glob: 'events.jsonl', label_stats: { n_labeled: 0, counts: {} }, last_run: null, applications: [] } as never)
  ;(w.cells as Record<string, Record<string, unknown>>).l1norun0 = { ...w.cells.l0label0, id: 'l1norun0', title: 'test-or-probe', labels: ['n0run000'], payload: { concept: 'n0run000' } }
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'card l1norun0' } as never)
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const card = shown(await pane.drawn({ in: 'card-pane-l1norun0' }))
  expect(card).toContain('○ not run yet')
  expect(card).not.toMatch(/yes +0|all +0/)
  expect(card).toContain('test-or-probe')
  await pane.unmount()
})

test("a label whose first run is going (a chat follows it) says `◌ labeling` on its card and on home, not `not run yet`", async ($, on) => {
  const w = world(on)
  w.states.labels.push({ id: 'n0run000', name: 'test-or-probe', kind: 'prompt', unit: 'record', labels: ['yes', 'no'], glob: 'events.jsonl', label_stats: { n_labeled: 0, counts: {} }, last_run: null, applications: [] } as never)
  ;(w.cells as Record<string, Record<string, unknown>>).l1norun0 = { ...w.cells.l0label0, id: 'l1norun0', title: 'test-or-probe', labels: ['n0run000'], payload: { concept: 'n0run000' } }
  w.states.agents = { ...w.states.agents, rows: [...w.states.agents.rows, { name: 'thimble:labels', label: 'label test-or-probe', state: 'running', kind: 'agent', chat: 'lb1', role: 'labels' }] } as never
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'card l1norun0' } as never)
  await w.clock.settle()
  let pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn({ in: 'card-pane-l1norun0' }))).toContain('◌ labeling')
  await pane.unmount()
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  pane = (await $.ui.mount(PANE)) as unknown as M
  const rows = (((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r))
  expect(rows.some(r => /◌ test-or-probe +labeling$/.test(r))).toBe(true)
  expect(rows.some(r => /test-or-probe +not run yet$/.test(r))).toBe(false)
  await pane.unmount()
})

test("a card no drawing read yet (one a thread made) opens with its question on the path, never `card \"Card\"`", async ($, on) => {
  const w = world(on)
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'card k0code00' } as never)
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const text = shown(await pane.drawn())
  expect(text).toMatch(/home › card "How many lines\?"/)
  expect(text).not.toContain('card "Card"')
  expect(w.panes.at(-1)!.title).toBe('How many lines?')
  await pane.unmount()
})

test("a session's first count is what home holds as seen, kept in the workspace; an open of home keeps what it showed", async ($, on) => {
  resetKept()
  const w = world(on)
  await start($, w)
  const kept = () => parseKept(w.files.get(`${WS}/${KEPT_FILE}`) ?? '')
  expect(kept().seen?.cards).toBe(12)
  // two cards arrive, never opened: still 12 seen
  w.states.home = { ...w.states.home, cards: 14 }
  w.stamps.set(`${WS}/notebooks`, 2)
  await w.clock.advance(1100)
  expect(kept().seen?.cards).toBe(12)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  expect(kept().seen?.cards).toBe(14)
})

test('after a relaunch the toast counts what came before the quit and was never opened', async ($, on) => {
  // live check term-fix8, low quirk: no toast for the slides made before the quit and never opened
  resetKept()
  const w = world(on)
  // the earlier session saw 12 cards and the report; two cards and the slides came after, never opened
  w.files.set(`${WS}/${KEPT_FILE}`, JSON.stringify({ rows: {}, last: { reply: '', cards: [] }, seen: { cards: 12, labels: 1, docs: 1, threads: 2, views: 0, files: 4, at: 1_789_999_000_000 } }))
  w.states.home = { ...w.states.home, cards: 14, docs: { ...w.states.home.docs, slides: { exists: true, title: 'The relay in two slides' } } } as never
  await start($, w)
  const above = (await $.ui.mount(ABOVE)) as unknown as M
  expect(shown(await above.drawn())).toContain('2 new cards · 1 new document')
  await above.press({ key: 'above-home-open' })
  await above.unmount()
  await w.clock.settle()
  expect(parseKept(w.files.get(`${WS}/${KEPT_FILE}`) ?? '').seen?.cards).toBe(14)
})

test('a card the card check rewrote says so under its takeaway: which parts, and why', async ($, on) => {
  // live check term-fix8, low quirk: the card check rewrote takeaways with nothing in the chat saying so
  const w = world(on)
  Object.assign(w.cells.ff73e071!, { takeaway: 'The export holds [[4579|card:ff73e071#pages/TOTAL]] pages.', fixes: [{ id: 'fix1', check: 'c1', by: 'check', fields: ['takeaway'], before: { takeaway: 'The 22:00 hour had 89 deletes.' }, after: { takeaway: 'x' }, reason: 'the takeaway named the wrong hour', state: 'applied' }] })
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'card ff73e071' } as never)
  await w.clock.settle()
  await takesKeys($)
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('the card check rewrote its takeaway: the takeaway named the wrong hour')
  await pane.unmount()
})
