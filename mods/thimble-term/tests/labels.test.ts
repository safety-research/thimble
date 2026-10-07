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
  // each folded part's key by what it opens (live check New 11)
  expect(text).toContain('r to run a sample · k to delete · c counts, e examples, d cards · l for labels')
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
  expect(text).not.toContain(LABEL.name)
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

test("a label whose first run stopped part way counts its scope in its panel: `run on all N` and `N records`", async ($, on) => {
  // live check term-fix10, low quirk: `run on all` with no number and `scope: pages.jsonl` with no count, though
  // `thimble state` gave the scope's 4,579 records (scope_total)
  const w = world(on)
  w.states.labels = [{ ...LABEL, glob: 'pages.jsonl', last_run: null, applications: [], label_stats: { n_labeled: 1900, counts: { none: 1800, 'proxy-link': 100 } }, scope_total: 4579 }] as never
  const pane = await labelPanel($, w)
  const text = shown(await pane.drawn())
  expect(text).toContain('stopped at 1,900 of 4,579')
  expect(text).toContain('run on all 4,579')
  expect(text).toMatch(/scope:\s*4,579 records/)
  await pane.unmount()
})
