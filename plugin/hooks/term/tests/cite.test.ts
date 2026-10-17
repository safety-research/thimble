// The citation panel as thimble-term draws it (mockup panels.png, panel C): where the citation stands (`from the card`
// or `source`), the value lit where it stands in a file, a card's data row and code, a command's output; one bar whose
// state word opens how it was verified (`◌ checking …` while it is, `failed ×` red with why), a side thread's script; a
// clock time checked as a value. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { firstCode, literalAt } from '../cite'
import { UNFOCUSED_HINT } from '../panel'
import { CITED_BG, CWD, WS, citedText, shown, world } from './fixtures'
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

/** The panel after a press on one of its bar's parts (`cite-state`, `cite-history`), mounted again. */
async function pressBar($: E, w: World, pane: M, key: string): Promise<M> {
  await pane.press({ key })
  await w.clock.settle()
  await pane.unmount()
  return (await $.ui.mount(PANE)) as unknown as M
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

test("a card value's citation opens the card's data row and code that hold it, the value on the citation's purple, never the plot", { timeoutMs: 30_000 }, async ($, on) => {
  // v9 review (i): "a citation of a number on a card opens the code or data holding the literal, not the plot"
  const w = world(on)
  await start($, w)
  let pane = await clickCite($, w, 'dse has [[3908|card:ff73e071#pages/dse]] pages.', 9)
  const tree = await pane.drawn()
  const text = shown(tree)
  // its place a link in the citation's purple; its state in the bar under it, nothing under the title
  expect(shown(await pane.drawn({ in: 'cite-place' }))).toBe('↗ card "What does the export hold per wiki?"')
  expect(JSON.stringify(await pane.find({ type: 'Client', key: 'cite-place' }))).toContain('"fg":"merged","u":true')
  expect(await pane.find({ key: 'cite-sub' })).toBeUndefined()
  expect(shown(await pane.find({ key: 'cite-bar' }))).toBe('checked ›history 0')
  // the data row: the column names, then the cited row, its value on the citation's purple
  expect(shown(await pane.find({ key: 'cite-data-0' }))).toBe('wiki  pages  revisions')
  expect(shown(await pane.find({ key: 'cite-data-2' }))).toBe('dse    3908      13403')
  expect(JSON.stringify(await pane.find({ key: 'cite-data-2' }))).toMatch(new RegExp(`"backgroundColor":"${CITED_BG}"\\},"children":\\[" 3908"\\]`))
  // the card's code, numbered; no frame, so no plot
  expect(shown(await pane.find({ key: 'cite-code-0' }))).toBe("1  pages = pd.read_json('pages.jsonl', lines=True)")
  expect(text).not.toContain('╭')
  expect(shown(await pane.find({ key: 'h-hints' }))).toContain('c for the card')
  // `checked` opens how it was verified above the bar; the data and code rows stay
  pane = await pressBar($, w, pane, 'cite-state')
  expect(shown(await pane.find({ key: 'cite-how' }))).toBe("the card's code computed it, and thimble found it in the card's output")
  expect(shown(await pane.find({ key: 'cite-bar' }))).toBe('checked ⌄history 0')
  expect(shown(await pane.find({ key: 'cite-data-2' }))).toBe('dse    3908      13403')
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
  let pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.find({ key: 'cite-bar' }))).toBe('failed × ›history 0')
  pane = await pressBar($, w, pane, 'cite-state')
  expect(shown(await pane.find({ key: 'cite-how' }))).toBe("the card's code types it in rather than computes it")
  expect(shown(await pane.find({ key: 'cite-why' }))).toBe('typed in the code, line 3, not computed')
  // the code's line that types it, numbered, the literal on the citation's purple
  expect(shown(await pane.find({ key: 'cite-code-2' }))).toBe("3  counts = {'dse': 3908, 'probier': 601}")
  expect(JSON.stringify(await pane.find({ key: 'cite-code-2' }))).toMatch(citedText('3908'))
  await pane.unmount()
})

test("a citation whose place does not exist: its title red, `failed ×` red in the bar, and a press on it says why", async ($, on) => {
  const w = world(on)
  await start($, w)
  let pane = await clickCite($, w, 'It has [12](README.md#L99) wikis.', 8)
  const json = JSON.stringify(await pane.find({ type: 'Client', key: 'cite-title' }))
  expect(json).toContain('"s":"12","b":true,"fg":"error"}')
  // no mark after the title: the bar says its state (MATT-NOTES "Mockup feedback", panel C)
  expect(json).not.toContain('×')
  const bar = await pane.find({ key: 'cite-bar' })
  expect(shown(bar)).toBe('failed × ›history 0')
  expect(JSON.stringify(bar)).toContain('{"type":"Text","props":{"color":"error","underline":true},"children":["failed"]}')
  pane = await pressBar($, w, pane, 'cite-state')
  expect(shown(await pane.find({ key: 'cite-how' }))).toBe('thimble looked for its place and found none')
  expect(shown(await pane.find({ key: 'cite-why' }))).toBe('the place does not resolve: line 99 out of range (README.md has 20 lines)')
  await pane.unmount()
})

test("a time is checked as a value: lit where its line writes it, `checked`, and how says the value was found; words with no value say only their place is checked", async ($, on) => {
  // MATT-NOTES "Mockup feedback": a time like 14:52:11 read "its value is not checked, and a script got the same
  // number" in the chat and "only its place is checked" in its panel: one state
  const w = world(on)
  const line = '{"id": 197, "ts": "2026-08-30T14:52:11.325+00:00", "agent": "agent-07", "action": "git.ref"}'
  w.resolve['events.log#L2'] = { ref: 'events.log#L2', kind: 'record', path: 'events.log', line: 2, blocks: [{ text: line }], excerpt: line }
  w.pages['events.log'] = { path: 'events.log', kind: 'text', total_lines: 2, start: 1, records: [{ line: 1, record: { text: 'start' } }, { line: 2, record: { text: line } }] }
  await start($, w)
  let pane = await clickCite($, w, 'agent-07 pushed at [14:52](events.log#L2) that day.', 20)
  expect(JSON.stringify(await pane.drawn({ in: 'm:cite-lines' }))).toMatch(citedText('14:52'))
  expect(shown(await pane.find({ key: 'cite-bar' }))).toBe('checked ›history 0')
  pane = await pressBar($, w, pane, 'cite-state')
  expect(shown(await pane.find({ key: 'cite-how' }))).toBe('thimble read the cited line and found the value there; no script recomputed itask for a script')
  await pane.unmount()
  pane = await clickCite($, w, 'agent-07 pushed in [the event](events.log#L2) that day.', 20)
  pane = await pressBar($, w, pane, 'cite-state')
  expect(shown(await pane.find({ key: 'cite-how' }))).toBe('thimble read the cited line; its words show no value, so only its place is checked; no script recomputed itask for a script')
  await pane.unmount()
})

test("a takeaway's citation opens a panel that agrees with the chat: no mark after its purple title (never ✓), `from the card` and its question, `checked`, and what the links check got", async ($, on) => {
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
  let pane = (await $.ui.mount(PANE)) as unknown as M
  const tree = await pane.drawn()
  // the title (a link, drawn in a Client): the value, purple and underlined, and no mark after it
  expect(JSON.stringify(tree)).toContain('{"s":"4579","b":true,"bg":"')
  expect(JSON.stringify(tree)).not.toContain('✓')
  // where it stands: the card, by its question, in place of the sentence (panel C)
  expect(shown(tree)).toContain('from the cardWhat does the export hold per wiki?')
  expect(shown(tree)).not.toContain('source')
  expect(shown(await pane.find({ key: 'cite-bar' }))).toBe('checked ›history 0')
  // the bar's state word in green, underlined
  expect(JSON.stringify(await pane.find({ key: 'cite-bar' }))).toContain('{"type":"Text","props":{"color":"success","underline":true},"children":["checked"]}')
  pane = await pressBar($, w, pane, 'cite-state')
  expect(shown(await pane.find({ key: 'cite-how' }))).toBe("the card's code computed it, and thimble found it in the card's output, and its card's links check found the same value")
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

test("a click on a citation still being verified opens a panel whose bar says `◌ checking …`, its title unmarked, and that changes when the check ends", async ($, on) => {
  // v9 review (g): "clicking a citation still being verified: the panel shows that it is being verified"
  const w = world(on)
  Object.assign(w.cells.ff73e071!, { verification: { status: 'checking', links: { status: 'pending', checked: false, resolved: [], broken: [] } } })
  await start($, w)
  // the takeaway: `The export holds 4579 pages …`, the value at column 17
  let pane = await clickTakeaway($, w, 18)
  let tree = await pane.drawn()
  // the title as at rest: no ◌ after it, the bar says it (panel C, 4)
  expect(JSON.stringify(await pane.drawn({ in: 'cite-title' }))).not.toContain('◌')
  expect(shown(await pane.find({ key: 'cite-bar' }))).toBe('◌ checking …history 0')
  // the ◌ in the citation's purple, `checking …` dim, and nothing to press yet
  expect(JSON.stringify(await pane.find({ key: 'cite-bar' }))).toContain('{"type":"Text","props":{"color":"merged"},"children":["◌"]}')
  expect(await pane.find({ type: 'Button', key: 'cite-state' })).toBeUndefined()
  expect(shown(await pane.find({ key: 'h-hints' }))).not.toContain('v for')
  await pane.unmount()
  // the check ends: the card is read again, and the panel says what it found, with no ◌
  Object.assign(w.cells.ff73e071!, { verification: { status: 'ok', links: { status: 'ok', checked: true, resolved: [{ value: '4579', ref: 'card:ff73e071#pages/TOTAL' }], broken: [] } } })
  w.stamps.set(`${WS}/notebooks`, 2)
  await w.clock.advance(1100)
  await w.clock.settle()
  pane = (await $.ui.mount(PANE)) as unknown as M
  tree = await pane.drawn()
  expect(shown(await pane.find({ key: 'cite-bar' }))).toBe('checked ›history 0')
  expect(JSON.stringify(tree)).not.toContain('◌')
  pane = await pressBar($, w, pane, 'cite-state')
  expect(shown(await pane.find({ key: 'cite-how' }))).toContain("and its card's links check found the same value")
  await pane.unmount()
})

test("a click on a citation whose place is still being read: the bar says `◌ checking …`, then `checked` once the read ends", async ($, on) => {
  const w = world(on)
  await start($, w)
  let release: () => void = () => undefined
  w.holdResolve = new Promise<void>(r => (release = r))
  const text = 'It has [4,579](README.md#L3) pages.'
  let ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  await w.clock.advance(300)
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  // still checked in the chat: the value purple and underlined, then a space and a purple ◌, not underlined
  const para = JSON.stringify(await ui.drawn({ in: 'para-1' }))
  expect(para).toContain('{"type":"Text","props":{"color":"merged","underline":true},"children":["4,579"]}')
  expect(para).toContain('{"type":"Text","props":{"color":"merged"},"children":["◌"]}')
  expect(para).not.toContain('4,579 ◌')
  await ui.pointer({ type: 'down', x: 8, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.pointer({ type: 'up', x: 8, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.unmount()
  await w.clock.advance(50)
  let pane = (await $.ui.mount(PANE)) as unknown as M
  let tree = await pane.drawn()
  expect(JSON.stringify(tree)).toContain('{"s":"4,579","b":true,"bg":"')
  expect(shown(await pane.find({ key: 'cite-bar' }))).toBe('◌ checking …history 0')
  await pane.unmount()
  // the read ends: the panel says what was found, and the ◌ goes
  release()
  await w.clock.advance(1100)
  await w.clock.settle()
  pane = (await $.ui.mount(PANE)) as unknown as M
  tree = await pane.drawn()
  expect(shown(await pane.find({ key: 'cite-bar' }))).toBe('checked ›history 0')
  expect(JSON.stringify(tree)).not.toContain('◌')
  pane = await pressBar($, w, pane, 'cite-state')
  expect(shown(await pane.find({ key: 'cite-how' }))).toContain('thimble read the cited line and found the value there')
  await pane.unmount()
})

test("a file citation's `checked` says how thimble verified it and asks a side thread for a script where no code verified it; `history 0` opens nothing", async ($, on) => {
  const w = world(on)
  await start($, w)
  let pane = await clickCite($, w, 'It has [4,579](README.md#L3) pages.', 8)
  // at rest: the bar alone, `history 0` dim and no Button
  expect(shown(await pane.find({ key: 'cite-bar' }))).toBe('checked ›history 0')
  expect(await pane.find({ type: 'Button', key: 'cite-history' })).toBeUndefined()
  expect(await pane.find({ key: 'cite-how' })).toBeUndefined()
  expect(shown(await pane.find({ key: 'h-hints' }))).toContain('v for how it was verified')
  expect(shown(await pane.find({ key: 'h-hints' }))).not.toContain('h for its history')
  pane = await pressBar($, w, pane, 'cite-state')
  expect(shown(await pane.find({ key: 'cite-how' }))).toBe('thimble read the cited line and found the value there; no script recomputed itask for a script')
  // the bar's state word again closes it; `v` opens it as a press on it does
  pane = await pressBar($, w, pane, 'cite-state')
  expect(await pane.find({ key: 'cite-how' })).toBeUndefined()
  pane = await pressBar($, w, pane, 'hk-how')
  expect(shown(await pane.find({ key: 'cite-bar' }))).toBe('checked ⌄history 0')
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

test("a click on the bar's `checked ›` keeps the panel's keys: the hint row still names them and `f` opens the file (bug hunt B28)", async ($, on) => {
  // bug hunt B28: after a click on `checked ›` the hint row said `click the panel for its keys`, and the next `f` went
  // to main's prompt. Claude Code is played as it behaved there: the click leaves the keys with the prompt, and an open
  // with `focus` gives them back while the prompt is empty
  const w = world(on)
  w.paneFocused = true
  w.grantOnReopen = true
  await start($, w)
  let pane = await clickCite($, w, 'It has [4,579](README.md#L3) pages.', 8)
  expect(shown(await pane.find({ key: 'h-hints' }))).toContain('f for its file')
  // the open's own asks for the keys are over
  await w.clock.advance(1000)
  w.paneFocused = false
  await pane.press({ key: 'cite-state' })
  await w.clock.advance(300)
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.find({ key: 'cite-how' }))).toContain('thimble read the cited line')
  expect(w.paneFocused).toBe(true)
  const hint = shown(await pane.find({ key: 'h-hints' }))
  expect(hint).toContain('f for its file')
  expect(hint).not.toContain(UNFOCUSED_HINT)
  // `f` is the panel's: the file opens, and nothing is typed into main's prompt
  await pane.press({ key: 'hk-files' })
  await w.clock.settle()
  await pane.unmount()
  expect(w.filled).toEqual([])
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.find({ type: 'Box', key: 'way' }))).toContain('README.md')
  await pane.unmount()
})

test("a citation a side thread wrote a script for shows that script under `script`, and no longer asks for one", async ($, on) => {
  const w = world(on)
  const question = 'Write and run a short script that recomputes 4,579 from the raw files. Show the script and what it printed, and say whether it agrees with the citation.'
  const meta = { id: 't9', kind: 'thread', role: 'thread', title: '"4,579"', anchor: 'README.md#L3', anchor_text: 'It has 4,579 pages.', question, parent: 'main', created_at: '2026-10-06T10:07:00+00:00', running: false, answers: 1, seen: 1 }
  w.states.threads.push(meta as never)
  w.chats.t9 = { meta, events: [{ type: 'user', text: question }, { type: 'text', delta: 'The script:\n\n```python\nn = sum(1 for _ in open("pages.jsonl"))\nprint(f"RESULT: {n:,}")\n```\n\nIt printed `RESULT: 4,579`, which agrees.', reply: true }, { type: 'done', result: 'answered' }] }
  await start($, w)
  let pane = await clickCite($, w, 'It has [4,579](README.md#L3) pages.', 8)
  await w.clock.settle()
  pane = await pressBar($, w, pane, 'cite-state')
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
  let pane = await clickCite($, w, 'It has [[14591|call:c0wc0001#L1]] revisions.', 8)
  expect(shown(await pane.drawn())).toContain('command$ wc -l revisions.jsonl')
  pane = await pressBar($, w, pane, 'cite-state')
  const text = shown(await pane.drawn())
  expect(shown(await pane.find({ key: 'cite-how' }))).toBe('the command printed it, and thimble found it in its output')
  expect(text).not.toContain('ask for a script')
  await pane.unmount()
})

test("a cited value's literal is found in code as code types it, never inside a longer number or a name; a script is an answer's first code block", () => {
  expect(literalAt('counts = [3908, 601]', '3908')).toEqual([10, 14])
  expect(literalAt('x = 3_908', '3,908')).toEqual([4, 9])
  expect(literalAt('s = "3,908 pages"', '3,908')).toEqual([5, 10])
  expect(literalAt('v = 3908.0', '3908')).toEqual([4, 10])
  expect(literalAt('rate = 12.55', '12.5')).toEqual([7, 12])
  expect(literalAt('pct = 45', '45%')).toEqual([6, 8])
  expect(literalAt('print("dse")', 'dse')).toEqual([7, 10])
  for (const line of ['n = 13908', 'v = 39080', 'a = x3908', 'df']) expect(literalAt(line, '3908')).toBeNull()
  expect(firstCode('The script:\n\n```python\nimport json\nprint(1)\n```\n\nRESULT: 3')).toEqual({ lang: 'python', code: 'import json\nprint(1)' })
  expect(firstCode('no code here, only `inline`')).toBeNull()
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

test('a value cited in a file is lit where it stands, not its whole line; the page read is the one that holds the cited line, not the file\'s first', { timeoutMs: 30_000 }, async ($, on) => {
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
