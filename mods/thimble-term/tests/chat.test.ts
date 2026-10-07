// Main's chat as thimble-term draws it: a citation's state from
// thimble's links check (◌, ✓, a red ×) and its tip in plain words, a heading's "?" asking about its section, the `↳`
// beside a card a thread was asked about, the footer under a turn's answer, the `↳ thread` and `↳ view` rows, a citation
// typed in the prompt, a reply as it streams, a card that cannot be read, a card's value checked again when the card
// changes. `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { KEPT_FILE, parseKept } from '../hooks/kept'
import { CWD, WS, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine
type ChipProps = { props: { props: { chips: { label: string; state: string; mark: string; spin: boolean; tip: string }[] } } }

const MESSAGE = (requestId: string, text: string, surface = 'terminal') =>
  ({ plugin: 'thimble-term', component: 'AssistantMessage', requestId, surface, viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
const PANE = { plugin: 'thimble-term', component: 'Pane', requestId: 'thimble-term', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 36 }, view: {} } } as never

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

test("a takeaway's citations take thimble's links check: ✓ once it found the value, a red × with what the place shows, ◌ while it runs", async ($, on) => {
  const w = world(on)
  Object.assign(w.cells.ff73e071!, {
    verification: { status: 'ok', links: { status: 'partial', checked: true, resolved: [{ value: '4579', ref: 'card:ff73e071#pages/TOTAL' }], broken: [{ value: '14592', ref: 'card:ff73e071#revisions/TOTAL', why: 'the place shows 14591', source: '14591' }] } },
  })
  await start($, w)
  await turn($, w, [['r1', 'Here.']])
  let ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  let chips = await chipsOf(ui, 'para-tk-t0-1')
  expect(chips[0]).toMatchObject({ label: '4579', state: 'link', mark: '✓', spin: false })
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

test("a citation's tip says its status in plain words: where it was found, a value it does not check, why it was not found", async ($, on) => {
  const w = world(on)
  await start($, w)
  const text = 'It says [4,579](README.md#L3) pages, [the README](README.md#L5) says more, and [12](README.md#L99) wikis.'
  let ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  await w.clock.advance(300)
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  const chips = await chipsOf(ui, 'para-1')
  expect(chips.map(c => c.tip)).toEqual([
    'found in README.md line 3',
    'found in README.md line 5; its value is not checked',
    'not found: README.md line 99 does not exist · the place does not resolve: line 99 out of range (README.md has 20 lines)',
  ])
  expect(chips[2]!.state).toBe('problem')
  await ui.unmount()
})

test("a heading's \"?\" asks a side thread about its whole section, named by its heading", async ($, on) => {
  const w = world(on)
  await start($, w)
  const ui = (await $.ui.mount(MESSAGE('m1', '## The data\n\nThe export is big.\n\nMost of it is dse.\n\n## Next\n\nSomething else.'))) as unknown as M
  await ui.press({ key: 'ask-1-0' })
  await ui.unmount()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('about the section "The data"')
  await pane.input({ key: 'ask-new', text: 'Why so big?' })
  await w.clock.settle()
  const sent = w.acts.find(a => a.kind === 'thread')!.payload
  expect(sent.anchor).toBe(null)
  expect(String(sent.anchor_text)).toContain('The export is big.')
  expect(String(sent.anchor_text)).toContain('Most of it is dse.')
  expect(String(sent.anchor_text)).not.toContain('Something else.')
  await pane.unmount()
})

test('a card a thread was asked about keeps a blue ↳ beside its title; a click opens that thread', async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Here.']])
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  // the fixtures' thread t1 is anchored on card:ff73e071
  expect(await ui.find({ type: 'Client', key: 'asked-card-0' })).toBeDefined()
  expect(await ui.find({ key: 'ask-card-0' })).toBeUndefined()
  await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'asked-card-0' } as never)
  await ui.unmount()
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('Threads')
  await pane.unmount()
})

test("the footer under a turn's answer: its citations and cards dim, its problems in red, and `ask about this answer ›`; only the answer part counts", async ($, on) => {
  const w = world(on)
  await start($, w)
  // a label's link (`[9,400](concept:<id>/none)`) is neither a citation nor a problem (live check term-fix6, new quirk 1)
  const answer = 'The export holds [[4579|card:ff73e071#pages/TOTAL]] pages and [[14592|card:ff73e071#revisions/TOTAL]] revisions, [9,400](concept:d9b51617/none) of them without a proxy link.'
  w.toolText = 'card:ff73e071\n[out0: table]'
  await $.turn.start({ text: 'How big?', turnId: 't1' } as never)
  // what main wrote while it worked, then a tool call, then the answer
  await append($, 'r0', [{ type: 'text', text: 'Reading [[README.md#L3]] first.' }, { type: 'tool_use', id: 'u1', name: 'mcp__plugin_thimble_thimble__add_card', input: {} }])
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u1' } as never)
  await append($, 'r1', [{ type: 'text', text: answer }])
  await $.turn.complete({ turnId: 't1', answer, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
  const early = (await $.ui.mount(MESSAGE('r0', 'Reading [[README.md#L3]] first.'))) as unknown as M
  expect(await early.find({ key: 'footer-r0' })).toBeUndefined()
  await early.unmount()
  const ui = (await $.ui.mount(MESSAGE('r1', answer))) as unknown as M
  const footer = await ui.drawn({ in: 'footer-r1' } as never).catch(async () => (await ui.find({ key: 'footer-r1' })) as unknown)
  const text = shown(footer)
  expect(text).toContain('2 citations · 1 card')
  expect(text).toContain(' · 1 problem')
  expect(text).toContain('ask about this answer ›')
  expect(text).not.toContain('open as report')
  expect(JSON.stringify(footer)).toContain('{"type":"Text","props":{"color":"error"},"children":[" · 1 problem"]}')
  await ui.press({ key: 'ask-answer-r1' })
  await ui.unmount()
  let pane = (await $.ui.mount(PANE)) as unknown as M
  const asking = shown(await pane.drawn())
  expect(asking).toContain('about this answer')
  // the field holds the keys as the view opens, so a letter goes into the question: no `b` or `x` among the hints
  expect(asking).toContain('Enter to ask · Esc to leave the field')
  expect(asking).not.toContain('b to go back')
  // Esc gave the keys back to the prompt (live check term-fix5, new quirk 6): no key of the panel's is named, since a
  // letter or Enter goes to the prompt now, only how to give the panel the keys again
  await pane.unmount()
  const away = (await $.ui.mount({ ...(PANE as object), props: { ...(PANE as { props: object }).props, isFocused: false } } as never)) as unknown as M
  const unfocused = shown(await away.drawn())
  expect(unfocused).toContain('click the panel for its keys')
  expect(unfocused).not.toContain('Enter to ask')
  expect(unfocused).not.toContain('x to close')
  await away.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.input({ key: 'ask-new', text: 'Is it right?' })
  await w.clock.settle()
  // a thread about the whole answer is marked so (its element), and keeps `about this answer` in the threads panel
  expect(w.acts.find(a => a.kind === 'thread')!.payload).toMatchObject({ anchor: null, anchor_text: 'The export holds 4579 pages and 14592 revisions, 9,400 of them without a proxy link.', element: 'answer' })
  await pane.unmount()
})

test("a prompt thimble-term gave main itself gets no footer", async ($, on) => {
  const w = world(on)
  await start($, w)
  // the labels list's `describe a new label` goes to main as the analyst's prompt
  await turn($, w, [['r0', 'Labelled.']], { tool: 'mcp__plugin_thimble_thimble__apply_label', text: "The label's card is [[card:l0label0]].", input: {} })
  const msg = (await $.ui.mount(MESSAGE('r0', 'Labelled.'))) as unknown as M
  await msg.post({ type: 'label-open', slug: 'd9b51617', origin: 'y', gestures: [] }, { in: 'card-t0-l0label0' })
  await msg.unmount()
  await w.clock.settle()
  let pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'hk-list' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.input({ key: 'lbs-describe', text: 'proxies' })
  await w.clock.settle()
  await pane.unmount()
  const prompt = w.submitted.at(-1)!
  expect(prompt).toBe('Make a label with apply_label and try it on a sample of 30: proxies')
  await turn($, w, [['r1', 'Made [[4579|card:ff73e071#pages/TOTAL]].']], undefined, prompt)
  const ui = (await $.ui.mount(MESSAGE('r1', 'Made [[4579|card:ff73e071#pages/TOTAL]].'))) as unknown as M
  expect(await ui.find({ key: 'footer-r1' })).toBeUndefined()
  await ui.unmount()
})

test("a thread's turn that failed while the panel showed something else: a `↳ thread` row with its question and `failed` in red, one blank row above it", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Asked.']])
  const t2 = w.states.threads.find(t => t.id === 't2')! as Record<string, unknown>
  Object.assign(t2, { running: false })
  w.chats.t2 = { meta: { ...t2 }, events: [{ type: 'user', text: 'which pages were deleted on the dse wiki in June?' }, { type: 'error', error: 'the fork ended: overloaded' }] }
  w.stamps.set(`${WS}/chats`, 5)
  await w.clock.advance(1100)
  const ui = (await $.ui.mount(MESSAGE('r1', 'Asked.'))) as unknown as M
  const drawn = JSON.stringify(await ui.drawn())
  expect(shown(await ui.drawn())).toContain('↳ thread · "which pages were deleted on the dse wiki in June?" · failed')
  expect(drawn).toContain('{"type":"Text","props":{"color":"error"},"children":[" · failed"]}')
  expect(drawn).toContain('"key":"signal-t2:1","flexDirection":"row","marginTop":1')
  expect(drawn).not.toContain(' · new')
  await ui.unmount()
})

test('a view main proposed: a `↳ view` row under the answer, its state dim, `new` in green once built', async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Proposed it.']], { tool: 'mcp__plugin_thimble_thimble__propose_view', text: 'Proposed the view Edit Bursts (view:edit-bursts) over revisions.jsonl.', input: { name: 'Edit Bursts' } })
  w.states.home = { ...w.states.home, views: [{ slug: 'edit-bursts', name: 'Edit Bursts', status: 'building' }] } as never
  w.stamps.set(`${WS}/notebooks`, 3)
  await w.clock.advance(1100)
  let ui = (await $.ui.mount(MESSAGE('r1', 'Proposed it.'))) as unknown as M
  expect(shown(await ui.drawn())).toContain('↳ view · Edit Bursts · building')
  await ui.unmount()
  w.states.home = { ...w.states.home, views: [{ slug: 'edit-bursts', name: 'Edit Bursts', status: 'built' }] } as never
  w.stamps.set(`${WS}/notebooks`, 4)
  await w.clock.advance(1100)
  ui = (await $.ui.mount(MESSAGE('r1', 'Proposed it.'))) as unknown as M
  const text = shown(await ui.drawn())
  expect(text).toContain('↳ view · Edit Bursts · built · new')
  await ui.press({ key: 'view-open-edit-bursts' })
  await ui.unmount()
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('Edit Bursts')
  await pane.unmount()
  ui = (await $.ui.mount(MESSAGE('r1', 'Proposed it.'))) as unknown as M
  expect(shown(await ui.drawn())).not.toContain(' · new')
  await ui.unmount()
})

test('a citation typed or pasted into the prompt is painted blue and underlined', async ($, on) => {
  const w = world(on)
  await start($, w)
  // prompt.edit is the composer's event, raised here as Claude Code raises it
  const edit = ($.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }).edit
  const r = (await edit({ origin: { kind: 'composer' }, text: 'see ', cursor: 4, start: 4, end: 4, inputText: '[[4579|card:ff73e071#pages/TOTAL]] now' } as never)) as { text: string; decorations?: { start: number; end: number; underline?: boolean; color?: string }[] }
  expect(r.decorations).toEqual([{ start: 4, end: 38, underline: true, color: 'remember' }])
  void w
})

test("while main's reply streams, Claude Code is handed links and a card's placeholder, never `[[`; the row is stored as written", async ($, on) => {
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

test('off the terminal a cited paragraph is Markdown, each citation a link to its file and a problem marked ×', async ($, on) => {
  const w = world(on)
  await start($, w)
  const text = 'It says [4,579](README.md#L3) pages and [12](README.md#L99) wikis.'
  let ui = await $.ui.mount(MESSAGE('m1', text, 'mobile'))
  await w.clock.advance(300)
  await ui.unmount()
  ui = await $.ui.mount(MESSAGE('m1', text, 'mobile'))
  const md = JSON.stringify(await ui.drawn())
  expect(md).toContain(`It says [4,579](file://${CWD}/README.md) pages and [12](file://${CWD}/README.md) × wikis.`)
  expect(md).not.toContain('"?"')
  await ui.unmount()
})

test("a card that cannot be read is one red line naming it by its place in the reply, never its id", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Here.']], { tool: 'mcp__plugin_thimble_thimble__add_card', text: 'card:zz000000\n[out0: table]', input: {} })
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  const text = shown(await ui.drawn())
  expect(text).toContain('× card 1 cannot be drawn: the card is not in this workspace')
  expect(text).not.toContain('zz000000')
  expect(JSON.stringify(await ui.drawn())).toContain('"color":"error"')
  await ui.unmount()
})

test("a label tool's result row names the label and each value's count", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Labelled.']], { tool: 'mcp__plugin_thimble_thimble__apply_label', text: "The label's card is [[card:l0label0]].", input: {} })
  const row = await $.ui.mount({ plugin: 'thimble-term', component: 'ToolResult', requestId: 'u1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { tool_use_id: 'u1', tool: 'mcp__plugin_thimble_thimble__apply_label', output: "applied label links [[concept:d9b51617]] over 14591 record(s). The label's card is [[card:l0label0]].", isErrored: false } } as never)
  expect(shown(await row.drawn())).toBe('  ⎿  label "links through a fetch proxy" · proxy-link 5,191 · none 9,400')
  await row.unmount()
})

test("a citation of a card's value in main's prose is checked again when the card changes: a stale one turns red", async ($, on) => {
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
  expect(chip.state).toBe('problem')
  expect(chip.tip).toBe('not found on the card · the place shows 4000')
  await ui.unmount()
})

test("a thread main answered with reply_in_thread alone (no `done`): its `↳ thread` row says answered", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Asked.']])
  const t2 = w.states.threads.find(t => t.id === 't2')! as Record<string, unknown>
  // thimble counts the reply as the question's answer (local.py answered)
  Object.assign(t2, { running: false, answers: 1, seen: 0 })
  w.chats.t2 = { meta: { ...t2 }, events: [{ type: 'user', text: 'which pages were deleted?' }, { type: 'tool_use', name: 'Bash' }, { type: 'text', delta: 'Forty.', reply: true }] }
  w.stamps.set(`${WS}/chats`, 5)
  await w.clock.advance(1100)
  const ui = (await $.ui.mount(MESSAGE('r1', 'Asked.'))) as unknown as M
  expect(shown(await ui.drawn())).toContain('↳ thread · "which pages were deleted?" · answered · new')
  await ui.unmount()
})

test("main's own `↳ thread <slug>:` line names the thread by its first question, never the fork's slug", async ($, on) => {
  const w = world(on)
  Object.assign(w.states.threads[1]!, { fork_name: 'what-does-the-export', question: 'why is events.jsonl so much bigger?' })
  await start($, w)
  const line = '↳ thread what-does-the-export: answered that events.jsonl holds one row per event.'
  const ui = (await $.ui.mount(MESSAGE('r7', line))) as unknown as M
  const text = shown(await ui.drawn())
  expect(text).toContain('↳ thread "why is events.jsonl so much bigger?": answered that events.jsonl holds one row per event.')
  expect(text).not.toContain('what-does-the-export')
  await ui.unmount()
})

test("main's fork of a thread runs with the thread's question as its description, which Claude Code's agent tray and exit dialog show; its prompt keeps `thread:<name>`", async ($, on) => {
  const w = world(on)
  Object.assign(w.states.threads[1]!, { fork_name: 'why-is-events-jsonl-so-much', question: 'why is events.jsonl so much bigger than the other files?' })
  await start($, w)
  await $.tool.call({ tool: 'Agent', tool_use_id: 'u8', subagent_type: 'fork', name: 'why-is-events-jsonl-so-much', description: 'thread:why-is-events-jsonl-so-much', prompt: 'thread:why-is-events-jsonl-so-much' } as never)
  expect(w.toolCalls.at(-1)).toMatchObject({ name: 'why-is-events-jsonl-so-much', description: 'thread: why is events.jsonl so much bigger than…', prompt: 'thread:why-is-events-jsonl-so-much' })
  // any other Agent call runs as main wrote it
  await $.tool.call({ tool: 'Agent', tool_use_id: 'u9', subagent_type: 'general-purpose', description: 'Count the pages', prompt: 'Count them.' } as never)
  expect(w.toolCalls.at(-1)).toMatchObject({ description: 'Count the pages', prompt: 'Count them.' })
})

const ROW = (tool: string, input: Record<string, unknown>) =>
  ({ plugin: 'thimble-term', component: 'ToolUse', requestId: 'u9', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { tool_use_id: 'u9', tool, input, isRunning: false, isErrored: false, isInterrupted: false } }) as never

test("a side thread's fork is named by the thread's first question in its Agent row and in the notice that it finished, never by its slug", async ($, on) => {
  const w = world(on)
  Object.assign(w.states.threads[1]!, { fork_name: 'agent-chat-2', question: 'Is the 3,898 deletions figure supported anywhere in the event log?' })
  await start($, w)
  const row = await $.ui.mount(ROW('Agent', { description: 'thread:agent-chat-2', subagent_type: 'fork', prompt: 'the thread event' }))
  const drawn = shown(await row.drawn())
  expect(drawn).toContain('"description":"thread \\"Is the 3,898 deletions figure supported…\\""')
  expect(drawn).not.toContain('agent-chat-2')
  await row.unmount()
  // the notice the fork's end leaves in main's chat
  const notice = await $.ui.mount({ plugin: 'thimble-term', component: 'UserMessage', requestId: 'n1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text: 'Agent "thread:agent-chat-2" finished', origin: { kind: 'task-notification' }, isExpanded: false, task: { status: 'completed', durationMs: 29000 } } } as never)
  expect(shown(await notice.drawn())).toBe('Agent thread "Is the 3,898 deletions figure supported…" finished')
  await notice.unmount()
  // any other subagent's row stays as Claude Code draws it
  const other = await $.ui.mount(ROW('Agent', { description: 'writer: report', subagent_type: 'thimble:writer' }))
  expect(shown(await other.drawn())).toContain('"description":"writer: report"')
  await other.unmount()
})

test("main's own `↳ thread` line is not drawn once thimble-term drew the thread's `↳ thread` row: the chat says the thread answered once", async ($, on) => {
  const w = world(on)
  await start($, w)
  await turn($, w, [['r1', 'Asked.']])
  const t2 = w.states.threads.find(t => t.id === 't2')! as Record<string, unknown>
  Object.assign(t2, { running: false, answers: 1, seen: 0, fork_name: 'the-deletions', question: 'which pages were deleted?' })
  w.chats.t2 = { meta: { ...t2 }, events: [{ type: 'user', text: 'which pages were deleted?' }, { type: 'text', delta: 'Forty.', reply: true }] }
  w.stamps.set(`${WS}/chats`, 5)
  await w.clock.advance(1100)
  let ui = (await $.ui.mount(MESSAGE('r1', 'Asked.'))) as unknown as M
  expect(shown(await ui.drawn())).toContain('↳ thread · "which pages were deleted?" · answered')
  await ui.unmount()
  // main's line when the fork returns: not drawn, and a block that is only that line draws nothing
  ui = (await $.ui.mount(MESSAGE('r2', '↳ thread the-deletions: answered that forty pages were deleted.'))) as unknown as M
  expect(shown(await ui.drawn())).not.toContain('answered that forty')
  await ui.unmount()
  // a line about a thread with no row of thimble-term's is drawn, its thread named by its question
  Object.assign(w.states.threads[1]!, { fork_name: 'what-does-the-export', question: 'why is events.jsonl so much bigger?' })
  w.stamps.set(`${WS}/chats`, 6)
  await w.clock.advance(1100)
  ui = (await $.ui.mount(MESSAGE('r3', 'Done.\n\n↳ thread what-does-the-export: answered.'))) as unknown as M
  expect(shown(await ui.drawn())).toContain('↳ thread "why is events.jsonl so much bigger?": answered.')
  await ui.unmount()
})

test("a thimble tool's row names a card by its question, without straight quotation marks Claude Code would escape, and a takeaway's citations as their words; the questions cut at a word", async ($, on) => {
  const w = world(on)
  w.cells.ff73e071!.title = 'Which five pages have the most revisions in the corpus?'
  await start($, w)
  await turn($, w, [['r1', 'Here.']])
  const row = await $.ui.mount(ROW('mcp__plugin_thimble_thimble__edit_card', { card: 'card:ff73e071', takeaway: 'The most edited page has [[60|card:ff73e071#revisions/dse%2FAgentLinkma20JuneAA]] revisions; see [[README.md#L3]] and [[card:ff73e071]].' }))
  const drawn = shown(await row.drawn())
  // the card key: its question alone; the takeaway: each citation its words, the card it embeds in curly quotation marks
  expect(drawn).toContain('"card":"Which five pages have the most revisions in the corpus?"')
  expect(drawn).toContain('"takeaway":"The most edited page has 60 revisions; see README line 3 and card “Which five pages have the most…”."')
  expect(drawn).not.toMatch(/ff73e071|\[\[|\\"/)
  await row.unmount()
  // a Bash row that runs the card: its question cut at a word
  const bash = await $.ui.mount(ROW('Bash', { command: '/tree/plugin/bin/thimble-run card ff73e071', description: 'Run the card' }))
  expect(shown(await bash.drawn())).toContain('"command":"thimble-run card \\"Which five pages have the most…\\""')
  await bash.unmount()
})

test("a card whose takeaway holds the passage a thread was asked about (a citation in it) keeps a blue ↳ beside it", async ($, on) => {
  const w = world(on)
  // the live check's thread (New 14): asked about a citation in the card's takeaway, its anchor the cited place
  w.states.threads.push({ id: 't4', kind: 'thread', role: 'thread', title: 'README:3', anchor: 'README.md#L3', anchor_text: 'The export holds 4579 pages and 14592 revisions.', parent: 'main', created_at: '2026-10-06T10:05:00+00:00', running: false, answers: 1, seen: 1 } as never)
  // not the fixtures' thread anchored on the card itself
  w.states.threads.splice(1, 1)
  await start($, w)
  await turn($, w, [['r1', 'Here.']])
  const ui = (await $.ui.mount(MESSAGE('r1', 'Here.'))) as unknown as M
  expect(await ui.find({ type: 'Client', key: 'asked-card-0' })).toBeDefined()
  await ui.unmount()
})

test('a sentence that cites a card the turn draws under the reply leaves the reference out; a card drawn elsewhere is named by its question', async ($, on) => {
  const w = world(on)
  await start($, w)
  const text = 'The pages are spread over four wikis [[card:ff73e071]]. The files hold more records [[card:a0frame0]].'
  await turn($, w, [['r1', text]])
  let ui = (await $.ui.mount(MESSAGE('r1', text))) as unknown as M
  // the card of another turn is read by the session's timer, then named
  await w.clock.advance(1100)
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('r1', text))) as unknown as M
  const para = shown(await ui.drawn({ in: 'para-1' }))
  // the turn's card stands under the reply: no `card` at the sentence's end, and no space before its full stop
  expect(para).toContain('four wikis. The files')
  // a card of another turn: named by its question, as its citation's link (live check New 1)
  // in parentheses, so that it reads as a reference and not as words of the sentence
  expect(para).toContain('(card "How many records does each file hold?").')
  expect(para).not.toMatch(/\bcard\./)
  const chips = await chipsOf(ui, 'para-1')
  expect(chips.map(c => c.label)).toEqual(['card "How many records does each file hold?"'])
  // the footer counts cited values: a card cited whole is none
  expect(shown(await ui.drawn())).not.toMatch(/\d+ citations?/)
  // a thread asked about the whole card (the fixtures' t1) stands beside the card, not beside a passage naming it
  expect(await ui.find({ type: 'Client', key: 'asked-1' })).toBeUndefined()
  await ui.unmount()
})

test('a citation that names only its place (`[↗](ref)`) reads as a reference in parentheses, as a card cited whole does', async ($, on) => {
  // live check term-fix6, new quirk 5: `…on 18 June card "What is the first deletion in…" output line 1. That is…`
  const w = world(on)
  await start($, w)
  const text = 'The files hold 19913 events [↗](card:a0frame0@out0#L1). See also ([↗](card:a0frame0@out0#L2)).'
  await turn($, w, [['r1', text]])
  let ui = (await $.ui.mount(MESSAGE('r1', text))) as unknown as M
  await w.clock.advance(1100)
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('r1', text))) as unknown as M
  const para = shown(await ui.drawn({ in: 'para-1' }))
  expect(para).toContain('19913 events (card "How many records does each file hold?" output line 1). See also (card "How many')
  expect(para).toMatch(/hold\?" output line 2\)\.$/)
  const chips = await chipsOf(ui, 'para-1')
  expect(chips.map(c => c.label)).toEqual(['card "How many records does each file hold?" output line 1', 'card "How many records does each file hold?" output line 2'])
  await ui.unmount()
})

test("main's `↳ The writer …` line is said once: a later row about the same writer run leaves it out, after a resume too", async ($, on) => {
  // live check term-fix6, new quirk 6: once after the writer's message, again after Claude Code's task notification
  const w = world(on)
  ;(w.states.agents.rows as unknown[]).push({ name: 'thimble:writer', label: 'writer: report', state: 'done', kind: 'subagent', chat: 'w1', role: 'writer', started: '2026-10-06T10:10:00+00:00' })
  await start($, w)
  await w.clock.advance(1100)
  const line = '↳ The writer finished the report; thimble shows it.'
  const draw = async (row: string, text: string) => {
    const ui = (await $.ui.mount(MESSAGE(row, text))) as unknown as M
    const got = shown(await ui.drawn())
    await ui.unmount()
    return got
  }
  expect(await draw('r1', line)).toContain('The writer finished the report; thimble shows it.')
  const again = await draw('r2', `${line}\n\nThe thread is asked.`)
  expect(again).not.toContain('The writer finished')
  expect(again).toContain('The thread is asked.')
  expect(await draw('r1', line)).toContain('The writer finished the report')
  // kept with the rows, so a resumed session decides the same
  const kept = parseKept(w.files.get(`${WS}/${KEPT_FILE}`) ?? '')
  expect(kept.rows.r1?.writer).toEqual({ chat: 'w1', first: true })
  expect(kept.rows.r2?.writer).toEqual({ chat: 'w1', first: false })
  // a later writer run's end is said again
  ;(w.states.agents.rows as unknown[]).push({ name: 'thimble:writer', label: 'writer: slides', state: 'done', kind: 'subagent', chat: 'w2', role: 'writer', started: '2026-10-06T11:10:00+00:00' })
  w.stamps.set(`${WS}/chats`, 2)
  await w.clock.advance(1100)
  expect(await draw('r3', '↳ The writer finished the slides; thimble shows them.')).toContain('The writer finished the slides')
})

test("a passage whose citation a side thread was asked about keeps a blue ↳ beside it, which opens that thread", async ($, on) => {
  const w = world(on)
  // the live check's thread (New 5): asked about the citation, its anchor the cited place, its anchor text the passage
  w.states.threads.push({ id: 't5', kind: 'thread', role: 'thread', title: 'README:3', anchor: 'README.md#L3', anchor_text: 'The reviewer read the README: it says 4,579 pages.', parent: 'main', created_at: '2026-10-06T10:05:00+00:00', running: false, answers: 1, seen: 1 } as never)
  await start($, w)
  const text = '- The reviewer read the README: it says [4,579](README.md#L3) pages.\n- Another passage cites [4,579](README.md#L3) too, with other words around it.'
  const ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  expect(await ui.find({ type: 'Client', key: 'asked-1' })).toBeDefined()
  // a passage that cites the same place in other words is not the one the thread was asked about
  expect(await ui.find({ type: 'Client', key: 'asked-2' })).toBeUndefined()
  await ui.unmount()
})

test("a fork's prompt (ctrl+o's `Prompt:`) and its result name the thread by its first question, never its slug", async ($, on) => {
  const w = world(on)
  Object.assign(w.states.threads[1]!, { fork_name: 'agent-chat-2', question: 'Is the 3,898 deletions figure supported anywhere in the event log?' })
  await start($, w)
  const row = await $.ui.mount(ROW('Agent', { description: 'thread:agent-chat-2', subagent_type: 'fork', prompt: 'thread:agent-chat-2' }))
  const drawn = shown(await row.drawn())
  expect(drawn).toContain('"prompt":"thread \\"Is the 3,898 deletions figure supported…\\""')
  expect(drawn).not.toContain('agent-chat-2')
  await row.unmount()
  const result = await $.ui.mount({ plugin: 'thimble-term', component: 'ToolResult', requestId: 'u9', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { tool_use_id: 'u9', tool: 'Agent', output: { status: 'async_launched', agentId: 'a1', description: 'thread:agent-chat-2', prompt: 'thread:agent-chat-2' }, isErrored: false } } as never)
  expect(shown(await result.drawn())).not.toContain('agent-chat-2')
  await result.unmount()
})

test("a thimble tool's row draws a takeaway's own quotation marks curly, so Claude Code escapes none (`\\\"Agent\\\"`)", async ($, on) => {
  const w = world(on)
  w.cells.ff73e071!.title = 'How many pages have "June" in their title?'
  await start($, w)
  await turn($, w, [['r1', 'Here.']])
  const row = await $.ui.mount(ROW('mcp__plugin_thimble_thimble__edit_card', { card: 'card:ff73e071', takeaway: 'All five are pages whose names start with "Agent", as [[card:ff73e071]] shows.', code: 'print("a")' }))
  const drawn = shown(await row.drawn())
  expect(drawn).toContain('"takeaway":"All five are pages whose names start with “Agent”, as card “How many pages have ‘June’ in their…” shows."')
  expect(drawn).toContain('"card":"How many pages have “June” in their title?"')
  // code keeps its quotation marks as written
  expect(drawn).toContain('"code":"print(\\"a\\")"')
  await row.unmount()
})

test("a takeaway's link to a label turns red once the label counts another number, its tip the count now with the verdicts", async ($, on) => {
  // live check term-fix7, quirk 8: after one verdict the takeaway's 180 and 4,399 stayed blue beside bars of 179 / 4,400
  const w = world(on)
  Object.assign(w.cells.l0label0!, { takeaway: '[[5191|concept:d9b51617/proxy-link]] of [[14591|concept:d9b51617]] revisions link through a proxy.' })
  Object.assign(w.states.labels[0]!, { verdicts: { counts: { none: 9401, 'proxy-link': 5190 }, set: 1 } })
  await start($, w)
  await turn($, w, [['r0', 'Labelled.']], { tool: 'mcp__plugin_thimble_thimble__apply_label', text: "The label's card is [[card:l0label0]].", input: {} })
  const ui = (await $.ui.mount(MESSAGE('r0', 'Labelled.'))) as unknown as M
  const chips = await chipsOf(ui, 'para-tk-t0-1')
  expect(chips[0]).toMatchObject({ label: '5191', state: 'problem', mark: '' })
  expect(chips[0]!.tip).toBe('the label counts 5,190 now, with your verdicts · opens the label at its value "proxy-link"')
  // the records it labeled are still 14,591: blue
  expect(chips[1]).toMatchObject({ label: '14591', state: 'link' })
  await ui.unmount()
})

test("a date in words in main's reply is checked: one its place does not write is red, one it writes is found", async ($, on) => {
  // live check term-fix7, new quirk 3: a wrong `[24 June](card:…#day/06-23)` was blue, "its value is not checked"
  const w = world(on)
  await start($, w)
  w.resolve = { ...w.resolve, 'card:ff73e071#day/06-23': { ref: 'card:ff73e071#day/06-23', kind: 'cell', cell_id: 'ff73e071', excerpt: 'day × 06-23 = 06-23', meta: { span: { col: 'day', row: '06-23', value: '06-23' } } } }
  const text = 'The busiest day was [24 June](card:ff73e071#day/06-23), not [23 June](card:ff73e071#day/06-23).'
  await turn($, w, [['r1', text]])
  let ui = (await $.ui.mount(MESSAGE('r1', text))) as unknown as M
  await w.clock.advance(1100)
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('r1', text))) as unknown as M
  const chips = await chipsOf(ui, 'para-1')
  expect(chips[0]).toMatchObject({ label: '24 June', state: 'problem' })
  expect(chips[0]!.tip).toContain('not found on the card')
  expect(chips[1]).toMatchObject({ label: '23 June', state: 'link' })
  expect(chips[1]!.tip).toBe('found on the card')
  await ui.unmount()
})
