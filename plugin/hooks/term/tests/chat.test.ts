// Main's chat as thimble-term draws it: a takeaway's citations by thimble's links check (◌, ✓, a red ×); a reply as it
// streams handed to Claude Code as links, stored as written; a card's value checked again when the card changes; with
// "Citation marks" off a plain link and no check. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, WS, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine
type ChipProps = { props: { props: { chips: { label: string; state: string; mark: string; spin: boolean; tip: string }[] } } }

const MESSAGE = (requestId: string, text: string, surface = 'terminal') =>
  ({ plugin: 'thimble', component: 'AssistantMessage', requestId, surface, viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never

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

test("a takeaway's citations take thimble's links check: ✓ once it found the value, a red × with what the place shows, ◌ while it runs", { timeoutMs: 30_000 }, async ($, on) => {
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
  expect(chip.state).toBe('problem')
  expect(chip.tip).toBe('not found on the card · the place shows 4000')
  await ui.unmount()
})

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
