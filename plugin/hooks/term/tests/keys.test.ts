// The panel's keys (live checks term-fix7, quirk 2, and term-fix8): a list's keys reach it through the relay (panel.tsx
// RELAY), whose Input holds the pane's focus ring, so ↑↓ move the ring (the ui.focus hook turns that into ↑↓ for the
// list), Enter submits it, and a letter, a digit, Space or Backspace changes its text; the hint row names only the keys
// that work. Claude Code's side is played here as it behaves (2.1.291): a pane that takes the keys raises `ui.focus` for
// its `autoFocus` element (takesKeys). Home's keys; a terminal view's keys through the relay; a word typed while home
// holds the keys reaching the prompt whole; the view proposal row's accept and reject (`thimble act view-accept|
// view-reject {slug}`). `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { RELAY, UNFOCUSED_HINT } from '../panel'
import { CWD, WS, shown, takesKeys, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const PANEL = 'thimble'
// a pane that shows every list whole
const SHORT = 120
const paneOf = (rows: number) => ({ plugin: PANEL, component: 'Pane', requestId: PANEL, surface: 'terminal', viewport: { columns: 120, rows: rows + 4 }, props: { title: 'thimble', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { bodyRows: rows }, view: {} } }) as never
const ABOVE = { plugin: PANEL, component: 'AbovePrompt', requestId: 'above', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { hasSurvey: false, isWorking: false, view: {} } } as never

// ------------------------------------------------------------------------------------------------ playing Claude Code

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

/** The ring moved by the person (↑ ↓, Tab) onto an element of the panel. */
async function ring($: E, element: string): Promise<unknown> {
  return $.ui.focus({ requestId: PANEL, component: 'Pane', element, origin: { kind: 'person' } } as never)
}

/** A drawing of the panel in a pane of `rows` body rows. */
async function look($: E, rows: number): Promise<M> {
  return (await $.ui.mount(paneOf(rows))) as unknown as M
}

/** What one drawing of the panel says: its hint row, the row the keys chose in `list`, its whole text, whether the relay
 *  and the hotkeys are drawn, and each list's rows. */
async function seen($: E, rows: number, list = ''): Promise<{ hint: string; chosen: string; text: string; relay: boolean; hotkeys: boolean; rows: string[] }> {
  const pane = await look($, rows)
  const tree = await pane.drawn()
  const lines = list ? ((((await pane.drawn({ in: `m:${list}` })) as { children?: unknown[] }).children ?? []).map(r => shown(r))) : []
  const hint = list === 'home' ? (lines.at(-1) ?? '').trim() : shown(await pane.find({ key: 'h-hints' })).trim()
  const out = {
    hint,
    chosen: lines.find(r => r.startsWith('❯'))?.slice(2).trim() ?? '',
    text: shown(tree),
    relay: Boolean(await pane.find({ type: 'Input', key: RELAY.pick })),
    hotkeys: Boolean(await pane.find({ type: 'Button', key: 'hk-close' })),
    rows: lines,
  }
  await pane.unmount()
  return out
}

/** The text the relay's Input holds as drawn: its mark (the test's own import of panel.tsx is another instance of the
 *  module than the plugin's, so its relayValue says nothing of the drawing). */
async function relayText(pane: M): Promise<string> {
  const el = (await pane.find({ type: 'Input', key: RELAY.pick })) as { props?: { value?: string } } | undefined
  expect(el).toBeDefined()
  return el?.props?.value ?? ''
}

/** A key the relay's Input takes while it holds the ring: Enter submits it; a letter, a digit or Space is a change. */
async function enter($: E, w: World, rows: number): Promise<void> {
  const pane = await look($, rows)
  await pane.input({ key: RELAY.pick, text: await relayText(pane) })
  await w.clock.settle()
  await pane.unmount()
}
async function type($: E, w: World, rows: number, ch: string): Promise<void> {
  const pane = await look($, rows)
  await pane.input({ key: RELAY.pick, text: `${await relayText(pane)}${ch}`, kind: 'change' })
  await w.clock.settle()
  await pane.unmount()
}
async function backspace($: E, w: World, rows: number): Promise<void> {
  const pane = await look($, rows)
  await pane.input({ key: RELAY.pick, text: '', kind: 'change' })
  await w.clock.settle()
  await pane.unmount()
}
/** ↓ and ↑ `n` times, each on the panel as drawn (a key acts on the list the pane shows). */
async function down($: E, w: World, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await (await look($, SHORT)).unmount()
    expect(await ring($, RELAY.down)).toEqual({})
    await w.clock.settle()
  }
}
async function up($: E, w: World, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await (await look($, SHORT)).unmount()
    expect(await ring($, RELAY.up)).toEqual({})
    await w.clock.settle()
  }
}

/** A click on the row of `list` that shows `text` (every word of it), as the pointer over the list's Client; with '', a
 *  click on no hit: the margin of its last row, where no row's hit reaches. */
async function click($: E, w: World, rows: number, list: string, text: string, ...more: string[]): Promise<void> {
  const pane = await look($, rows)
  const lines = (((await pane.drawn({ in: `m:${list}` })) as { children?: unknown[] }).children ?? []).map(r => shown(r))
  const y = text ? lines.findIndex(r => [text, ...more].every(t => r.includes(t))) : lines.length - 1
  expect(y).toBeGreaterThanOrEqual(0)
  await pane.pointer({ type: 'down', x: text ? 6 : 0, y, button: 'left', in: `m:${list}` } as never)
  await w.clock.settle()
  await pane.unmount()
}

/** A hotkey of a panel with no list, as Claude Code presses its Button (no Input holds the ring there). */
async function hotkey($: E, w: World, key: string): Promise<void> {
  const pane = await look($, SHORT)
  await pane.press({ key: `hk-${key}` })
  await w.clock.settle()
  await pane.unmount()
}

/** The hint names only keys among `keys` (and the way's): never ←, →, PgUp or PgDn. */
function named(hint: string, keys: string[]): void {
  for (const k of keys) expect(hint).toContain(k)
  expect(hint).not.toMatch(/←|→|PgUp|PgDn|click the panel/)
}

// ------------------------------------------------------------------------------------------------ home

test('keys · home · /thimble: ↑↓ choose and the choice stays in view, Enter opens, Space folds, x closes', { timeoutMs: 30_000 }, async ($, on) => {
  const rows = SHORT
  const w = world(on)
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  let s = await seen($, rows, 'home')
  named(s.hint, ['↑↓ to choose', 'Enter to open', 'Space to fold', 'x to close'])
  expect(s.relay && s.hotkeys).toBe(true)
  // SPEC-v2 J4: Coverage is home's first section, so its row is the first chosen
  expect(s.chosen).toContain('saw 10% of records')
  // ↓ eleven times: past the first rows of a tall pane, the choice still shows, as does the hint row
  await down($, w, 11)
  s = await seen($, rows, 'home')
  expect(s.chosen).not.toContain('saw 10% of records')
  expect(s.chosen).not.toBe('')
  expect(s.hint).toContain('↑↓ to choose')
  await up($, w, 11)
  expect((await seen($, rows, 'home')).chosen).toContain('saw 10% of records')
  // Space on the card group's row folds it: Coverage's row, the label, two threads, then the group
  await down($, w, 4)
  expect((await seen($, rows, 'home')).chosen).toContain('Your work')
  await type($, w, rows, ' ')
  s = await seen($, rows, 'home')
  expect(s.rows.join('\n')).not.toContain('Who acted on what?')
  expect(s.chosen).toContain('Your work')
  await type($, w, rows, ' ')
  expect((await seen($, rows, 'home')).rows.join('\n')).toContain('Who acted on what?')
  // Enter opens the chosen row: the group's row folds; on a card it opens the card
  await down($, w, 1)
  await enter($, w, rows)
  expect((await seen($, rows)).text).toMatch(/home › card "What does the export hold/)
  // x closes: the card's own Button's hotkey (no list there), and from home the relay's field
  await hotkey($, w, 'close')
  expect(w.closed).toContain(PANEL)
  w.closed.length = 0
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  await type($, w, rows, 'x')
  expect(w.closed).toContain(PANEL)
})

test('keys · home · a word typed while home holds the keys reaches the prompt whole: `t` opens no threads', { timeoutMs: 30_000 }, async ($, on) => {
  // live check term-fix10, new quirk 4 and the typing race (fb133749): `table` typed while home held the keys opened the
  // threads at its `t`, and main's prompt got `able`
  const w = world(on)
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  const pane = await look($, SHORT)
  expect(await pane.find({ type: 'Button', key: 'hk-threads' })).toBeUndefined()
  await pane.unmount()
  await type($, w, SHORT, 't')
  expect(w.filled).toEqual(['t'])
  // home still: its sections, no threads panel's tree
  const s = await seen($, SHORT, 'home')
  expect(s.rows.join('\n')).toContain('Documents (')
  expect(s.text).not.toMatch(/home › threads/)
  expect(s.hint).toBe(UNFOCUSED_HINT)
})

// ------------------------------------------------------------------------------------------------ a terminal view
//
// A view built in terminal mode (term: true) is drawn by its program (hooks/viewhost.ts), which thimble's view host
// runs; the test plays the host (fixtures.ts `viewHost`): its first frame, the next one per key, and the acts it asks.

const TERM_VIEWS = [{ slug: 'timeline', name: 'Timeline', status: 'built', ts: '2026-10-07T02:00:00Z', files: ['agents.log'], term: true }]

async function openTermView($: E, w: World): Promise<void> {
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  await click($, w, SHORT, 'home', 'Views (1)')
  await takesKeys($)
  await enter($, w, SHORT)
  // the panel draws the view, and the session's timer starts the host and opens it (viewhost.ts viewPump)
  await (await look($, SHORT)).unmount()
  await w.clock.advance(300)
  await w.clock.advance(300)
  await takesKeys($)
}

const events = (w: World) => w.viewHost.requests.filter(r => r.path === '/event').map(r => r.body.event as Record<string, unknown>)

/** The rows the view's Client draws (hooks/viewclient.tsx), as text. */
async function viewRows($: E): Promise<string[]> {
  const pane = await look($, SHORT)
  const rows = (((await pane.drawn({ in: 'm:view-frame' })) as { children?: unknown[] }).children ?? []).map(r => shown(r))
  await pane.unmount()
  return rows
}

test('keys · view · a terminal view: its rows under the header, its hint row, ↑↓ and Enter through the relay, its letters and signs as hotkeys, Backspace though no hint names it', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  w.states.home = { ...w.states.home, views: TERM_VIEWS } as never
  await openTermView($, w)
  expect(w.viewHost.started).toBe(1)
  const open = w.viewHost.requests.find(r => r.path === '/open')
  expect(open?.body).toMatchObject({ slug: 'timeline' })
  expect(Number(open?.body.cols)).toBeGreaterThan(30)
  const s = await seen($, SHORT)
  expect(s.text).toContain('Timeline')
  expect((await viewRows($)).join('\n')).toMatch(/Color by\s*Kind\n❯ ● first row\n  ● second row/)
  expect(s.hint).toBe('↑↓ to choose · Enter to open · ? for all keys · b to go back · x to close')
  expect(s.relay).toBe(true)
  // ↓ through the relay is the view's `down`; its next frame chooses the second row
  await down($, w)
  expect(events(w).at(-1)).toMatchObject({ t: 'key', key: 'down' })
  expect(await viewRows($)).toContain('❯ ● second row')
  // a letter and a sign the view binds go to it from the relay's field
  await type($, w, SHORT, 'c')
  expect(events(w).at(-1)).toMatchObject({ t: 'key', key: 'c' })
  await type($, w, SHORT, '?')
  expect(events(w).at(-1)).toMatchObject({ t: 'key', key: '?' })
  // Backspace the view binds reaches it through the relay, though its hint row does not name it
  await backspace($, w, SHORT)
  expect(events(w).at(-1)).toMatchObject({ t: 'key', key: 'backspace' })
  // Enter is the view's `return`
  await enter($, w, SHORT)
  expect(events(w).at(-1)).toMatchObject({ t: 'key', key: 'return' })
  // a letter it does not bind goes to the prompt, as on every panel
  await type($, w, SHORT, 'q')
  expect(w.filled).toContain('q')
  expect(events(w).some(e => e.key === 'q')).toBe(false)
})

// ------------------------------------------------------------------------------------------------ the view proposal

const OFFER = { slug: 'edit-bursts', name: 'Edit Bursts', description: 'Each wiki page as a strip of its saves.', task: 'Find out when the agents edited together.', claims: ['revisions.jsonl'] }

async function above($: E): Promise<M> {
  return (await $.ui.mount(ABOVE)) as unknown as M
}

test('the view proposal row · accept and reject hand the answer to thimble (`thimble act view-accept|view-reject {slug}`); the row says so until home is read again; one thimble refuses is a toast and the controls come back', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  w.states.home = { ...w.states.home, offer: OFFER }
  await start($, w)
  let row = await above($)
  await row.press({ key: 'above-offer-accept' })
  await w.clock.settle()
  expect(w.acts.at(-1)).toEqual({ kind: 'view-accept', payload: { slug: 'edit-bursts' } })
  await row.unmount()
  row = await above($)
  expect(shown(await row.find({ type: 'Box', key: 'above-offer' }))).toContain('◌ accepting')
  expect(await row.find({ type: 'Button', key: 'above-offer-accept' })).toBeUndefined()
  await row.unmount()
  // thimble wrote the answer: the proposal no longer waits, and home's state read again has none
  w.states.home = { ...w.states.home, offer: null }
  w.stamps.set(`${WS}/views/proposals.json`, 2)
  await w.clock.advance(1100)
  row = await above($)
  expect(await row.find({ type: 'Box', key: 'above-offer' })).toBeUndefined()
  await row.unmount()
  // a new proposal, rejected; one thimble refuses (it no longer waits) is a toast, and the controls come back
  w.states.home = { ...w.states.home, offer: { ...OFFER, slug: 'board-threads', name: 'Board Threads' } }
  w.stamps.set(`${WS}/views/proposals.json`, 3)
  await w.clock.advance(1100)
  w.refuse = { 'view-reject': "the view proposal 'Board Threads' no longer waits" }
  row = await above($)
  await row.press({ key: 'above-offer-reject' })
  await w.clock.settle()
  expect(w.acts.at(-1)).toEqual({ kind: 'view-reject', payload: { slug: 'board-threads' } })
  expect(w.toasts.at(-1)).toBe("thimble: the view proposal 'Board Threads' no longer waits")
  await row.unmount()
  row = await above($)
  expect(await row.find({ type: 'Button', key: 'above-offer-reject' })).toBeDefined()
  await row.unmount()
})
