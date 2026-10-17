// A terminal view whose frame is too large for one Client's props (Claude Code takes at most 100,000 characters) is
// still drawn: its lanes' cells' words go first, then its regions, then its last rows, and the panel never stands blank
// with the keys gone to the prompt (bug hunt J12: a lane view of 2,000 one-cell regions, 280,000 characters, drew
// nothing for minutes). `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CLIENT_PROPS_MAX, viewProps } from '../viewhost'
import type { ViewFrame } from '../viewhost'
import { CWD, shown, takesKeys, viewFrame, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const PANEL = 'thimble'
const ROWS = 60
const PANE = { plugin: PANEL, component: 'Pane', requestId: PANEL, surface: 'terminal', viewport: { columns: 120, rows: ROWS + 4 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: ROWS }, view: {} } } as never
const TERM_VIEWS = [{ slug: 'lanes', name: 'Agent Lanes', status: 'built', ts: '2026-10-07T02:00:00Z', files: ['runs/*.jsonl'], term: true }]

/** A lane view's frame: a row per agent, each minute of its shift a one-cell region with its own words, as a view's
 *  program draws one (`row.add(glyph, style, { cursor: true, tip, on })` per minute). */
function laneFrame(agents: number, minutes: number): ViewFrame {
  const base = viewFrame(0) as unknown as ViewFrame
  const lines = Array.from({ length: agents }, (_, a) => [{ s: `  agent-${String(a).padStart(2, '0')}  ` }, { s: '█▓▒░'.repeat(minutes / 4), fg: '#1d7fc0' }])
  const hits = Array.from({ length: agents }, (_, a) =>
    Array.from({ length: minutes }, (_, m) => ({ y: a, x0: 12 + m, x1: 13 + m, cursor: true, tip: `agent-${String(a).padStart(2, '0')} · minute ${m} · testing in the sandbox` })),
  ).flat()
  return { ...base, lines, hits }
}

test("a frame too large for a Client keeps within its props: the regions' words are cut to one length first, every region keeping the start of its own", () => {
  const big = laneFrame(30, 72)
  expect(JSON.stringify({ lines: big.lines, hits: big.hits, seq: 1, cols: 98 }).length).toBeGreaterThan(CLIENT_PROPS_MAX)
  const fit = viewProps(big, 98)
  expect(JSON.stringify(fit.props).length).toBeLessThanOrEqual(CLIENT_PROPS_MAX)
  expect(fit.props.lines).toHaveLength(30)
  // a small frame goes whole
  const small = viewFrame(0) as unknown as ViewFrame
  expect(viewProps(small, 98)).toEqual({ props: { lines: small.lines, hits: small.hits, seq: small.seq, cols: 98 }, cut: '' })
  // a lane of 72 cells as one region (term_kit chartRegions), its words too long: every region and every cell keeps
  // the start of its words, cut with `…`; a short word stays whole
  const merged: ViewFrame = { ...small, hits: [{ y: 0, x0: 2, x1: 8, tip: 'pick' }, ...Array.from({ length: 30 }, (_, a) => ({ y: a, x0: 12, x1: 84, cursor: true, tips: Array.from({ length: 72 }, (_, m) => `agent ${a} · minute ${m} · ${'x'.repeat(40)}`) }))] }
  const kept = viewProps(merged, 98)
  expect(kept.cut).toBe('tips')
  expect(kept.props.hits).toHaveLength(31)
  expect(kept.props.hits[0]!.tip).toBe('pick')
  expect(kept.props.hits.slice(1).every(h => h.tips?.length === 72 && h.tips.every(t => t.startsWith('agent ') && t.endsWith('…')))).toBe(true)
  expect(JSON.stringify(kept.props).length).toBeLessThanOrEqual(CLIENT_PROPS_MAX)
})

test('the panel draws a lane view whose frame holds 2,000 one-cell regions: its header, its rows and its hint row, and keeps the keys', { timeoutMs: 30_000 }, async ($, on) => {
  const w: World = world(on)
  w.states.home = { ...w.states.home, views: TERM_VIEWS } as never
  w.viewHost.frame = () => laneFrame(30, 72) as never
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  let pane = (await $.ui.mount(PANE)) as unknown as M
  const rows = ((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []
  const y = rows.findIndex(r => shown(r).includes('Agent Lanes'))
  expect(y).toBeGreaterThan(0)
  await pane.pointer({ type: 'down', x: 6, y, button: 'left', in: 'm:home' } as never)
  await w.clock.settle()
  await pane.unmount()
  // the panel draws the view, and the session's timer starts the host and opens it (viewhost.ts viewPump)
  await w.clock.advance(300)
  await w.clock.advance(300)
  await takesKeys($)
  pane = (await $.ui.mount(PANE)) as unknown as M
  const text = shown(await pane.drawn())
  expect(text).toContain('Agent Lanes')
  expect(text).toContain('↑↓ to choose · Enter to open')
  const frame = (await pane.find({ type: 'Client' })) as { props?: { props?: unknown } } | undefined
  expect(frame).toBeDefined()
  expect(JSON.stringify(frame!.props!.props).length).toBeLessThanOrEqual(CLIENT_PROPS_MAX)
  const drawn = (((await pane.drawn({ in: 'm:view-frame' })) as { children?: unknown[] }).children ?? []).map(r => shown(r))
  expect(drawn[0]).toContain('agent-00')
  expect(drawn.at(-1)).toContain('agent-29')
  await pane.unmount()
})
