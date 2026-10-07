// The label panel as thimble-term draws it: its header as Matt wrote
// it (`name:`, `type:`, `scope:`, the definition on the same column), `stop` while a run goes, a run's first error in
// red, the labels list's digits. `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, LABEL, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: 'thimble-term', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
const PANE = { plugin: 'thimble-term', component: 'Pane', requestId: 'thimble-term', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 36 }, view: {} } } as never

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

test("the label panel's header reads `name:`, `type:`, `scope:`, and its pattern starts on their column", async ($, on) => {
  const w = world(on)
  const pane = await labelPanel($, w)
  const text = shown(await pane.drawn())
  for (const s of ['name:', 'type:', 'scope:', 'pattern:']) expect(text).toContain(s)
  // each label in a column 10 cells wide (`pattern:` and a gutter), the field after it
  expect(JSON.stringify(await pane.drawn())).toContain('{"type":"Box","props":{"key":"lf-pattern:","flexDirection":"row"},"children":[{"type":"Box","props":{"width":10,"flexShrink":0}')
  expect(text).toContain('l for all labels')
  await pane.unmount()
})

test('while a run goes, `stop` (s) asks it to stop; the type is plain text', async ($, on) => {
  const w = world(on)
  let release = () => {}
  w.hold = new Promise<void>(r => (release = r))
  let pane = await labelPanel($, w)
  await pane.press({ key: 'lb-sample' })
  await w.clock.advance(50)
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  const text = shown(await pane.drawn())
  expect(text).toContain('◌ labeling a sample of 30')
  expect(text).toContain('s to stop')
  expect(await pane.find({ type: 'Button', key: 'lk-prompt' })).toBeUndefined()
  await pane.press({ key: 'hk-stop' })
  await w.clock.settle()
  expect(w.acts).toContainEqual({ kind: 'label-stop', payload: { label: LABEL.id } })
  release()
  await w.clock.settle()
  await pane.unmount()
})

test("a run that failed on some records says so, its first error on a row of its own in red; a stopped run says where it stopped", async ($, on) => {
  const w = world(on)
  w.labelRun = { ok: true, label: LABEL.id, summary: { status: 'done', labeled: 28, failed: 2, counts: { 'proxy-link': 10, none: 18 }, message: 'the model timed out on 2 records' } }
  let pane = await labelPanel($, w)
  await pane.press({ key: 'lb-sample' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  const text = shown(await pane.drawn())
  expect(text).toContain('ran on a sample of 28: proxy-link 10 · none 18 · 2 records failed')
  expect(JSON.stringify(await pane.drawn())).toContain('"color":"error"},"children":["! the model timed out on 2 records"]')
  await pane.unmount()
  w.labelRun = { ok: true, label: LABEL.id, summary: { status: 'done', labeled: 7, failed: 0, counts: { 'proxy-link': 3, none: 4 }, stopped: true, message: 'stopped after 7 records' } }
  pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'lb-all' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toContain('stopped after 7: proxy-link 3 · none 4')
  await pane.unmount()
})

test('the labels list: 1-9 open the first nine', async ($, on) => {
  const w = world(on)
  let pane = await labelPanel($, w)
  await pane.press({ key: 'hk-list' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect((await pane.find({ type: 'Button', key: 'label-open-0' }))?.props).toMatchObject({ hotkey: '1' })
  await pane.unmount()
})
