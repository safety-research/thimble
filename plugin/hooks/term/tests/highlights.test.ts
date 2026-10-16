// A check's comment on a passage of Claude's answer (SPEC-v2 3.12): the passage tinted in the check's color with a flag
// in the margin; none with "Checks" off. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { labelHex, tintOf } from '../paint'
import { WS, aTurn, startSession, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
const SLOW = { timeoutMs: 30000 }
const FIRST = 'The board has two kinds of posts, coordination and status reports, and most of them came in the first week of June.'
const CLAIM = 'After 19 June there are 0 new messages to other agents on any page.'
const ANSWER = `${FIRST} ${CLAIM}\n\nThe rest are replies.`
const at = ANSWER.indexOf(CLAIM)
const comment = (over: Record<string, unknown> = {}) => ({ id: 'c1', check: 'important-details', check_name: 'Important details', color: 2, about: 'it looks for what a reader would likely miss', turn: 'r1', row: 'r1', ref: 'answer:r1#s2', start: at, end: at + CLAIM.length, quote: CLAIM, text: 'The label could not read 899 revisions whose text the dump hides.', details: '', status: 'open', at: '2026-10-16T16:06:00Z', ...over })

const MESSAGE = (columns: number, fullscreen = true, rows = 40) =>
  ({ plugin: 'thimble', component: 'AssistantMessage', requestId: 'r1', surface: 'terminal', viewport: { columns, rows, isFullscreen: fullscreen }, props: { text: ANSWER, isFirstOfReply: true } }) as never

/** A session with the answer row r1 and the checks' comments read (the answers area changed). */
async function answered($: Engine, w: World, comments: Record<string, unknown>[]): Promise<void> {
  await startSession($, w)
  await aTurn($, w, 'r1', ANSWER)
  w.comments = comments
  w.stamps.set(`${WS}/answer-comments.json`, 2)
  await w.clock.advance(1100)
}

/** The tints the paragraph's Client was handed, and its flag's Client, if any. */
async function tintsOf(ui: M): Promise<{ tints: { a: number; b: number; bg: string; id: string }[]; json: string }> {
  const json = JSON.stringify(await ui.drawn())
  const m = /"tints":(\[[^\]]*\])/.exec(json)
  return { tints: m ? (JSON.parse(m[1]!) as { a: number; b: number; bg: string; id: string }[]) : [], json }
}

test("a comment's passage is tinted in its check's color at 16%, with a flag in that color in the margin", SLOW, async ($, on) => {
  const w = world(on)
  await answered($, w, [comment()])
  const ui = (await $.ui.mount(MESSAGE(150))) as unknown as M
  const { tints, json } = await tintsOf(ui)
  expect(tints.length).toBe(1)
  expect(tints[0]!.bg).toBe(tintOf(labelHex(2, 'dark'), 'dark', 0.16))
  expect(tints[0]!.id).toBe('c1')
  // the flag: ⚑ in the check's color (the label palette's place 2, as the browser's swatch)
  expect(json).toContain(`{"s":"⚑","fg":"${labelHex(2, 'dark')}"}`)
  await ui.unmount()
})

test('"Checks" off: no tint and no flag', { ...SLOW, options: { checks: false } }, async ($, on) => {
  const w = world(on)
  w.features.checks = false
  await answered($, w, [comment()])
  const ui = (await $.ui.mount(MESSAGE(150))) as unknown as M
  const { tints, json } = await tintsOf(ui)
  expect(tints).toEqual([])
  expect(json).not.toContain('⚑')
  await ui.unmount()
})
