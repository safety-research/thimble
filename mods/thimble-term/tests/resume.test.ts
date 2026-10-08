// A resumed session (`thimble --continue`, `--resume`): Claude Code keeps each row's uuid, and what main's chat drew under
// its rows (the turn's cards, the answer's footer, the `↳ thread` and `↳ view` rows) is kept in the workspace's
// terminal/chat.json, so the next process draws it again. `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { KEPT_FILE, parseKept, resetKept } from '../hooks/kept'
import { CWD, WS, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: 'thimble-term', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never

const KEPT = `${WS}/${KEPT_FILE}`
const ANSWER = 'The export holds [[4579|card:ff73e071#pages/TOTAL]] pages.'

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

test("a turn's cards and its answer's footer are kept in the workspace under the row they stand under", async ($, on) => {
  resetKept()
  const w = world(on)
  await start($, w)
  w.toolText = 'card:ff73e071\n[out0: table]'
  await $.turn.start({ text: 'How big?', turnId: 't1' } as never)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'r1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: ANSWER }] } } as never).catch(() => undefined)
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u1' } as never)
  await $.turn.complete({ turnId: 't1', answer: ANSWER, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
  const kept = parseKept(w.files.get(KEPT) ?? '')
  expect(kept.rows.r1).toEqual({ cards: ['ff73e071'], answer: { rows: ['r1'], text: ANSWER, cards: ['ff73e071'] } })
  expect(kept.last).toEqual({ reply: ANSWER, cards: ['ff73e071'] })
})

test('after a resume the row draws its cards and its footer again, and `/thimble card 1` opens the last turn\'s card', async ($, on) => {
  resetKept()
  const w = world(on)
  // what the earlier process of this conversation left
  w.files.set(KEPT, JSON.stringify({ rows: { r1: { cards: ['ff73e071'], answer: { rows: ['r1'], text: ANSWER, cards: ['ff73e071'] } } }, last: { reply: ANSWER, cards: ['ff73e071'] } }))
  await start($, w)
  // the cards were read in one call, not one call each
  expect(w.calls.filter(c => c[2] === 'cards').length).toBeGreaterThan(0)
  expect(w.calls.filter(c => c[2] === 'card').length).toBe(0)
  const ui = (await $.ui.mount(MESSAGE('r1', ANSWER))) as unknown as M
  expect(await ui.find({ type: 'Client', key: 'card-t0-ff73e071' })).toBeDefined()
  const text = shown(await ui.drawn())
  expect(text).toContain('1 citation · 1 card')
  expect(text).toContain('ask about this answer ›')
  await ui.unmount()
  const said = await $.command.run({ command: 'thimble:thimble', args: 'card 1' } as never)
  expect(String((said as { text?: unknown }).text)).toBe('thimble: card 1 of 1')
})

test('a resumed row keeps its `↳ thread` and `↳ view` rows; a row the file does not name draws as Claude Code draws it', async ($, on) => {
  resetKept()
  const w = world(on)
  w.files.set(KEPT, JSON.stringify({ rows: { r2: { threads: [{ thread: 't1', turn: 1 }], views: ['edit-bursts'] } }, last: { reply: '', cards: [] } }))
  w.states.home = { ...w.states.home, views: [{ slug: 'edit-bursts', name: 'Edit Bursts', status: 'proposed', ts: '2026-10-07T01:00:00Z', files: [] }] } as never
  await start($, w)
  const ui = (await $.ui.mount(MESSAGE('r2', 'Asked.'))) as unknown as M
  const text = shown(await ui.drawn())
  // the thread's chat is read at the start, so the row names its turn's question
  expect(text).toContain('↳ thread · "why is events.jsonl so much bigger?" · answered')
  expect(text).toContain('↳ view · Edit Bursts · proposed')
  await ui.unmount()
  const other = (await $.ui.mount(MESSAGE('r9', 'Plain.'))) as unknown as M
  expect(shown(await other.drawn())).not.toContain('↳')
  await other.unmount()
  // a file that is not JSON is read as empty
  expect(parseKept('not json')).toEqual({ rows: {}, last: { reply: '', cards: [] } })
})
