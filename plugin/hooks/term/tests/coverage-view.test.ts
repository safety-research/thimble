// The Coverage view (coverageview.tsx, SPEC-v2 J5): its rows from `thimble state coverage --session <sid>` (C7), grouped
// by folder and type with records first and files in brackets; Enter drills into a folder (the same view one level down)
// and b comes back; a level of 20 files or fewer lists its files, and Enter opens one in 0.8.0's file view; o and the
// title row's ↗ open Files in the browser at the folder. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { coverageBar, drillFolder, sizeWords } from '../coverageview'
import { CWD, PANEL, SUMMARY, paneAt, panelWorld, takesKeys, words } from './fixtures-panel'
import type { PanelWorld } from './fixtures-panel'

type M = Mounted<'terminal'>
type E = Engine

async function start($: E, w: PanelWorld): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

async function pane($: E): Promise<M> {
  return (await $.ui.mount(paneAt(96))) as unknown as M
}

/** The panel's rows of text as its lists' Clients draw them. */
async function listText(m: M, key: string): Promise<string[]> {
  const el = (await m.find({ type: 'Client', key })) as unknown as { props: { props: { lines: { s: string }[][] } } } | undefined
  return (el?.props.props.lines ?? []).map(l => l.map(x => x.s).join('').replace(/\s+$/, ''))
}

test('the coverage view lists its rows: folder and type, records first, files in brackets, a bar, the size; a folder drills in, b comes back', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.coverageSummary = SUMMARY
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'coverage' } as never)
  await w.clock.settle()
  const m = await pane($)
  await takesKeys($)
  const top = await listText(m, 'm:coverage-list')
  expect(top[0]).toMatch(/^ {4}folder and type +records +files +seen searched never +size$/)
  expect(top[1]).toMatch(/^❯ ▸ agents\/ +\.jsonl +1,204 of 48,310 +\(2 of 12\) +[█▓░]{20} +1\.2 MB$/)
  expect(top[2]).toMatch(/^ {4}\. +\.jsonl +140 of 140 +\(1 of 1\) +█{20} +40 KB$/)
  expect(top[3]).toMatch(/^ {4}\. +\.db +– +\(0 of 1\) +░{20} +2\.1 MB$/)
  expect(top.at(-1)).toBe('    seen ■  searched ■  never ■')
  // the summary under the subtitle, and the call with this session's id
  expect(words(await m.drawn())).toContain('saw 3% of records (3 of 13 files)')
  expect(w.calls.find(c => c[1] === 'state' && c[2] === 'coverage')).toEqual(expect.arrayContaining(['--session']))
  // Enter on the folder: one level down, its files
  await $.ui.input({ plugin: PANEL, key: 'keys-pick', text: '', kind: 'submit' } as never)
  await w.clock.settle()
  expect(w.calls.at(-1)).toEqual(expect.arrayContaining(['coverage', '--folder', 'agents']))
  const files = await listText(m, 'm:coverage-list')
  expect(files[0]).toMatch(/^ {4}file +records/)
  expect(files.slice(1, 4).map(r => r.replace(/^. /, '').trim().split(/\s+/)[0])).toEqual(['agent-01.jsonl', 'agent-02.jsonl', 'agent-03.jsonl'])
  expect(words(await m.find({ type: 'Box', key: 'way' }))).toContain('home › coverage › agents/')
  // b: back at the top
  await m.press({ key: 'hk-back' })
  await w.clock.settle()
  expect((await listText(m, 'm:coverage-list'))[1]).toContain('agents/')
  await m.unmount()
})

test('Enter on a file opens 0.8.0\'s file view; o and the title row\'s ↗ open Files in the browser at the folder', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'coverage agents' } as never)
  await w.clock.settle()
  const m = await pane($)
  await m.press({ key: 'hk-browser' })
  await w.clock.settle()
  expect(w.pressed.at(-1)).toEqual(expect.arrayContaining(['open', '--ref', 'files:agents']))
  await m.press({ key: 'way-browser' })
  await w.clock.settle()
  // the second press within 5 s of the first on the same object opens nothing more
  expect(w.pressed.length).toBe(1)
  await takesKeys($)
  await $.ui.input({ plugin: PANEL, key: 'keys-pick', text: '', kind: 'submit' } as never)
  await w.clock.settle()
  const p = w.panes.at(-1)!
  expect(p.title).toBe('agent-01.jsonl')
  await m.unmount()
})

test('the rows\' parts: a folder joined under the level shown, a bar by its shares, a size in words', () => {
  expect(drillFolder('', { folder: 'agents/' })).toBe('agents')
  expect(drillFolder('runs', { folder: 'r1/' })).toBe('runs/r1')
  expect(drillFolder('runs', { folder: 'runs/r1/' })).toBe('runs/r1')
  const bar = coverageBar({ seen: 2, searched: 1, never: 9, files: 12 })
  expect(bar.map(x => x.s).join('')).toBe('███▓▓░░░░░░░░░░░░░░░')
  expect(sizeWords(1_200_000)).toBe('1.2 MB')
  expect(sizeWords(40_000)).toBe('40 KB')
})
