// A terminal view's frame as its Client paints it (hooks/viewclient.tsx): a frame whose text holds a control character
// draws without it. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { RELAY } from '../panel'
import { CWD, shown, takesKeys, viewFrame, world } from './fixtures'
import type { World } from './fixtures'

const PANEL = 'thimble'
const ROWS = 120
const paneOf = { plugin: PANEL, component: 'Pane', requestId: PANEL, surface: 'terminal', viewport: { columns: 120, rows: ROWS + 4 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: ROWS }, view: {} } } as never
const VIEWS = [{ slug: 'wiki-page-history', name: 'Wiki Page History', status: 'built', ts: '2026-10-08T00:14:48Z', files: ['revisions.jsonl'], term: true }]
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

const look = async ($: Engine) => (await $.ui.mount(paneOf)) as unknown as Mounted<'terminal'>

/** The panel on the view, its program's first frame drawn: home, Views, Enter, as the analyst opens it. */
async function openView($: Engine, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  let pane = await look($)
  const rows = (((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r))
  const y = rows.findIndex(r => r.includes('Views (1)'))
  expect(y).toBeGreaterThanOrEqual(0)
  await pane.pointer({ type: 'down', x: 6, y, button: 'left', in: 'm:home' } as never)
  await w.clock.settle()
  await pane.unmount()
  await takesKeys($)
  pane = await look($)
  const relay = (await pane.find({ type: 'Input', key: RELAY.pick })) as { props?: { value?: string } } | undefined
  await pane.input({ key: RELAY.pick, text: relay?.props?.value ?? '' })
  await w.clock.settle()
  await pane.unmount()
  // the panel draws the view, and the session's timer starts the host and opens it (viewhost.ts viewPump)
  await (await look($)).unmount()
  await w.clock.advance(300)
  await w.clock.advance(300)
  await takesKeys($)
}

// a revision of the collusion wiki as its history drew it: a body decoded twice holds C1 characters (`â\u0080\u009d`
// for `”`), and any record's text can hold a tool's colors, a bell or a NUL
const DIRTY = viewFrame(0, {
  lines: [
    [{ s: '  ' }, { s: 'Color by', d: true }, { s: '  ' }, { s: 'Wiki' }],
    [{ s: '❯ ', fg: 'suggestion' }, { s: '●', fg: '#1d7fc0' }, { s: ' Meine Ã\u0084nderungen â\u0080\u009dokâ\u0080\u009d', fg: 'suggestion' }],
    [{ s: '  ' }, { s: '●', fg: '#1d7fc0' }, { s: ' \u001b[31mred\u001b[0m bell\u0007 page\u0000name\ttab' }],
    [{ s: '  ' }, { s: 'third row' }],
  ],
  hits: [{ y: 0, x0: 12, x1: 16, tip: 'choose \u001b[1mwhat\u001b[0m colors\u0007' }, { y: 1, x0: 2, x1: 40, row: true }, { y: 2, x0: 2, x1: 40, row: true }],
  hints: ['↑↓ to choose', 'Enter to open\u0007', '? for all keys'],
  sub: ['4,579 pages\u001b[K', 'dse\u0000'],
})

test("keys · view · a frame whose text holds an escape sequence, a bell, a NUL or a C1 character draws without them: its rows, its tips, its hint row and its facts", { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  w.states.home = { ...w.states.home, views: VIEWS } as never
  w.viewHost.frame = () => DIRTY
  await openView($, w)
  const pane = await look($)
  // the Client draws (a text that held a control character would not validate, and the view would not draw)
  const rowsOf = async () => (((await pane.drawn({ in: 'm:view-frame' })) as { children?: unknown[] }).children ?? []).map(r => shown(r))
  const rows = await rowsOf()
  const text = shown(await pane.drawn())
  // the pointer over Color by: its tip on the row below
  await pane.pointer({ type: 'move', x: 13, y: 0, in: 'm:view-frame' } as never)
  const tipped = await rowsOf()
  await pane.unmount()
  expect(rows.slice(0, 4)).toEqual(['  Color by  Wiki', '❯ ● Meine Ãnderungen âokâ', '  ● red bell pagename tab', '  third row'])
  expect(tipped[1]).toContain(' choose what colors ')
  for (const s of [...rows, ...tipped, text]) expect(s).not.toMatch(CONTROL)
  expect(text).toContain('Enter to open')
  expect(text).toContain('4,579 pages')
})
