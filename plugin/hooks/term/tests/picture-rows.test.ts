// The drawings under main's rows after a prompt with a pasted picture: Claude Code draws each block of a message as a
// row of its own, and once a message of more than one block is in the conversation it draws that row and every later
// row under an id of its own (the stored uuid's first 24 characters, then the block's index in 12 hex digits), so the
// cards and the footer, kept by the stored uuid, must be found by that id too (bug hunt I9). `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>

const PROMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const REPLY = '11111111-2222-4333-8444-555555555555'
const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: 'thimble', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
/** The id Claude Code draws block `i` of a stored row under once its drawing ids part from the stored ones. */
const drawnId = (uuid: string, i: number) => `${uuid.slice(0, 24)}${i.toString(16).padStart(12, '0')}`

async function pictureTurn($: Engine, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
  w.toolText = 'card:ff73e071\n[out0: table]'
  await $.turn.start({ text: 'This is my screen: [Image #1] Make a card.', turnId: 't1' } as never)
  await $.session.append({ door: 'prompt', origin: { kind: 'composer' }, uuid: PROMPT, message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'This is my screen: [Image #1] Make a card.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] } } as never).catch(() => undefined)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: REPLY, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Here.' }] } } as never).catch(() => undefined)
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__add_card', tool_use_id: 'u1' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Here.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
}

test('after a prompt with a pasted picture, the card is drawn under the answer that Claude Code draws under a derived id', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  await pictureTurn($, w)
  // the answer as Claude Code stored it, and as it draws it after the picture: the card and the footer under both
  for (const id of [REPLY, drawnId(REPLY, 0)]) {
    const ui = (await $.ui.mount(MESSAGE(id, 'Here.'))) as unknown as M
    const drawn = await ui.drawn()
    expect(JSON.stringify(drawn)).toContain('ff73e071')
    expect(shown(drawn)).toContain('1 card')
    expect(shown(drawn)).toContain('ask about this answer')
    await ui.unmount()
  }
  // an id of a row thimble never saw stands for itself, and draws no card
  const other = (await $.ui.mount(MESSAGE(drawnId('99999999-2222-4333-8444-555555555555', 0), 'Here.'))) as unknown as M
  expect(JSON.stringify(await other.drawn())).not.toContain('ff73e071')
  await other.unmount()
})
