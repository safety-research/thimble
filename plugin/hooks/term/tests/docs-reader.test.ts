// Documents in the terminal, read only (SPEC-v2 J4, 3.14): Enter on the documents list opens 0.8.0's reader; no key or
// mode edits it; `edit in the browser ↗`, `o` and the title row's `↗` open it in the browser (`report:<slug>`), where it
// is written and edited; on the list, `↗` opens the chosen document. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, PANEL, paneAt, panelWorld, takesKeys, words } from './fixtures-panel'
import type { PanelWorld } from './fixtures-panel'

type M = Mounted<'terminal'>
type E = Engine

const T = { timeoutMs: 30_000 }

async function start($: E, w: PanelWorld): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

test('Enter on a document opens the reader, read only: no edit key, no edit control, no edit mode; `edit in the browser ↗` and `↗` open it in the browser', T, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'documents' } as never)
  await w.clock.settle()
  let m = (await $.ui.mount(paneAt(96))) as unknown as M
  // on the list, ↗ opens the chosen document
  await m.press({ key: 'way-browser' })
  await w.clock.advance(13_000)
  expect(w.pressed.at(-1)).toEqual(expect.arrayContaining(['--ref', 'report:report']))
  await takesKeys($)
  await m.unmount()
  m = (await $.ui.mount(paneAt(96))) as unknown as M
  await m.input({ key: 'keys-pick', text: '' } as never)
  await w.clock.settle()
  await m.unmount()
  await w.clock.advance(1100)
  m = (await $.ui.mount(paneAt(96))) as unknown as M
  const text = words(await m.drawn())
  expect(w.panes.at(-1)!.title).toBe('Agents used the dse wiki as a relay')
  expect(text).toContain('edit in the browser ↗')
  expect(text).toContain('o to edit in the browser')
  expect(text).not.toContain('e to edit')
  expect(await m.find({ type: 'Button', key: 'hk-edit' })).toBeUndefined()
  expect(await m.find({ type: 'Button', key: 'doc-edit' })).toBeUndefined()
  expect(await m.find({ type: 'Client', key: 'doc-editor-report' })).toBeUndefined()
  // `e` is no key of the reader's: no Button in its drawing takes it
  expect(JSON.stringify(await m.drawn())).not.toContain('"hotkey":"e"')
  await m.unmount()
  m = (await $.ui.mount(paneAt(96))) as unknown as M
  await m.press({ key: 'doc-browser' })
  await w.clock.advance(13_000)
  await m.press({ key: 'way-browser' })
  await w.clock.advance(13_000)
  expect(w.pressed.slice(-2).map(a => a[a.indexOf('--ref') + 1])).toEqual(['report:report', 'report:report'])
  await m.unmount()
  void PANEL
})
