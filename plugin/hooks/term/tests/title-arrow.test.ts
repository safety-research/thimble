// The title row's `↗` (panel.tsx wayRow, SPEC-v2 J4, 3.8): every view's title row ends with a `↗` that opens the view's
// object in the browser, the same ref as `o`: home, a card, a citation, a label, a document, a file, a view, the
// coverage, the citations and the checks. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, LABEL, WS, aboveAt, comment, paneAt, panelWorld, words } from './fixtures-panel'
import type { PanelWorld } from './fixtures-panel'

type M = Mounted<'terminal'>
type E = Engine

async function start($: E, w: PanelWorld): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

/** The panel opened by `/thimble <args>`; its title row's `↗` pressed, then `o`, 6 s apart (a press on the same object
 *  within 5 s opens nothing more): the refs each opened. */
async function both($: E, w: PanelWorld, args: string): Promise<string[]> {
  await $.command.run({ command: 'thimble:thimble', args } as never)
  await w.clock.settle()
  const m = (await $.ui.mount(paneAt(96))) as unknown as M
  expect(words(await m.find({ type: 'Box', key: 'way' })).endsWith('↗')).toBe(true)
  await m.press({ key: 'way-browser' })
  await w.clock.advance(13_000)
  await m.press({ key: 'hk-browser' })
  await w.clock.advance(13_000)
  await m.unmount()
  return w.pressed.slice(-2).map(a => a[a.indexOf('--ref') + 1]!)
}

const CASES: [string, string, (w: PanelWorld) => void][] = [
  ['home', 'home', () => undefined],
  ['card ff73e071', 'card:ff73e071', () => undefined],
  ['cite 1', 'README.md#L3', () => undefined],
  ['documents', 'report:report', () => undefined],
  ['files', 'files:', () => undefined],
  ['files README.md', 'files:README.md', () => undefined],
  ['coverage', 'files:', () => undefined],
  ['citations', 'home', () => undefined],
  ['checks', 'answer:r1#s1', w => void (w.t.answerComments = [comment('c1')])],
]

for (const [args, ref, setup] of CASES) {
  test(`/thimble ${args}: the title row's ↗ and o open ${ref} in the browser`, { timeoutMs: 30_000 }, async ($, on) => {
    const w = panelWorld(on)
    setup(w)
    await start($, w)
    if (args === 'cite 1') {
      // the last reply's first citation
      const text = 'The README says [[4,579|README.md#L3]] pages.'
      await $.turn.start({ text: 'How many?', turnId: 't1' } as never)
      await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'r1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] } } as never).catch(() => undefined)
      await $.turn.complete({ turnId: 't1', answer: 'x', durationMs: 5, reason: 'answer', isAborted: false } as never)
    }
    expect(await both($, w, args === 'home' ? '' : args)).toEqual([ref, ref])
  })
}

test("a label's and a document's title row open the label and the document", { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'documents' } as never)
  await w.clock.settle()
  const m = (await $.ui.mount(paneAt(96))) as unknown as M
  await m.press({ key: 'hk-1' }).catch(async () => m.press({ key: 'doc-open-0' }))
  await w.clock.settle()
  await m.press({ key: 'way-browser' })
  await w.clock.advance(13_000)
  expect(w.pressed.at(-1)).toEqual(expect.arrayContaining(['--ref', 'report:report']))
  // the labels list, from the summary line's `labels`; the label from its row
  w.unsure = [{ id: LABEL.id, name: LABEL.name, noFit: 1, unsure: 0, total: 1, rows: [] }]
  w.stamps.set(`${WS}/concepts`, 3)
  await w.clock.advance(1100)
  const band = (await $.ui.mount(aboveAt(120))) as unknown as M
  await band.press({ key: 'above-summary-labels' })
  await w.clock.settle()
  await band.unmount()
  await m.press({ key: 'label-open-0' })
  await w.clock.settle()
  await m.press({ key: 'way-browser' })
  await w.clock.advance(13_000)
  expect(w.pressed.at(-1)).toEqual(expect.arrayContaining(['--ref', `concept:${LABEL.id}`]))
  await m.unmount()
})
