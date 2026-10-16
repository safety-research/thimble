// A document's passage asked about: its "?" asks a thread told the document, its section and the passage.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, DOC, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const PANE = { plugin: 'thimble', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 36 }, view: {} } } as never

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

/** Home, then a click on the row that shows `text`; the panel drawn again. */
async function fromHome($: E, w: World, text: string): Promise<M> {
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  let pane = (await $.ui.mount(PANE)) as unknown as M
  const rows = ((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []
  await pane.pointer({ type: 'down', x: 4, y: rows.findIndex(r => shown(r).includes(text)), button: 'left', in: 'm:home' } as never)
  await w.clock.settle()
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  return pane
}

test("a passage's \"?\" in a document asks a thread told the document, its section and the passage", { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  await start($, w)
  const pane = await fromHome($, w, DOC.title)
  const ask = ((await pane.findAll({ type: 'Button' })) as { key?: string }[]).find(b => /^ask-d1-/.test(String(b.key)) && !/-0$/.test(String(b.key)))!
  await pane.press({ key: ask.key! })
  await w.clock.settle()
  await pane.unmount()
  const asked = (await $.ui.mount(PANE)) as unknown as M
  await asked.input({ key: 'ask-new', text: 'Which week?' })
  await w.clock.settle()
  expect(w.acts.find(a => a.kind === 'thread')!.payload).toMatchObject({ anchor: 'report:report#s2', anchor_text: `"${DOC.title}" › The main claim: One week of June holds most saves.`, element: 'report:report#s2' })
  await asked.unmount()
})

