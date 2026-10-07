// The citation panel as thimble-term draws it, the parts ported from thimble-cc-mod's round 8: the cited mark lit on a
// card (a cited row past the drawn rows too), the passage an example's record quotes, a tab before the value, a problem's
// mark and reason, the follow-up field of a citation opened from a side thread. `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

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
  expect(text).toContain('found on the card')
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
