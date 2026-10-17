// A resumed session (`thimble --continue`, `--resume`): what main's chat drew under its rows (the turn's cards, the
// answer's footer) is kept in the workspace's terminal/chat.json, so the next process draws it again.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { KEPT_FILE, resetKept } from '../kept'
import { CWD, WS, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: 'thimble', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never

const KEPT = `${WS}/${KEPT_FILE}`
const ANSWER = 'The export holds [[4579|card:ff73e071#pages/TOTAL]] pages.'

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

test('after a resume the row draws its cards and its footer again, and `/thimble card 1` opens the last turn\'s card', { timeoutMs: 30_000 }, async ($, on) => {
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
  // the answer's citation and its card's takeaway's other one (citesview.tsx answerItems)
  expect(text).toContain('2 citations · 1 card')
  expect(text).toContain('ask about this answer ›')
  await ui.unmount()
  const said = await $.command.run({ command: 'thimble:thimble', args: 'card 1' } as never)
  expect(String((said as { text?: unknown }).text)).toBe('thimble: card 1 of 1')
})
