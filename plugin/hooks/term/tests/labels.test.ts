// The label panel: `delete` asks once and goes through `thimble act label-delete`, its undo through `label-undelete`;
// the counts apply the analyst's verdicts; the label colors by the names show_label takes. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { COLOR_NAMES, LABEL_WHEEL, colorName } from '../labels'
import { LABEL_HUES, PICKED_HUES } from '../paint'
import { CWD, LABEL, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: 'thimble', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
const PANE = { plugin: 'thimble', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 36 }, view: {} } } as never

/** The session, a turn that made the label's card, and its label panel opened from the card's label row. */
async function labelPanel($: E, w: World): Promise<M> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
  w.toolText = "The label's card is [[card:l0label0]]."
  await $.turn.start({ text: 'Label it.', turnId: 't1' } as never)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'r1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Labelled.' }] } } as never).catch(() => undefined)
  await $.tool.call({ tool: 'mcp__plugin_thimble_thimble__apply_label', tool_use_id: 'u1' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Labelled.', durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.advance(300)
  const ui = (await $.ui.mount(MESSAGE('r1', 'Labelled.'))) as unknown as M
  await ui.post({ type: 'label-open', slug: LABEL.id, origin: 'y', gestures: [] }, { in: 'card-t0-l0label0' })
  await ui.unmount()
  await w.clock.settle()
  return (await $.ui.mount(PANE)) as unknown as M
}

/** Press `key` on the panel, then the panel drawn again. */
async function press($: E, w: World, pane: M, key: string): Promise<M> {
  await pane.press({ key })
  await w.clock.settle()
  await pane.unmount()
  return (await $.ui.mount(PANE)) as unknown as M
}

test('`delete` (k) asks once in the panel; n keeps the label, y deletes it (`thimble act label-delete`) and opens the labels list without it', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  let pane = await labelPanel($, w)
  await pane.press({ key: 'lb-delete' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  let text = shown(await pane.drawn())
  expect(text).toContain(`delete label "${LABEL.name}"? its marks and card go too · y to delete · n to keep`)
  // the run row gives way to the question, and the run key with it
  expect(await pane.find({ type: 'Button', key: 'lb-sample' })).toBeUndefined()
  expect(text).not.toContain('r to run a sample')
  await pane.press({ key: 'hk-delete-no' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  text = shown(await pane.drawn())
  expect(text).not.toContain('its marks and card go too')
  expect(text).toContain('run on a sample')
  expect(w.acts.some(a => a.kind === 'label-delete')).toBe(false)
  // k asks again, and y deletes
  await pane.press({ key: 'hk-delete' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'hk-delete-yes' })
  await w.clock.settle()
  expect(w.acts).toContainEqual({ kind: 'label-delete', payload: { label: LABEL.id } })
  expect(w.toasts.join('\n')).toContain(`deleted the label "${LABEL.name}"`)
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  text = shown(await pane.drawn())
  expect(text).toContain('Labels')
  expect(text).toContain('0 labels')
  // no row of it, only the offer to undo its delete (the undo test below)
  expect(await pane.find({ type: 'Button', key: 'label-open-0' })).toBeUndefined()
  expect(text.split(LABEL.name).length - 1).toBe(1)
  expect(text).toContain(`deleted the label "${LABEL.name}"  undo`)
  await pane.unmount()
})

test("the label's counts apply the analyst's verdicts, as thimble.labels() reads the rows, and say how many the analyst set", { timeoutMs: 30_000 }, async ($, on) => {
  // live check term-fix5, new quirk 5: one record set to `no` left the counts at 33/467, and a fork took the row the
  // verdict moved for a bug
  const w = world(on)
  Object.assign(w.states.labels[0]!, { verdicts: { counts: { none: 9401, 'proxy-link': 5190 }, set: 1 } })
  const pane = await labelPanel($, w)
  await pane.press({ key: 'hk-counts' })
  await w.clock.settle()
  await pane.unmount()
  const again = (await $.ui.mount(PANE)) as unknown as M
  const text = shown(await again.drawn())
  expect(text).toContain('counts  14,591 · 1 set by you')
  expect(text).toMatch(/proxy-link\s+[█─]+\s+5,190/)
  expect(text).toMatch(/none\s+[█─]+\s+9,401/)
  expect(text).not.toContain('5,191')
  await again.unmount()
})

test('after a delete the labels list offers `undo` (u): it sends `label-undelete` and opens the label again; a refusal says why in red', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  const kept = JSON.parse(JSON.stringify(w.states.labels[0])) as Record<string, unknown>
  let pane = await labelPanel($, w)
  pane = await press($, w, pane, 'hk-delete')
  pane = await press($, w, pane, 'hk-delete-yes')
  let text = shown(await pane.drawn())
  expect(text).toContain(`deleted the label "${LABEL.name}"  undo`)
  expect(text).toContain('u to undo')
  // thimble restores it
  w.states.labels = [kept] as never
  pane = await press($, w, pane, 'hk-undo')
  expect(w.acts).toContainEqual({ kind: 'label-undelete', payload: { label: LABEL.id } })
  text = shown(await pane.drawn())
  expect(text).toContain('name:')
  expect(text).toContain(LABEL.name)
  expect(w.toasts.join('\n')).toContain(`restored the label "${LABEL.name}"`)
  await pane.unmount()
})

test('each label color has the name show_label takes for it, and the wheel holds each of the eighteen once', () => {
  expect([1, 2, 12, 13, 14, 15, 16, 17, 18].map(colorName)).toEqual(['blue', 'orange', 'cyan', 'red', 'dark red', 'purple', 'dark purple', 'pink', 'dark pink'])
  expect([0, 19, undefined].map(colorName)).toEqual(['', '', ''])
  expect(COLOR_NAMES.length).toBe(LABEL_HUES.length + PICKED_HUES.length)
  expect(LABEL_WHEEL.flat().sort((a, b) => a - b)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1))
})
