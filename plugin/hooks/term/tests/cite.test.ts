// The citation panel as thimble-term draws it: the cited mark lit on a
// card (a cited row past the drawn rows too), the passage an example's record quotes, a tab before the value, a problem's
// mark and reason, the follow-up field of a citation opened from a side thread. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { wrapAround } from '../cite'
import { CITED_BG, CWD, DOC, WS, citedText, shown, world } from './fixtures'
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

test("a card value's citation opens the card's data row and code that hold it, the value on the citation's purple, never the plot", async ($, on) => {
  // v9 review (i): "a citation of a number on a card opens the code or data holding the literal, not the plot"
  const w = world(on)
  await start($, w)
  const pane = await clickCite($, w, 'dse has [[3908|card:ff73e071#pages/dse]] pages.', 9)
  const tree = await pane.drawn()
  const text = shown(tree)
  // the `from` row names the place, so the subtitle says `found` alone (live check New 7)
  expect(shown(await pane.find({ key: 'cite-sub' }))).toBe('found')
  expect(text).toContain('card "What does the export hold per wiki?"')
  expect(text).toContain("howthe card's code computed it, and thimble found it in the card's output")
  // the data row: the column names, then the cited row, its value on the citation's purple
  expect(shown(await pane.find({ key: 'cite-data-0' }))).toBe('wiki  pages  revisions')
  expect(shown(await pane.find({ key: 'cite-data-2' }))).toBe('dse    3908      13403')
  expect(JSON.stringify(await pane.find({ key: 'cite-data-2' }))).toMatch(new RegExp(`"backgroundColor":"${CITED_BG}"\\},"children":\\[" 3908"\\]`))
  // the card's code, numbered; no frame, so no plot
  expect(shown(await pane.find({ key: 'cite-code-0' }))).toBe("1  pages = pd.read_json('pages.jsonl', lines=True)")
  expect(text).not.toContain('╭')
  expect(shown(await pane.find({ key: 'h-hints' }))).toContain('c for the card')
  await pane.unmount()
})

test("a card value its code types in: the literal lit on the citation's purple in the code, and the links check says so", async ($, on) => {
  const w = world(on)
  Object.assign(w.cells.ff73e071!, {
    code: "import pandas as pd\n# the counts as the README gives them\ncounts = {'dse': 3908, 'probier': 601}\ndf = pd.DataFrame(counts.items())\ndf",
    takeaway: 'dse has [[3908|card:ff73e071#pages/dse]] pages.',
    verification: { status: 'ok', links: { status: 'ok', checked: true, resolved: [], broken: [], typed: [{ value: '3908', ref: 'card:ff73e071#pages/dse', why: 'typed in the code, line 3, not computed' }] } },
  })
  await start($, w)
  w.toolText = 'card:ff73e071\n[out0: table]'
  await $.turn.start({ text: 'How big?', turnId: 't1' } as never)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'r1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Here.' }] } } as never).catch(() => undefined)
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u1' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Here.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  // the takeaway: `dse has 3908 pages.`, the value at column 8
  await ui.pointer({ type: 'down', x: 9, y: 0, button: 'left', in: 'para-tk-t0-1' } as never)
  await ui.pointer({ type: 'up', x: 9, y: 0, button: 'left', in: 'para-tk-t0-1' } as never)
  await ui.unmount()
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const text = shown(await pane.drawn())
  expect(text).toContain("howthe card's code types it in rather than computes it")
  // the code's line that types it, numbered, the literal on the citation's purple
  expect(shown(await pane.find({ key: 'cite-code-2' }))).toBe("3  counts = {'dse': 3908, 'probier': 601}")
  expect(JSON.stringify(await pane.find({ key: 'cite-code-2' }))).toMatch(citedText('3908'))
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
  expect(JSON.stringify(await pane.drawn())).toMatch(new RegExp(`"backgroundColor":"${CITED_BG}"\\},"children":\\["\\s*118\\s*"\\]`))
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
  w.pages['data.tsv'] = { path: 'data.tsv', kind: 'text', total_lines: 2, start: 1, records: [{ line: 1, record: { text: 'wiki\tpages' } }, { line: 2, record: { text: 'dse\t3908\tpages' } }] }
  await start($, w)
  const pane = await clickCite($, w, 'dse has [3908](data.tsv#L2) pages.', 9)
  expect(JSON.stringify(await pane.drawn({ in: 'm:cite-lines' }))).toMatch(citedText('3908'))
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
  expect(JSON.stringify(await pane.drawn({ in: 'm:cite-lines' }))).toMatch(citedText('4,579 wiki pages'))
  await pane.unmount()
  pane = await open(1)
  const text = shown(await pane.drawn())
  expect(text).toContain('quoted')
  expect(JSON.stringify(await pane.drawn())).toMatch(new RegExp(`"backgroundColor":"${CITED_BG}"\\},"children":\\["not in the line"\\]`))
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
  expect(shown(await pane.drawn())).toContain('home › threads › "why is events.jsonl bigger?"')
  await pane.unmount()
})

test("a takeaway's citation opens a panel that agrees with the chat: no mark after its purple title (never ✓), and `a script got the same number`", async ($, on) => {
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
  // the takeaway: `The export holds 4579 pages …`, the value at column 17
  await ui.pointer({ type: 'down', x: 18, y: 0, button: 'left', in: 'para-tk-t0-1' } as never)
  await ui.pointer({ type: 'up', x: 18, y: 0, button: 'left', in: 'para-tk-t0-1' } as never)
  await ui.unmount()
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  const tree = await pane.drawn()
  // the title (a link, drawn in a Client): the value, purple and underlined, and no mark after it
  expect(JSON.stringify(tree)).toContain('{"s":"4579","b":true,"fg":"merged","u":true}')
  expect(JSON.stringify(tree)).not.toContain('✓')
  expect(shown(await pane.find({ key: 'cite-sub' }))).toBe('found, and a script got the same number')
  await pane.unmount()
})

/** A turn of main that made card ff73e071, then a click on its takeaway at column `x`: the citation panel, mounted. */
async function clickTakeaway($: E, w: World, x: number): Promise<M> {
  w.toolText = 'card:ff73e071\n[out0: table]'
  await $.turn.start({ text: 'How big?', turnId: 't1' } as never)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'r1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Here.' }] } } as never).catch(() => undefined)
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u1' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Here.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  await ui.pointer({ type: 'down', x, y: 0, button: 'left', in: 'para-tk-t0-1' } as never)
  await ui.pointer({ type: 'up', x, y: 0, button: 'left', in: 'para-tk-t0-1' } as never)
  await ui.unmount()
  await w.clock.settle()
  return (await $.ui.mount(PANE)) as unknown as M
}

test("a click on a citation still being verified opens a panel that says so, its ◌ part of the title, and that changes when the check ends", async ($, on) => {
  // v9 review (g): "clicking a citation still being verified: the panel shows that it is being verified"
  const w = world(on)
  Object.assign(w.cells.ff73e071!, { verification: { status: 'checking', links: { status: 'pending', checked: false, resolved: [], broken: [] } } })
  await start($, w)
  // the takeaway: `The export holds 4579 pages …`, the value at column 17
  let pane = await clickTakeaway($, w, 18)
  let tree = await pane.drawn()
  expect(JSON.stringify(tree)).toContain('{"s":"4579","b":true,"fg":"merged","u":true},{"s":" ◌","b":true,"fg":"merged","u":true}')
  expect(shown(await pane.find({ key: 'cite-sub' }))).toBe('found; ◌ being verified')
  expect(shown(tree)).toContain("the card's code computed it, and thimble found it in the card's output; ◌ its card's links check is running")
  await pane.unmount()
  // the check ends: the card is read again, and the panel says what it found, with no ◌
  Object.assign(w.cells.ff73e071!, { verification: { status: 'ok', links: { status: 'ok', checked: true, resolved: [{ value: '4579', ref: 'card:ff73e071#pages/TOTAL' }], broken: [] } } })
  w.stamps.set(`${WS}/notebooks`, 2)
  await w.clock.advance(1100)
  await w.clock.settle()
  pane = (await $.ui.mount(PANE)) as unknown as M
  tree = await pane.drawn()
  expect(shown(await pane.find({ key: 'cite-sub' }))).toBe('found, and a script got the same number')
  expect(shown(tree)).toContain("and its card's links check found the same value")
  expect(JSON.stringify(tree)).not.toContain('◌')
  await pane.unmount()
})

test("a file citation says how thimble verified it, its history, and asks a side thread for a script where no code verified it", async ($, on) => {
  const w = world(on)
  await start($, w)
  let pane = await clickCite($, w, 'It has [4,579](README.md#L3) pages.', 8)
  const text = shown(await pane.drawn())
  expect(text).toContain('howthimble read the cited line and found the value there; no script recomputed it')
  expect(text).toContain('historyunchanged since Claude wrote it')
  await pane.press({ key: 'cite-script' })
  await w.clock.settle()
  // a side thread about the citation, asked for the script that recomputes the value
  expect(w.acts.find(a => a.kind === 'thread')?.payload).toMatchObject({
    anchor: 'README.md#L3',
    anchor_text: 'It has 4,579 pages.',
    message: 'Write and run a short script that recomputes 4,579 from the raw files. Show the script and what it printed, and say whether it agrees with the citation.',
  })
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  // the panel shows the thread, its question its step
  expect(shown(await pane.find({ type: 'Box', key: 'way' }))).toContain('threads › "Write and run a short script that recomputes 4,579')
  await pane.unmount()
})

test("a citation a side thread wrote a script for shows that script under `script`, and no longer asks for one", async ($, on) => {
  const w = world(on)
  const question = 'Write and run a short script that recomputes 4,579 from the raw files. Show the script and what it printed, and say whether it agrees with the citation.'
  const meta = { id: 't9', kind: 'thread', role: 'thread', title: '"4,579"', anchor: 'README.md#L3', anchor_text: 'It has 4,579 pages.', question, parent: 'main', created_at: '2026-10-06T10:07:00+00:00', running: false, answers: 1, seen: 1 }
  w.states.threads.push(meta as never)
  w.chats.t9 = { meta, events: [{ type: 'user', text: question }, { type: 'text', delta: 'The script:\n\n```python\nn = sum(1 for _ in open("pages.jsonl"))\nprint(f"RESULT: {n:,}")\n```\n\nIt printed `RESULT: 4,579`, which agrees.', reply: true }, { type: 'done', result: 'answered' }] }
  await start($, w)
  const pane = await clickCite($, w, 'It has [4,579](README.md#L3) pages.', 8)
  await w.clock.settle()
  await pane.redraw()
  const text = shown(await pane.drawn())
  expect(text).toContain("scripta side thread's script")
  expect(text).toContain('1  n = sum(1 for _ in open("pages.jsonl"))')
  expect(text).toContain('2  print(f"RESULT: {n:,}")')
  expect(text).not.toContain('ask for a script')
  expect(text).not.toContain('no script recomputed it')
  await pane.unmount()
})

test("a citation of a command's output names the command that printed it", async ($, on) => {
  const w = world(on)
  w.resolve['call:c0wc0001#L1'] = { ref: 'call:c0wc0001#L1', kind: 'call', excerpt: '14591 revisions.jsonl', meta: { name: 'Bash', line: 'wc -l revisions.jsonl', lines: 1, span: { line: 1, end_line: 1, text: '14591 revisions.jsonl' } } }
  await start($, w)
  const pane = await clickCite($, w, 'It has [[14591|call:c0wc0001#L1]] revisions.', 8)
  const text = shown(await pane.drawn())
  expect(text).toContain('howthe command printed it, and thimble found it in its output')
  expect(text).toContain('command$ wc -l revisions.jsonl')
  expect(text).not.toContain('ask for a script')
  await pane.unmount()
})

test('a file citation written without words names its place once: no `from` row, and its label marked in the sentence', async ($, on) => {
  const w = world(on)
  await start($, w)
  const pane = await clickCite($, w, 'See [[README.md#L5]] for the format.', 5)
  const tree = await pane.drawn()
  const text = shown(tree)
  // the title, in its Client, is the place in words, the title row's current step after `citation` (live check New 3)
  expect(JSON.stringify(await pane.find({ type: 'Client', key: 'cite-title' }))).toContain('"s":"README.md line 5"')
  expect(shown(await pane.find({ type: 'Box', key: 'way' }))).toContain('home › citation ')
  expect(JSON.stringify(await pane.find({ type: 'Box', key: 'way' }))).toContain('"key":"cite-title"')
  expect(text).not.toContain('from')
  // the sentence holds the chip, marked in the link color (Matt, 2026-10-07)
  expect(JSON.stringify(tree)).toMatch(/"See [^"]*"[^]*"\[ README\.md line 5 \]"/)
  expect(text).toContain('"See [ README.md line 5 ] for the format."')
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
  const box = (await pane.drawn({ in: 'm:cite-lines' })) as unknown as { children?: unknown[] }
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

// ------------------------------------------------------------------------------------------------ a file citation's window

/** A file of 900 lines, paged as thimble pages it: 200 lines from the line `--start` names. */
const LOG = (start: number) => ({ path: 'log.txt', kind: 'text', total_lines: 900, start, records: Array.from({ length: Math.max(0, Math.min(200, 901 - start)) }, (_, i) => ({ line: start + i, record: { text: `line ${start + i} of the log` } })) })
const logLine = (n: number) => ({ line: n, record: { text: `line ${n} of the log` } })
const LOG_450 = { ref: 'log.txt#L450', kind: 'record', path: 'log.txt', line: 450, record: { text: 'line 450 of the log' }, blocks: [{ text: 'line 450 of the log' }], excerpt: 'line 450 of the log', context: { before: [447, 448, 449].map(logLine), after: [451, 452, 453].map(logLine) } }

/** The rows of a file citation's window as drawn, and its drawing. */
async function windowRows(pane: M): Promise<{ rows: string[]; json: string }> {
  const tree = await pane.drawn({ in: 'm:cite-lines' })
  return { rows: (((tree as { children?: unknown[] }).children ?? []) as unknown[]).map(r => shown(r)), json: JSON.stringify(tree) }
}

/** A click on `words` where a Client of the drawing shows them. */
async function clickWords(ui: M, key: string, words: string): Promise<void> {
  const rows = (((await ui.drawn({ in: key })) as { children?: unknown[] }).children ?? []).map(r => shown(r))
  const y = rows.findIndex(r => r.includes(words))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = rows[y]!.indexOf(words) + 1
  await ui.pointer({ type: 'down', x, y, button: 'left', in: key } as never)
  await ui.pointer({ type: 'up', x, y, button: 'left', in: key } as never)
}

test("a file citation opens on its whole file: the cited line lit whole for a place cited without words, the lines around it dim, the file's lines above and below counted, as tall as the panel leaves it", async ($, on) => {
  // Matt, 2026-10-07: "when you open a raw file, you can't see beyond the few lines it picks and the part it cited isn't
  // highlighted"
  const w = world(on)
  w.pages['log.txt'] = LOG
  w.resolve['log.txt#L450'] = LOG_450
  await start($, w)
  const pane = await clickCite($, w, 'See [[log.txt#L450]] for the restart.', 5)
  const { rows, json } = await windowRows(pane)
  // the panel's 36 rows less the title row, the rule, the source, how and history rows, the second rule, `ask about
  // it` and the hint row
  expect(rows.length).toBe(36 - 8)
  const nums = rows.map(r => Number(/^\s+(\d+)\s{2}line/.exec(r)?.[1] ?? 0))
  const firstShown = nums.find(n => n > 0)!
  const lastShown = [...nums].reverse().find(n => n > 0)!
  expect(rows[0]!.trim()).toBe(`↑ ${firstShown - 1} more`)
  expect(rows.at(-1)!.trim()).toBe(`↓ ${900 - lastShown} more`)
  // every line between them, in order; the cited one a third of the way down, with lines above it
  expect(nums.filter(n => n > 0)).toEqual(Array.from({ length: lastShown - firstShown + 1 }, (_, i) => firstShown + i))
  const at = nums.indexOf(450)
  expect(at).toBeGreaterThan(3)
  expect(at).toBeLessThan(rows.length / 2)
  // the cited line lit whole (it names no value), its number in the text colour; the lines around it dim
  expect(json).toMatch(citedText('line 450 of the log'))
  expect(json).toMatch(/"color":"inactive"\},"children":\["\s*449 {2}line 449 of the log"\]/)
  expect(json).toMatch(/"color":"inactive"\},"children":\["\s*460 {2}line 460 of the log"\]/)
  await pane.unmount()
})

test('a value cited in a file is lit where it stands, not its whole line; the page read is the one that holds the cited line, not the file\'s first', async ($, on) => {
  const w = world(on)
  w.pages['log.txt'] = LOG
  w.resolve['log.txt#L450'] = LOG_450
  await start($, w)
  const pane = await clickCite($, w, 'It names [line 450](log.txt#L450) once.', 10)
  const { json } = await windowRows(pane)
  expect(json).toMatch(citedText('line 450'))
  expect(json).not.toContain('"children":["line 450 of the log"]}')
  // the page that holds the cited line's lines was read from its start (term.ts citePage), never the file's first page
  const reads = w.calls.filter(c => c[2] === 'files' && c[5] === 'log.txt').map(c => c.slice(6).join(' '))
  expect(reads).toContain('--start 401')
  expect(reads).not.toContain('')
  await pane.unmount()
})

test('every file citation opens in the window over its file: from a reply, a card\'s takeaway and a document', async ($, on) => {
  const w = world(on)
  w.pages['log.txt'] = LOG
  w.resolve['log.txt#L450'] = LOG_450
  w.cells.ff73e071!.takeaway = 'The log names [line 450](log.txt#L450) once.'
  w.docs.report = { ...DOC, sections: [{ id: 's1', heading: 'The data', paragraphs: [{ id: 'p1', sentences: [{ id: 'x1', text: 'The log names [line 450](log.txt#L450) once.' }] }], figures: [] }] }
  await start($, w)
  const lit = async () => {
    const pane = (await $.ui.mount(PANE)) as unknown as M
    const { rows, json } = await windowRows(pane)
    expect(rows.some(r => /^\s+450 {2}line 450 of the log$/.test(r))).toBe(true)
    expect(rows.at(-1)).toMatch(/↓ \d+ more$/)
    expect(json).toMatch(citedText('line 450'))
    await pane.unmount()
  }
  // a reply
  await (await clickCite($, w, 'The log names [line 450](log.txt#L450) once.', 15)).unmount()
  await lit()
  // a card's takeaway
  w.toolText = 'card:ff73e071\n[out0: table]'
  await $.turn.start({ text: 'How big?', turnId: 't1' } as never)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'r1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Here.' }] } } as never).catch(() => undefined)
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u1' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Here.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  await clickWords(ui, 'para-tk-t0-1', 'line 450')
  await ui.unmount()
  await w.clock.settle()
  await lit()
  // a document
  await $.command.run({ command: 'thimble:thimble', args: 'documents' } as never)
  await w.clock.settle()
  let pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'doc-open-0' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  const para = (await pane.findAll({ type: 'Client' })).map(c => String((c as { key?: string }).key)).find(k => k.startsWith('para-'))!
  await clickWords(pane, para, 'line 450')
  await w.clock.settle()
  await pane.unmount()
  await lit()
})
