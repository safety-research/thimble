// Main's chat as thimble-term draws it, the parts ported from thimble-cc-mod's round 8: a citation's state from
// thimble's links check (◌, ✓, a red ×) and its tip in plain words, a heading's "?" asking about its section, the `↳`
// beside a card a thread was asked about, the footer under a turn's answer, the `↳ thread` and `↳ view` rows, a citation
// typed in the prompt, a reply as it streams, a card that cannot be read, a card's value checked again when the card
// changes. `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

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
  const answer = 'The export holds [[4579|card:ff73e071#pages/TOTAL]] pages and [[14592|card:ff73e071#revisions/TOTAL]] revisions.'
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
  const pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('about this answer')
  await pane.input({ key: 'ask-new', text: 'Is it right?' })
  await w.clock.settle()
  expect(w.acts.find(a => a.kind === 'thread')!.payload).toMatchObject({ anchor: null, anchor_text: 'The export holds 4579 pages and 14592 revisions.' })
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
