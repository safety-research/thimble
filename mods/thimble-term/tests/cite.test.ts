// The citation panel as thimble-term draws it: the cited mark lit on a
// card (a cited row past the drawn rows too), the passage an example's record quotes, a tab before the value, a problem's
// mark and reason, the follow-up field of a citation opened from a side thread. `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { wrapAround } from '../hooks/cite'
import { CWD, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: 'thimble-term', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
const PANE = { plugin: 'thimble-term', component: 'Pane', requestId: 'thimble-term', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 36 }, view: {} } } as never

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

/** A reply with one citation, checked, then a click on it: the citation panel, mounted. */
async function clickCite($: E, w: World, text: string, x: number): Promise<M> {
  let ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  await w.clock.advance(300)
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  await ui.pointer({ type: 'down', x, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.pointer({ type: 'up', x, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.unmount()
  await w.clock.settle()
  return (await $.ui.mount(PANE)) as unknown as M
}

test("a card value's citation draws the card in its border with the cited cell on the selection background", async ($, on) => {
  const w = world(on)
  await start($, w)
  const pane = await clickCite($, w, 'dse has [[3908|card:ff73e071#pages/dse]] pages.', 9)
  const text = shown(await pane.drawn())
  // the `from` row names the place, so the subtitle says `found` alone (live check New 7)
  expect(shown(await pane.find({ key: 'cite-sub' }))).toBe('found')
  expect(text).toContain('card "What does the export hold per wiki?"')
  expect(JSON.stringify(await pane.drawn())).toMatch(/"backgroundColor":"selectionBg"\},"children":\["\s*3,?908\s*"\]/)
  await pane.unmount()
})

test('a cited table row past the rows a card draws takes the place of the last one drawn, lit', async ($, on) => {
  const w = world(on)
  const rows = Array.from({ length: 20 }, (_, i) => [`w${i + 1}`, 100 + i])
  w.cells.t0big000 = { id: 't0big000', notebook: 'g1', kind: 'table', title: 'Pages per wiki', takeaway: '', labels: [], created_by: 'main', status: 'ok', outputs: [{ 'application/vnd.thimble.frame+json': { columns: ['wiki', 'pages'], index: null, label: 'wiki', rows, total: 20, view: { columns: ['pages'] } } }] }
  w.resolve['card:t0big000#pages/w19'] = { ref: 'card:t0big000#pages/w19', kind: 'cell', cell_id: 't0big000', excerpt: 'pages × w19 = 118', meta: { span: { col: 'pages', row: 'w19', value: '118' } } }
  await start($, w)
  const pane = await clickCite($, w, 'w19 has [[118|card:t0big000#pages/w19]] pages.', 9)
  await w.clock.settle()
  await pane.redraw()
  const text = shown(await pane.drawn())
  expect(text).toContain('w19')
  expect(text).not.toContain('w15')
  expect(JSON.stringify(await pane.drawn())).toMatch(/"backgroundColor":"selectionBg"\},"children":\["\s*118\s*"\]/)
  await pane.unmount()
})

test("a citation whose place does not exist: its title red with ×, its status and reason in red", async ($, on) => {
  const w = world(on)
  await start($, w)
  const pane = await clickCite($, w, 'It has [12](README.md#L99) wikis.', 8)
  const json = JSON.stringify(await pane.drawn({ in: 'cite-title' }))
  expect(json).toContain('{"type":"Text","props":{"color":"error"},"children":[" ×"]}')
  expect(shown(await pane.drawn())).toContain('not found: README.md line 99 does not exist · the place does not resolve: line 99 out of range')
  await pane.unmount()
})

test('a value after a tab is lit where it stands', async ($, on) => {
  const w = world(on)
  w.resolve['data.tsv#L2'] = { ref: 'data.tsv#L2', kind: 'record', path: 'data.tsv', line: 2, blocks: [{ text: 'dse\t3908\tpages' }], excerpt: 'dse\t3908\tpages' }
  await start($, w)
  const pane = await clickCite($, w, 'dse has [3908](data.tsv#L2) pages.', 9)
  expect(JSON.stringify(await pane.drawn())).toContain('{"type":"Text","props":{"backgroundColor":"selectionBg"},"children":["3908"]}')
  await pane.unmount()
})

test("a click on an example's record opens its place with the passage the card quotes lit, or a `quoted` row when the lines do not hold it", async ($, on) => {
  const w = world(on)
  w.cells.x0quot00 = { id: 'x0quot00', notebook: 'g1', kind: 'example', title: 'What does the README say?', takeaway: '', labels: [], created_by: 'main', payload: { refs: [{ ref: 'README.md#L3', quote: '4,579 wiki pages' }, { ref: 'README.md#L5', quote: 'not in the line' }] } }
  await start($, w)
  w.toolText = 'card:x0quot00\n[out0: example]'
  await $.turn.start({ text: 'What?', turnId: 't1' } as never)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'r1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Here.' }] } } as never).catch(() => undefined)
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u1' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Here.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
  const open = async (k: number) => {
    const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
    const key = 'card-t0-x0quot00'
    await ui.resize({ columns: 100, rows: 20, in: key })
    const lines = ((await ui.drawn({ in: key })) as { children?: unknown[] }).children ?? []
    const ys = lines.flatMap((l, y) => (/README\.md line [35]/.test(shown(l)) ? [y] : []))
    await ui.pointer({ type: 'down', x: 2, y: ys[k]!, button: 'left', in: key } as never)
    await ui.pointer({ type: 'up', x: 2, y: ys[k]!, button: 'left', in: key } as never)
    await ui.unmount()
    await w.clock.settle()
    return (await $.ui.mount(PANE)) as unknown as M
  }
  let pane = await open(0)
  expect(JSON.stringify(await pane.drawn())).toContain('{"type":"Text","props":{"backgroundColor":"selectionBg"},"children":["4,579 wiki pages"]}')
  await pane.unmount()
  pane = await open(1)
  const text = shown(await pane.drawn())
  expect(text).toContain('quoted')
  expect(JSON.stringify(await pane.drawn())).toContain('"backgroundColor":"selectionBg"},"children":["not in the line"]')
  await pane.unmount()
})

test("a citation opened from a side thread has a `follow-up` field: its question goes on in that thread, and the panel returns to it", async ($, on) => {
  const w = world(on)
  w.resolve['card:a0frame0#records/events.jsonl'] = { ref: 'card:a0frame0#records/events.jsonl', kind: 'cell', cell_id: 'a0frame0', excerpt: 'records × events.jsonl = 19913', meta: { span: { col: 'records', row: 'events.jsonl', value: '19913' } } }
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  let pane = (await $.ui.mount(PANE)) as unknown as M
  const rows = ((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []
  await pane.pointer({ type: 'down', x: 4, y: rows.findIndex(r => shown(r).includes('why is events.jsonl bigger?')), button: 'left', in: 'm:home' } as never)
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  // the thread's answer cites a card's value: a click on it, from inside the panel
  const para = (await pane.findAll({ type: 'Client' })).map(c => String((c as { key?: string }).key)).find(k => k.startsWith('para-t1-'))!
  await pane.pointer({ type: 'down', x: 10, y: 0, button: 'left', in: para } as never)
  await pane.pointer({ type: 'up', x: 10, y: 0, button: 'left', in: para } as never)
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('follow-up')
  await pane.input({ key: (((await pane.findAll({ type: 'Input' })) as { key?: string }[]).find(i => String(i.key).startsWith('follow-'))!.key)!, text: 'Why so many?' })
  await w.clock.settle()
  expect(w.acts).toContainEqual({ kind: 'thread-message', payload: { thread: 't1', message: 'Why so many? (about [[19913|card:a0frame0#records/events.jsonl]])' } })
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('Threads')
  await pane.unmount()
})

test("a takeaway's citation opens a panel that agrees with the chat: ✓ after its title, and `a script got the same number`", async ($, on) => {
  const w = world(on)
  Object.assign(w.cells.ff73e071!, { verification: { status: 'ok', links: { status: 'ok', checked: true, resolved: [{ value: '4579', ref: 'card:ff73e071#pages/TOTAL' }], broken: [] } } })
  await start($, w)
  w.toolText = 'card:ff73e071\n[out0: table]'
  await $.turn.start({ text: 'How big?', turnId: 't1' } as never)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'r1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Here.' }] } } as never).catch(() => undefined)
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u1' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Here.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  // the takeaway: `The export holds 4579 ✓ pages …`, the value at column 17
  await ui.pointer({ type: 'down', x: 18, y: 0, button: 'left', in: 'para-tk-t0-1' } as never)
  await ui.pointer({ type: 'up', x: 18, y: 0, button: 'left', in: 'para-tk-t0-1' } as never)
  await ui.unmount()
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const tree = await pane.drawn()
  // the title (a link, drawn in a Client): the value, then ✓ in the text color
  expect(JSON.stringify(tree)).toContain('{"s":"4579","b":true,"fg":"remember","u":true},{"s":" ✓"}')
  expect(shown(await pane.find({ key: 'cite-sub' }))).toBe('found, and a script got the same number')
  await pane.unmount()
})

test('a file citation written without words names its place once: no `from` row, and its label marked in the sentence', async ($, on) => {
  const w = world(on)
  await start($, w)
  const pane = await clickCite($, w, 'See [[README.md#L5]] for the format.', 5)
  const tree = await pane.drawn()
  const text = shown(tree)
  // the title, in its Client, is the place in words; the path row has the short place the reply draws (live check New 3)
  expect(JSON.stringify(await pane.find({ type: 'Client', key: 'cite-title' }))).toContain('"s":"README.md line 5"')
  expect(shown(await pane.find({ type: 'Box', key: 'way' }))).toContain('citation README:5')
  expect(text).not.toContain('from')
  expect(JSON.stringify(tree)).toMatch(/"See [^"]*"[^]*"README:5"/)
  expect(text).toContain('"See README:5 for the format."')
  // the title is the place: no subtitle names it again (`found in README.md line 5`), and none while it is there
  expect(text).not.toContain('found in')
  expect(await pane.find({ key: 'cite-sub' })).toBeUndefined()
  await pane.unmount()
})

test('a citation written without words whose place does not exist says `not found` under its title, without its place again', async ($, on) => {
  const w = world(on)
  await start($, w)
  const pane = await clickCite($, w, 'See [[README.md#L99]] for the format.', 5)
  const sub = shown(await pane.find({ key: 'cite-sub' }))
  expect(sub).toBe('not found · the place does not resolve: line 99 out of range (README.md has 20 lines)')
  await pane.unmount()
})

test('a cited line too long for the panel wraps at its spaces, never inside a word, its value still lit; a context line cut short has `…` against its words', async ($, on) => {
  const words = 'The agent chat says that 3,898 pages were removed in under an hour on 16 June, which no record of the event log shows anywhere at all, and the chat itself never says where the number came from in the first place, so it stands alone.'
  const rows = wrapAround(words, [words.indexOf('3,898'), words.indexOf('3,898') + 5], 40, 8)
  // no row starts or ends inside a word, and the rows put back together are the words
  for (const r of rows) expect(words).toContain(r.text)
  expect(rows.map(r => r.text).join(' ')).toBe(words)
  expect(rows.every(r => r.text.length <= 40)).toBe(true)
  const lit = rows.find(r => r.hi)!
  expect(lit.text.slice(lit.hi![0], lit.hi![1])).toBe('3,898')
  // fewer rows than it needs: the rows around the value, `…` against the words at each cut end
  const few = wrapAround(words, [words.indexOf('event log'), words.indexOf('event log') + 9], 40, 3)
  expect(few[0]!.text.startsWith('…') && !few[0]!.text.startsWith('… ')).toBe(true)
  expect(few.at(-1)!.text.endsWith('…') && !few.at(-1)!.text.endsWith(' …')).toBe(true)
  const hit = few.find(r => r.hi)!
  expect(hit.text.slice(hit.hi![0], hit.hi![1])).toBe('event log')
  // a word wider than the row breaks where the row ends
  expect(wrapAround('x'.repeat(50), null, 20, 4).map(r => r.text.length)).toEqual([20, 20, 10])
})

test("a context line wider than the panel is cut with `…` right against its words, never after a space", async ($, on) => {
  const w = world(on)
  // two context lines, a space at every other cell, one a cell later than the other: one of them has a space where it is cut
  w.resolve['README.md#L3'] = { ref: 'README.md#L3', kind: 'record', path: 'README.md', line: 3, blocks: [{ text: 'An export of 4,579 wiki pages and their revisions.' }], excerpt: 'An export of 4,579 wiki pages and their revisions.', context: { before: [{ line: 1, blocks: [{ text: 'a '.repeat(100) }] }, { line: 2, blocks: [{ text: ' a'.repeat(100) }] }], after: [] } }
  await start($, w)
  const pane = await clickCite($, w, 'It has [4,579](README.md#L3) pages.', 8)
  const box = (await pane.find({ type: 'Box', key: 'cite-lines' })) as unknown as { children?: unknown[] }
  const context = (box.children ?? []).map(r => shown(r)).filter(r => /^\s*[12]\s/.test(r))
  expect(context.length).toBe(2)
  for (const r of context) {
    expect(r).toMatch(/a…$/)
    expect(r).not.toContain(' …')
  }
  await pane.unmount()
})

test("a citation of lines a card printed is named `card \"…\" output line N`, and its panel draws those lines, the cited one lit, never the card's table", async ($, on) => {
  // live check term-fix5, new quirk 4: `card L1`, and the panel drew the card's table, which did not show the value
  const w = world(on)
  w.resolve['card:ff73e071@out0#L2'] = { ref: 'card:ff73e071@out0#L2', kind: 'cell', cell_id: 'ff73e071', excerpt: 'file records\nrevisions.jsonl 14591\nevents.jsonl 19913\npages.jsonl 4579', meta: { span: { out: 0, line: 2, text: 'revisions.jsonl 14591' } } }
  await start($, w)
  const pane = await clickCite($, w, 'It is the [[14591|card:ff73e071@out0#L2]] revisions.', 11)
  const drawn = await pane.drawn()
  const text = shown(drawn)
  expect(text).toContain('card "What does the export hold per wiki?" output line 2')
  expect(text).toMatch(/2\s+revisions\.jsonl 14591/)
  expect(text).toMatch(/1\s+file records/)
  expect(text).not.toContain('╭')
  // the value on the selection background where it stands in the line
  expect(JSON.stringify(drawn)).toMatch(/"backgroundColor":"[^"]+"\},"children":\["14591"\]/)
  await pane.unmount()
})

test("a label's link in a reply (`[33](concept:<id>/<value>)`) is a blue link, never `33 (concept:…)`, checked by nothing, and opens the label at the value", async ($, on) => {
  // live check term-fix5, new quirk 2
  const w = world(on)
  await start($, w)
  const text = 'The rule gives [5,191](concept:d9b51617/proxy-link) records.'
  let ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  await w.clock.advance(300)
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  // drawn by thimble-term as a paragraph with one link, not handed to Claude Code's Markdown (`5,191 (concept:…)`)
  expect(JSON.stringify(await ui.drawn())).not.toContain('(concept:')
  const chips = ((await ui.find({ type: 'Client', key: 'para-1' })) as unknown as { props: { props: { chips: { label: string; state: string; tip: string }[] } } }).props.props.chips
  expect(chips[0]).toMatchObject({ label: '5,191', state: 'link', tip: 'opens the label at its value "proxy-link"' })
  await ui.pointer({ type: 'down', x: 15, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.pointer({ type: 'up', x: 15, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.unmount()
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const panel = await pane.drawn()
  const words = shown(panel)
  expect(words).toContain('links through a fetch proxy')
  expect(words).toContain('▾ counts')
  expect(words).toContain('▾ examples')
  expect(JSON.stringify(panel)).toMatch(/"backgroundColor":"[^"]+"\},"children":\["proxy-link"\]/)
  await pane.unmount()
})
