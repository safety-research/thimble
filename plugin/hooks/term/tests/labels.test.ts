// The label panel: its fields as the browser's label editor has them (`name:`, `kind:`, a prompt label's `model:`,
// `unit:`, `scope:`, the definition on the same column), its actions underlined in the accent; `delete` asks once and
// goes through `thimble act label-delete`, its undo through `label-undelete`; the counts apply the analyst's verdicts;
// the label colors by the names show_label takes. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { COLOR_NAMES, LABEL_WHEEL, colorName } from '../labels'
import { LABEL_HUES, PICKED_HUES } from '../paint'
import { CWD, LABEL, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

/** The label as `thimble state label` gives it, which a test changes to what thimble answers after an act. */
const label = (w: World) => w.states.labels[0] as Record<string, unknown>

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

test("the label panel's fields read `name:`, `kind:`, `unit:`, `scope:`, `highlight:`, and its pattern starts on their column", { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  const pane = await labelPanel($, w)
  const text = shown(await pane.drawn())
  for (const s of ['name:', 'kind:', 'unit:', 'scope:', 'highlight:', 'pattern:', 'values:']) expect(text).toContain(s)
  expect(text).not.toContain('type:')
  // each label in a column 10 cells wide (the longest, `pattern:`, and a gutter), the field after it; the definition's
  // name on its box's first row of text
  const json = JSON.stringify(await pane.drawn())
  expect(json).toContain('{"type":"Box","props":{"key":"lf-name:","flexDirection":"row"},"children":[{"type":"Box","props":{"width":10,"flexShrink":0}')
  expect(json).toContain('{"type":"Box","props":{"key":"lf-pattern:","flexDirection":"row"},"children":[{"type":"Box","props":{"width":10,"flexShrink":0,"flexDirection":"column"},"children":[{"type":"Text","children":[" "]},{"type":"Text","props":{"dimColor":true},"children":["pattern:"]}]}')
  // the keys as Claude Code's ring walks them (mockup labelpanel2); the letters stay bound, unnamed
  expect(text).toContain('↑↓ to choose · Enter to press or edit')
  expect(text).not.toContain('r to run a sample')
  expect(text).not.toContain('c counts')
  await pane.unmount()
})

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
  // the values show as the panel opens, nothing to unfold
  const text = shown(await pane.drawn())
  expect(text).toContain('values:1 set by you')
  expect(text).toMatch(/proxy-link\s+━+\s+5,190/)
  expect(text).toMatch(/none\s+━+\s+9,401/)
  expect(text).not.toContain('5,191')
  await pane.unmount()
})

test("a label whose first run stopped part way counts its scope in its panel: the files its glob matches and the records they hold", async ($, on) => {
  // live check term-fix10, low quirk: no number, though `thimble state` gave the scope's 4,579 records (scope_total);
  // 0.9.0 (Matt, 19:05): the scope row says what its count is, `<glob> · 1 file matches`; mockup labelpanel2: then the
  // records, by the word their files give them (`· 4,579 lines`), and `run on all` alone
  const w = world(on)
  w.states.labels = [{ ...LABEL, glob: 'pages.jsonl', last_run: null, applications: [], label_stats: { n_labeled: 1900, counts: { none: 1800, 'proxy-link': 100 } }, scope_total: 4579, scope_files: 1, scope_unit: 'lines', run_model: 'Haiku 4.5' }] as never
  const pane = await labelPanel($, w)
  const text = shown(await pane.drawn())
  expect(text).toContain('stopped at 1,900 of 4,579')
  expect(text).toMatch(/scope:\s*· 1 file matches · 4,579 lines/)
  expect(await pane.find({ type: 'Button', key: 'lb-all' })).toMatchObject({ text: 'run on all' })
  // a regex label has no model row
  expect(text).not.toContain('model:')
  await pane.unmount()
})

test("a prompt label's panel has a `model:` row among its fields, after `kind:`: the model by its id, a choice; a pick sends `label {model}`, the labels role's as ''", async ($, on) => {
  // Matt (19:05): the label panel shows the model a prompt label uses; (mockup labelpanel2) every field exposed and
  // editable like the browser, the model an editable choice in the header
  const w = world(on)
  const choices = ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5']
  w.states.labels = [{ ...LABEL, kind: 'prompt', spec: 'Does the text link through a proxy?', glob: 'agents/*.jsonl', scope_files: 3, run_model: 'Haiku 5.5', model_id: 'claude-haiku-5-5', model_role: 'claude-haiku-5-5', model_choices: choices, model: '' }] as never
  let pane = await labelPanel($, w)
  const tree = (await pane.drawn()) as { children?: unknown[] }
  const text = shown(tree)
  expect(text).toMatch(/model:\s*claude-haiku-5-5 ▾/)
  expect(text).toMatch(/scope:\s*· 3 files match/)
  // on the selection background, the ▾ dim: a choice
  expect(JSON.stringify(await pane.find({ type: 'Button', key: 'lb-model' }))).toContain('{"type":"Text","props":{"backgroundColor":"selectionBg","dimColor":true},"children":["▾"]}')
  // the panel's rows in order: name, kind, model, unit, scope, the marks, the rule, the prompt
  const rows = (tree.children ?? []).map(r => shown(r))
  const at = (s: string) => rows.findIndex(r => r.startsWith(s))
  // the definition's name stands on its box's first row of text, under a blank cell
  for (const s of ['name:', 'kind:', 'model:', 'unit:', 'scope:', 'highlight:', '──', ' prompt:']) expect(at(s), s).toBeGreaterThanOrEqual(0)
  expect([at('kind:'), at('unit:'), at('scope:'), at('highlight:'), at('──'), at(' prompt:')]).toEqual([at('name:') + 1, at('model:') + 1, at('unit:') + 1, at('scope:') + 1, at('highlight:') + 1, at('──') + 1])
  expect(at('model:')).toBe(at('kind:') + 1)
  // a click shows the models, the one it runs on lit; a pick saves it
  await pane.press({ key: 'lb-model' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toMatch(/model:\s*claude-haiku-5-5 ▾\s*claude-haiku-5-5\s+claude-opus-5-5\s+claude-sonnet-5\s/)
  expect(await pane.find({ type: 'Button', key: 'lb-model-claude-haiku-5-5' })).toBeUndefined()
  expect(await pane.find({ type: 'Button', key: 'lb-model-claude-sonnet-5' })).toMatchObject({ props: { label: ' claude-sonnet-5 ', dimColor: true } })
  Object.assign(label(w), { model: 'claude-sonnet-5', model_id: 'claude-sonnet-5', run_model: 'Sonnet 5' })
  await pane.press({ key: 'lb-model-claude-sonnet-5' })
  await w.clock.settle()
  expect(w.acts).toContainEqual({ kind: 'label', payload: { label: LABEL.id, model: 'claude-sonnet-5' } })
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(shown(await pane.drawn())).toMatch(/model:\s*claude-sonnet-5 ▾/)
  expect(await pane.find({ type: 'Button', key: 'lb-model-claude-opus-5-5' })).toBeUndefined()
  // the labels role's model again: its own model cleared, as the browser's editor saves it
  await pane.press({ key: 'lb-model' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'lb-model-claude-haiku-5-5' })
  await w.clock.settle()
  expect(w.acts.at(-1)).toEqual({ kind: 'label', payload: { label: LABEL.id, model: '' } })
  await pane.unmount()
})

test("a regex label has no `model:` row", async ($, on) => {
  const w = world(on)
  w.states.labels = [{ ...LABEL, model_id: 'claude-haiku-5-5', model_role: 'claude-haiku-5-5', model_choices: ['claude-haiku-5-5', 'claude-opus-5-5'] }] as never
  const pane = await labelPanel($, w)
  expect(shown(await pane.drawn())).not.toContain('model:')
  await pane.unmount()
})

test("a label over cards has neither the marks row nor a glob field: its scope is the canvas's cards and how many", async ($, on) => {
  const w = world(on)
  w.states.labels = [{ ...LABEL, unit: 'cell', glob: '', kind: 'prompt', spec: 'Does the takeaway state a number?', labels: ['yes', 'no'], label_stats: { n_labeled: 9, counts: { yes: 6, no: 3 } }, last_run: { total: 9, matched_total: 9, labeled: 9, status: 'done', limit: null }, model_id: 'claude-haiku-5-5', model_role: 'claude-haiku-5-5', model_choices: ['claude-haiku-5-5'] }] as never
  const pane = await labelPanel($, w)
  const text = shown(await pane.drawn())
  expect(text).toContain("scope:the canvas's cards · 9 cards")
  expect(text).not.toContain('highlight:')
  expect(await pane.find({ type: 'Input', key: `lb-glob-${LABEL.id}` })).toBeUndefined()
  // one model to choose from: no choice to make, no button
  expect(text).toMatch(/model:\s*claude-haiku-5-5 ▾/)
  expect(await pane.find({ type: 'Button', key: 'lb-model' })).toBeUndefined()
  expect(text).toContain('last run on all 9 cards')
  await pane.unmount()
})

test("the label panel's actions read as buttons: `run on a sample`, `run on all`, `rename` underlined in the accent, `delete` in red", async ($, on) => {
  // Matt (v9 review, item m): they read as text; mockup labelpanel2: underlined accent words, delete in red
  const w = world(on)
  let pane = await labelPanel($, w)
  // an action: a Button whose words are one underlined Text in the accent, or red
  const action = async (key: string) => {
    const b = await pane.find({ type: 'Button', key })
    const t = b?.children[0] as { type?: string; props?: { color?: string; underline?: boolean }; text?: string } | undefined
    return { words: b?.text, tag: t?.type, color: t?.props?.color, underline: t?.props?.underline }
  }
  for (const [key, words, color] of [['lb-sample', 'run on a sample', 'suggestion'], ['lb-all', 'run on all', 'suggestion'], ['lb-rename', 'rename', 'suggestion'], ['lb-delete', 'delete', 'error']] as const) expect(await action(key)).toEqual({ words, tag: 'Text', color, underline: true })
  // three cells apart, the last run dim on its own row above them, its records by name
  expect((await pane.find({ type: 'Box', key: 'lb-runs' }))?.props).toMatchObject({ columnGap: 3 })
  expect(JSON.stringify(await pane.drawn())).toContain('{"type":"Text","props":{"dimColor":true,"wrap":"wrap"},"children":["last run on all 14,591 records"]}')
  // the question a delete asks: its answers are actions too
  await pane.press({ key: 'lb-delete' })
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  for (const [key, words, color] of [['lb-delete-yes', 'y to delete', 'error'], ['lb-delete-no', 'n to keep', 'suggestion']] as const) expect(await action(key)).toEqual({ words, tag: 'Text', color, underline: true })
  await pane.unmount()
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
