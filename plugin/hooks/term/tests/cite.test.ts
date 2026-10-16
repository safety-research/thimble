// The citation panel: a card value's citation lit on its card, a citation whose place does not exist marked red, a value
// cited in a file lit where it stands on the page that holds its line. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { CWD, shown, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: 'thimble', component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
const PANE = { plugin: 'thimble', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: 36 }, view: {} } } as never

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

/** A reply with one citation, checked, then a click on it: the citation panel, mounted. */
async function clickCite($: E, w: World, text: string, x: number): Promise<M> {
  let ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  await w.clock.advance(300)
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  await ui.pointer({ type: 'down', x, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.pointer({ type: 'up', x, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.unmount()
  await w.clock.settle()
  return (await $.ui.mount(PANE)) as unknown as M
}

test("a card value's citation draws the card in its border with the cited cell on the selection background", { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  await start($, w)
  const pane = await clickCite($, w, 'dse has [[3908|card:ff73e071#pages/dse]] pages.', 9)
  const text = shown(await pane.drawn())
  // the `from` row names the place, so the subtitle says `found` alone (live check New 7)
  expect(shown(await pane.find({ key: 'cite-sub' }))).toBe('found')
  expect(text).toContain('card "What does the export hold per wiki?"')
  expect(JSON.stringify(await pane.drawn())).toMatch(/"backgroundColor":"selectionBg"\},"children":\["\s*3,?908\s*"\]/)
  await pane.unmount()
})

test("a citation whose place does not exist: its title red with ×, its status and reason in red", { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  await start($, w)
  const pane = await clickCite($, w, 'It has [12](README.md#L99) wikis.', 8)
  const json = JSON.stringify(await pane.drawn({ in: 'cite-title' }))
  expect(json).toContain('{"type":"Text","props":{"color":"error"},"children":[" ×"]}')
  expect(shown(await pane.drawn())).toContain('not found: README.md line 99 does not exist · the place does not resolve: line 99 out of range')
  await pane.unmount()
})

// ------------------------------------------------------------------------------------------------ a file citation's window

/** A file of 900 lines, paged as thimble pages it: 200 lines from the line `--start` names. */
const LOG = (start: number) => ({ path: 'log.txt', kind: 'text', total_lines: 900, start, records: Array.from({ length: Math.max(0, Math.min(200, 901 - start)) }, (_, i) => ({ line: start + i, record: { text: `line ${start + i} of the log` } })) })
const logLine = (n: number) => ({ line: n, record: { text: `line ${n} of the log` } })
const LOG_450 = { ref: 'log.txt#L450', kind: 'record', path: 'log.txt', line: 450, record: { text: 'line 450 of the log' }, blocks: [{ text: 'line 450 of the log' }], excerpt: 'line 450 of the log', context: { before: [447, 448, 449].map(logLine), after: [451, 452, 453].map(logLine) } }

/** The rows of a file citation's window as drawn, and its drawing. */
async function windowRows(pane: M): Promise<{ rows: string[]; json: string }> {
  const tree = await pane.drawn({ in: 'm:cite-lines' })
  return { rows: (((tree as { children?: unknown[] }).children ?? []) as unknown[]).map(r => shown(r)), json: JSON.stringify(tree) }
}

test('a value cited in a file is lit where it stands, not its whole line; the page read is the one that holds the cited line, not the file\'s first', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  w.pages['log.txt'] = LOG
  w.resolve['log.txt#L450'] = LOG_450
  await start($, w)
  const pane = await clickCite($, w, 'It names [line 450](log.txt#L450) once.', 10)
  const { json } = await windowRows(pane)
  expect(json).toContain('{"type":"Text","props":{"backgroundColor":"selectionBg"},"children":["line 450"]}')
  expect(json).not.toContain('"children":["line 450 of the log"]}')
  // the page that holds the cited line's lines was read from its start (term.ts citePage), never the file's first page
  const reads = w.calls.filter(c => c[2] === 'files' && c[5] === 'log.txt').map(c => c.slice(6).join(' '))
  expect(reads).toContain('--start 401')
  expect(reads).not.toContain('')
  await pane.unmount()
})
