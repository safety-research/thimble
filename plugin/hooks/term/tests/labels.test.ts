// The label panel as thimble-term draws it: its fields as the browser's label editor has them (`name:`, `kind:`, a
// prompt label's `model:`, `unit:`, `scope:`, the definition on the same column), its actions underlined in the accent,
// `stop` while a run goes, a run's first error in red, the labels list's digits. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

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

test("the label panel's fields read `name:`, `kind:`, `unit:`, `scope:`, `mark records in Files and views:`, and its pattern starts on their column", async ($, on) => {
  const w = world(on)
  const pane = await labelPanel($, w)
  const text = shown(await pane.drawn())
  for (const s of ['name:', 'kind:', 'unit:', 'scope:', 'mark records in Files and views:', 'pattern:', 'values:']) expect(text).toContain(s)
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

test('`delete` (k) asks once in the panel; n keeps the label, y deletes it (`thimble act label-delete`) and opens the labels list without it', async ($, on) => {
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
  // no row of it, only the offer to undo its delete (labeledit.test.ts)
  expect(await pane.find({ type: 'Button', key: 'label-open-0' })).toBeUndefined()
  expect(text.split(LABEL.name).length - 1).toBe(1)
  expect(text).toContain(`deleted the label "${LABEL.name}"  undo`)
  await pane.unmount()
})

test('a delete thimble refuses says why on a red `×` row, and the label stays', async ($, on) => {
  const w = world(on)
  let pane = await labelPanel($, w)
  await pane.press({ key: 'hk-delete' })
  await w.clock.settle()
  // the label went from the workspace after the panel read it: thimble refuses the delete
  const kept = w.states.labels
  w.states.labels = [] as never
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'lb-delete-yes' })
  await w.clock.settle()
  w.states.labels = kept
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  expect(JSON.stringify(await pane.drawn())).toContain(`"color":"error"},"children":["× not deleted: no label '${LABEL.id}'"]`)
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

test("a label's example from a JSON record shows the field its rule reads first, its words in quotation marks, then the other fields on one dim row; never the record's JSON in quotation marks", async ($, on) => {
  const w = world(on)
  const label = w.states.labels[0] as Record<string, unknown>
  Object.assign(label, {
    kind: 'code',
    spec: "def label(unit):\n    return ('proxy-link' if 'jina' in unit.get('body', '') else 'none', 1.0)",
    rows: [
      { ref: 'revisions.jsonl#L10566', label: 'proxy-link', rationale: '', analyst: null, text: '{ "page_id": "dse/County", "wiki": "dse", "body": "SEC download https://r.jina.ai/https://www.sec.gov/files/county.json", "n_revs": 4 }' },
      { ref: 'revisions.jsonl#L1510', label: 'none', rationale: '', analyst: null, text: 'Welcome to the wiki' },
    ],
  })
  const pane = await labelPanel($, w)
  await pane.press({ key: 'lb-open-examples' })
  await w.clock.settle()
  await pane.unmount()
  const open = (await $.ui.mount(PANE)) as unknown as M
  const text = shown(await open.drawn())
  // the field's name dim in the label column, its words after it
  expect(text).toContain('body"SEC download https://r.jina.ai/https://www.sec.gov/files/county.json"')
  expect(JSON.stringify(await open.drawn())).toContain('{"type":"Text","props":{"dimColor":true},"children":["body"]}')
  expect(text).toContain('page_id dse/County · wiki dse · n_revs 4')
  expect(text).not.toContain('"{')
  // words that are no JSON record stay the record's words in quotation marks
  expect(text).toContain('"Welcome to the wiki"')
  expect(JSON.stringify(await open.drawn())).toContain('{"type":"Text","props":{"italic":true,"wrap":"wrap"},"children":["\\"SEC download')
  await open.unmount()
})

test("a record the analyst set to another value stays among the examples under that value, `✓ set by you`", async ($, on) => {
  const w = world(on)
  const label = w.states.labels[0] as Record<string, unknown>
  // as `thimble state label` gives it: the analyst's records under the value they gave (local.py, live check New 10)
  label.rows = [
    { ref: 'revisions.jsonl#L1510', label: 'none', rationale: '', analyst: 'proxy-link', text: 'Welcome to the wiki' },
    { ref: 'revisions.jsonl#L10566', label: 'proxy-link', rationale: 'r.jina.ai link', analyst: null, text: 'SEC download https://r.jina.ai/x' },
  ]
  const pane = await labelPanel($, w)
  await pane.press({ key: 'lb-open-examples' })
  await w.clock.settle()
  await pane.unmount()
  const open = (await $.ui.mount(PANE)) as unknown as M
  const text = shown(await open.drawn())
  const under = text.slice(text.indexOf('proxy-link  2'))
  expect(under).toMatch(/^proxy-link {2}2✓ set by you"Welcome to the wiki"/)
  await open.unmount()
})

test("the label's counts apply the analyst's verdicts, as thimble.labels() reads the rows, and say how many the analyst set", async ($, on) => {
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
  for (const s of ['name:', 'kind:', 'model:', 'unit:', 'scope:', 'mark records', '──', ' prompt:']) expect(at(s), s).toBeGreaterThanOrEqual(0)
  expect([at('kind:'), at('unit:'), at('scope:'), at('mark records'), at('──'), at(' prompt:')]).toEqual([at('name:') + 1, at('model:') + 1, at('unit:') + 1, at('scope:') + 1, at('mark records') + 1, at('──') + 1])
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
  expect(text).not.toContain('mark records')
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

test("a prompt label whose last run read some whole files only in part says so under its counts, in tokens", async ($, on) => {
  // the browser's Labels pane has the same line (backend concepts.read_cut), until a run of the label cuts none
  const w = world(on)
  const line = '2 of 3 files were longer than the model reads; it read the first ~905k tokens of each'
  w.states.labels = [{ ...LABEL, kind: 'prompt', unit: 'agent', glob: 'agents/*.jsonl', last_run: { ...LABEL.last_run, cut: { n: 2, line } } }] as never
  let pane = await labelPanel($, w)
  expect(shown(await pane.drawn())).toContain(line)
  expect((await pane.find({ type: 'Box', key: 'lb-cut' }))?.props).toMatchObject({ marginLeft: 10 })
  await pane.unmount()
  w.states.labels = [{ ...LABEL, kind: 'prompt', unit: 'agent', glob: 'agents/*.jsonl' }] as never
  pane = await labelPanel($, w)
  expect(shown(await pane.drawn())).not.toContain('longer than the model reads')
  await pane.unmount()
})
