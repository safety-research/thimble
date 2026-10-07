// The panel's keys, panel by panel, in each way a panel opens and in a pane short and tall (live checks term-fix7,
// quirk 2, and term-fix8, quirks 1, 2 and 7): a list's keys reach it through the relay (panel.tsx RELAY), whose Input
// holds the pane's focus ring, so ↑↓ move the ring (the ui.focus hook turns that into ↑↓ for the list), Enter submits
// it, and a letter, a digit, Space or Backspace changes its text; the hint row names only the keys that work. Claude
// Code's side is played here as it behaves (2.1.291): a pane that takes the keys raises `ui.focus` for its `autoFocus`
// element (takesKeys); Esc gives the prompt the keys (the pane's isFocused turns false); ← reaches no element.
//
//   panel        ways opened                                   keys
//   home         toast, /thimble, empty click, after Esc       ↑↓ Enter Space x, an unbound letter, short and tall
//   threads      /thimble threads, a heading click             ↑↓ (opens the first), 1-9, x
//   thread       a row click, after Esc                        ↑↓ Enter a s b x
//   labels       a heading click, empty click                  ↑↓ Enter 1-9 b x, short and tall
//   documents    /thimble documents                            ↑↓ Enter 1-9 x
//   files        /thimble files, a row click, empty click      ↑↓ Enter Space b x, short and tall
//   file         a row click, /thimble files <path>            ↑↓ Enter Backspace 1-3 x, short and tall; never ←
//   views        a heading click                               ↑↓ Enter 1-9 b x
//   view         a terminal view from the views list           ↑↓ Enter, its letters and signs, a click, a drag, the
//                                                              wheel, every key while its field takes typing
//   card, label, document, ask: no list                      their letters; no ↑↓, Enter, Space or ← named
//
// `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { RELAY, UNFOCUSED_HINT } from '../hooks/panel'
import { CWD, WS, shown, takesKeys, viewFrame, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const PANEL = 'thimble-term'
// a pane that shows every list whole, and one shorter than home, the file browser and a file's lines
const SHORT = 120
const TALL = 14
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

/** Esc: the prompt has the keys; the panel names none of its own and says how to give it them. A click on the panel's
 *  list gives them back (term.ts takeKeys), and its ring goes onto the relay again as the pane takes them. */
async function escAndBack($: E, w: World, rows: number, list: string): Promise<void> {
  w.paneFocused = false
  const away = await seen($, rows, list)
  expect(away.hint).toBe(UNFOCUSED_HINT)
  w.grantOnReopen = true
  w.focusAsked.length = 0
  await click($, w, rows, list, '')
  expect(w.focusAsked).toContain(true)
  expect(w.paneFocused).toBe(true)
  await takesKeys($)
  await w.clock.advance(300)
}

/** The ring onto the selected thread's follow-up field, as Claude Code moves it for the panel's own `$.ui.focus`. */
async function askField($: E): Promise<void> {
  const pane = await look($, SHORT)
  const field = ((await pane.findAll({ type: 'Input' })) as { key?: string }[]).find(i => /^ask-/.test(String(i.key)))
  await pane.unmount()
  expect(field).toBeDefined()
  await $.ui.focus({ requestId: PANEL, component: 'Pane', element: field!.key, origin: { kind: 'plugin', name: PANEL } } as never)
}

/** The hint names only keys among `keys` (and the way's): never ←, →, PgUp or PgDn. */
function named(hint: string, keys: string[]): void {
  for (const k of keys) expect(hint).toContain(k)
  expect(hint).not.toMatch(/←|→|PgUp|PgDn|click the panel/)
}

// ------------------------------------------------------------------------------------------------ home

for (const rows of [SHORT, TALL]) {
  const size = rows === SHORT ? 'short' : 'tall'

  test(`keys · home · /thimble · ${size}: ↑↓ choose and the choice stays in view, Enter opens, Space folds, x closes`, async ($, on) => {
    const w = world(on)
    await start($, w)
    await $.command.run({ command: 'thimble:thimble', args: '' } as never)
    await w.clock.settle()
    await takesKeys($)
    let s = await seen($, rows, 'home')
    named(s.hint, ['↑↓ to choose', 'Enter to open', 'Space to fold', 'x to close'])
    expect(s.relay && s.hotkeys).toBe(true)
    expect(s.chosen).toContain('Agents used the dse wiki as a relay')
    if (rows === TALL) {
      // cut to the pane: the hint row is the last, a count row says what is below
      expect(s.rows.length).toBeLessThanOrEqual(rows - 1)
      expect(s.rows.some(r => /↓ \d+ more/.test(r))).toBe(true)
    }
    // ↓ eleven times: past the first rows of a tall pane, the choice still shows, as does the hint row
    await down($, w, 11)
    s = await seen($, rows, 'home')
    expect(s.chosen).not.toContain('Agents used the dse wiki')
    expect(s.chosen).not.toBe('')
    expect(s.hint).toContain('↑↓ to choose')
    if (rows === TALL) expect(s.rows.some(r => /↑ \d+ more/.test(r))).toBe(true)
    await up($, w, 11)
    expect((await seen($, rows, 'home')).chosen).toContain('Agents used the dse wiki as a relay')
    // Space on the card group's row folds it
    await down($, w, 3)
    expect((await seen($, rows, 'home')).chosen).toContain('Your work')
    await type($, w, rows, ' ')
    s = await seen($, rows, 'home')
    expect(s.rows.join('\n')).not.toContain('Who acted on what?')
    expect(s.chosen).toContain('Your work')
    await type($, w, rows, ' ')
    expect((await seen($, rows, 'home')).rows.join('\n')).toContain(rows === SHORT ? 'Who acted on what?' : 'What does the export hold')
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

  test(`keys · home · toast · ${size}: open › gives the panel the keys, the new card's group unfolded and the card chosen; the toast hides while home shows`, async ($, on) => {
    // live check term-fix8, quirk 6
    const w = world(on)
    await start($, w)
    // a second group, newer, holds the two new cards; the first group stays the default open one
    w.states.cards = { ...w.states.cards, groups: [...w.states.cards.groups, { id: 'g2', title: 'Deletions', role: 'analyst', ts: '2026-10-06T08:00:00+00:00' }] }
    for (const c of Object.values(w.cells) as Record<string, unknown>[]) Object.assign(c, { created_ts: '2026-09-01T00:00:00+00:00', ts: '2026-09-01T00:00:00+00:00' })
    const made = new Date(1_790_000_000_000 + 60_000).toISOString()
    ;(w.cells as Record<string, Record<string, unknown>>).n1new000 = { ...w.cells.k0code00, id: 'n1new000', notebook: 'g2', title: 'When were pages deleted?', created_ts: made, ts: made }
    ;(w.cells as Record<string, Record<string, unknown>>).n2new000 = { ...w.cells.k0code00, id: 'n2new000', notebook: 'g2', title: 'Who deleted them?', created_ts: made, ts: made }
    w.states.home = { ...w.states.home, cards: 14 }
    w.stamps.set(`${WS}/notebooks`, 2)
    await w.clock.advance(61_000)
    w.paneFocused = false
    w.grantOnReopen = true
    let above = (await $.ui.mount(ABOVE)) as unknown as M
    expect(shown(await above.drawn())).toContain('2 new cards')
    await above.press({ key: 'above-home-open' })
    await above.unmount()
    await w.clock.advance(300)
    expect(w.paneFocused).toBe(true)
    await takesKeys($)
    const s = await seen($, rows, 'home')
    named(s.hint, ['↑↓ to choose', 'Enter to open', 'Space to fold'])
    expect(s.chosen).toContain('When were pages deleted?')
    expect(s.rows.find(r => r.includes('When were pages deleted?'))).toMatch(/new$/)
    // the toast hides while home shows, and what arrives meanwhile is seen
    w.states.home = { ...w.states.home, cards: 15 }
    w.stamps.set(`${WS}/notebooks`, 3)
    await w.clock.advance(1100)
    above = (await $.ui.mount(ABOVE)) as unknown as M
    expect(shown(await above.drawn())).not.toContain('new card')
    await above.unmount()
    await down($, w)
    expect((await seen($, rows, 'home')).chosen).toContain('Who deleted them?')
    await enter($, w, rows)
    expect((await seen($, rows)).text).toMatch(/card "Who deleted them\?"/)
  })

  test(`keys · home · empty click and after Esc · ${size}: the keys come back to the pane; an unbound letter goes to the prompt`, async ($, on) => {
    const w = world(on)
    await start($, w)
    await $.command.run({ command: 'thimble:thimble', args: '' } as never)
    await w.clock.settle()
    await takesKeys($)
    // a click on an empty row gave the list's Client the keys: the pane takes them back
    w.focusAsked.length = 0
    await click($, w, rows, 'home', '')
    expect(w.focusAsked).toEqual([true])
    await down($, w)
    expect((await seen($, rows, 'home')).chosen).toContain('why is events.jsonl bigger?')
    // Esc, then a click on the panel
    await escAndBack($, w, rows, 'home')
    let s = await seen($, rows, 'home')
    named(s.hint, ['↑↓ to choose', 'Enter to open', 'Space to fold', 'x to close'])
    await down($, w)
    expect((await seen($, rows, 'home')).chosen).toContain('which pages were deleted?')
    // a letter the panel does not bind goes to the prompt; the panel draws neither the relay nor its hotkeys until the
    // prompt has the keys, and says to click it for them
    await type($, w, rows, 'q')
    expect(w.filled).toEqual(['q'])
    s = await seen($, rows, 'home')
    expect(s.hint).toBe(UNFOCUSED_HINT)
    expect(s.relay || s.hotkeys).toBe(false)
    // the next key reaches the prompt and the pane loses the keys; given them again, its keys are back
    w.paneFocused = false
    await seen($, rows, 'home')
    w.paneFocused = true
    await takesKeys($)
    s = await seen($, rows, 'home')
    expect(s.relay && s.hotkeys).toBe(true)
    named(s.hint, ['↑↓ to choose', 'Enter to open'])
    // a click on a row gave the Client the keys too: the pane takes them back after the row's own act (live check
    // term-fix8, quirk 2: x did nothing after a click on a home row)
    w.focusAsked.length = 0
    await click($, w, rows, 'home', 'which pages were deleted?')
    expect(w.focusAsked.filter(Boolean).length).toBeGreaterThanOrEqual(2)
    await takesKeys($)
    await type($, w, rows, 'x')
    expect(w.closed).toContain(PANEL)
  })
}

// ------------------------------------------------------------------------------------------------ threads

test('keys · threads · /thimble threads and a heading click: ↓ opens the first thread, 1-9 open one, x closes', async ($, on) => {
  const w = world(on)
  w.chats.t2 = { meta: { ...w.states.threads[2] }, events: [{ type: 'user', text: 'which pages were deleted?' }] }
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'threads' } as never)
  await w.clock.settle()
  await takesKeys($)
  let s = await seen($, SHORT, 'threads-tree')
  named(s.hint, ['↑↓ to choose', 'x to close'])
  expect(s.hint).not.toContain('Enter')
  // the tree lists the newest first: ↓ opens it
  await down($, w)
  expect((await seen($, SHORT)).text).toMatch(/threads › ◌ "which pages were deleted\?"/)
  await takesKeys($)
  await type($, w, SHORT, '2')
  expect((await seen($, SHORT)).text).toMatch(/threads › "why is events\.jsonl so much/)
  // from home's heading
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  await click($, w, SHORT, 'home', 'Threads (2)')
  await takesKeys($)
  s = await seen($, SHORT, 'threads-tree')
  named(s.hint, ['↑↓ to choose', 'b to go back', 'x to close'])
  await type($, w, SHORT, 'b')
  expect((await seen($, SHORT, 'home')).rows[0]).toContain('Home')
})

test('keys · thread · a row click and after Esc: ↑↓ step, Enter and a put the field in the ring and the hint says so, s stops, b goes back', async ($, on) => {
  // live check term-fix8, quirk 7: after Enter the hint still named b while a typed b went into the field
  const w = world(on)
  w.chats.t2 = { meta: { ...w.states.threads[2] }, events: [{ type: 'user', text: 'which pages were deleted?' }, { type: 'tool_use', id: 'u1', name: 'Bash', input: {} }] }
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  await click($, w, SHORT, 'home', '"which pages were deleted?"')
  await takesKeys($)
  let s = await seen($, SHORT, 'threads-tree')
  named(s.hint, ['↑↓ to choose', 'Enter or a to ask', 's to stop', 'b to go back', 'x to close'])
  // s stops the running thread
  await type($, w, SHORT, 's')
  expect(w.acts).toContainEqual({ kind: 'stop', payload: { agent: 't2' } })
  // ↓ steps to the thread below in the tree (the newest stands first), ↑ back
  await down($, w)
  await takesKeys($)
  s = await seen($, SHORT, 'threads-tree')
  expect(s.chosen).toContain('why is events.jsonl so much bigger?')
  await up($, w)
  await takesKeys($)
  expect((await seen($, SHORT, 'threads-tree')).chosen).toContain('which pages were deleted?')
  await down($, w)
  await takesKeys($)
  // Enter asks for the ring on the follow-up field ($.ui.focus, which this kit does not implement, so the move is played
  // here as Claude Code makes it, and checked live); the field holding it, the hint says what Enter does there and that
  // Esc leaves it
  await enter($, w, SHORT)
  expect(w.filled).toEqual([])
  await askField($)
  s = await seen($, SHORT, 'threads-tree')
  expect(s.hint).toBe('Enter to ask · Esc to leave the field')
  // Esc leaves the pane; a click on the panel gives it the keys again, the ring on the list's keys
  await escAndBack($, w, SHORT, 'threads-tree')
  s = await seen($, SHORT, 'threads-tree')
  named(s.hint, ['↑↓ to choose', 'Enter or a to ask'])
  // a, as Enter
  await type($, w, SHORT, 'a')
  expect(w.filled).toEqual([])
  await askField($)
  expect((await seen($, SHORT, 'threads-tree')).hint).toBe('Enter to ask · Esc to leave the field')
})

// ------------------------------------------------------------------------------------------------ labels, documents, views

for (const rows of [SHORT, TALL]) {
  const size = rows === SHORT ? 'short' : 'tall'
  test(`keys · labels · a heading click and an empty click · ${size}: ↑↓ choose and stay in view, Enter and 1-9 open, b back`, async ($, on) => {
    const w = world(on)
    const more = Array.from({ length: 14 }, (_, i) => ({ ...w.states.labels[0]!, id: `lab${String(i).padStart(5, '0')}`, name: `label number ${i + 2}` }))
    w.states.labels = [...w.states.labels, ...more] as typeof w.states.labels
    await start($, w)
    await $.command.run({ command: 'thimble:thimble', args: '' } as never)
    await w.clock.settle()
    await takesKeys($)
    await click($, w, SHORT, 'home', 'Labels (15)')
    await takesKeys($)
    let s = await seen($, rows, 'labels-list')
    named(s.hint, ['↑↓ to choose', 'Enter to open', 'b to go back', 'x to close'])
    expect(s.chosen).toContain('links through a fetch proxy')
    await down($, w, 12)
    s = await seen($, rows, 'labels-list')
    expect(s.chosen).toContain('label number 13')
    if (rows === TALL) expect(s.rows.some(r => /↑ \d+ more/.test(r))).toBe(true)
    // a click on no hit (the margin) hands the keys back
    w.focusAsked.length = 0
    await click($, w, rows, 'labels-list', '')
    expect(w.focusAsked).toEqual([true])
    await takesKeys($)
    expect((await seen($, rows, 'labels-list')).chosen).toContain('label number 13')
    await enter($, w, rows)
    expect((await seen($, rows)).text).toContain('label number 13')
    await hotkey($, w, 'back')
    await takesKeys($)
    await type($, w, rows, '1')
    expect((await seen($, rows)).text).toMatch(/name:.*links through a fetch proxy/)
  })
}

test('keys · documents · /thimble documents: ↑↓ choose, Enter and 1-9 open, x closes', async ($, on) => {
  const w = world(on)
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'documents' } as never)
  await w.clock.settle()
  await takesKeys($)
  const s = await seen($, SHORT, 'docs-list')
  named(s.hint, ['↑↓ to choose', 'Enter to open', 'x to close'])
  await down($, w)
  await up($, w)
  await enter($, w, SHORT)
  expect((await seen($, SHORT)).text).toContain('The data')
  await hotkey($, w, 'back')
  await takesKeys($)
  await type($, w, SHORT, '1')
  expect((await seen($, SHORT)).text).toContain('The main claim')
})

test('keys · views · a heading click: ↑↓ choose, Enter and 1-9 open, b back', async ($, on) => {
  const w = world(on)
  w.states.home = { ...w.states.home, views: [{ slug: 'board', name: 'Board', status: 'built', ts: '2026-10-07T02:00:00Z', files: ['board.jsonl'] }, { slug: 'bursts', name: 'Edit Bursts', status: 'proposed', ts: '2026-10-07T01:00:00Z', files: [] }] } as never
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  await click($, w, SHORT, 'home', 'Views (2)')
  await takesKeys($)
  let s = await seen($, SHORT, 'views-list')
  named(s.hint, ['↑↓ to choose', 'Enter to open', 'b to go back', 'x to close'])
  await down($, w)
  s = await seen($, SHORT, 'views-list')
  expect(s.chosen).toContain('Edit Bursts')
  await enter($, w, SHORT)
  expect((await seen($, SHORT)).text).toContain('The view is not built yet')
  await hotkey($, w, 'back')
  await takesKeys($)
  await type($, w, SHORT, '1')
  // a view built in browser mode has no terminal program: one line says so, and no view host starts
  expect((await seen($, SHORT)).text).toMatch(/Board[\s\S]*built in browser mode, so only the browser draws it/)
  expect(w.viewHost.started).toBe(0)
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
  await w.clock.settle()
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

test('keys · view · a terminal view: its rows under the header, its hint row, ↑↓ and Enter through the relay, its letters and signs as hotkeys', async ($, on) => {
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
  named(s.hint, ['↑↓ to choose', 'Enter to open', 'c to color by', '[ ] to pan', 'b to go back', 'x to close'])
  expect(s.relay).toBe(true)
  // ↓ through the relay is the view's `down`; its next frame chooses the second row
  await down($, w)
  expect(events(w).at(-1)).toMatchObject({ t: 'key', key: 'down' })
  expect(await viewRows($)).toContain('❯ ● second row')
  // a letter and a sign the view binds go to it from the relay's field
  await type($, w, SHORT, 'c')
  expect(events(w).at(-1)).toMatchObject({ t: 'key', key: 'c' })
  await type($, w, SHORT, ']')
  expect(events(w).at(-1)).toMatchObject({ t: 'key', key: ']' })
  // Enter is the view's `return`
  await enter($, w, SHORT)
  expect(events(w).at(-1)).toMatchObject({ t: 'key', key: 'return' })
  // a letter it does not bind goes to the prompt, as on every panel
  await type($, w, SHORT, 'q')
  expect(w.filled).toContain('q')
  expect(events(w).some(e => e.key === 'q')).toBe(false)
})

test('keys · view · a click on a row, a drag on a strip and the wheel are the view\'s; its acts open a place or a thread; b back ends its program', async ($, on) => {
  const w = world(on)
  w.states.home = { ...w.states.home, views: TERM_VIEWS } as never
  w.viewHost.acts = ev => (ev.t === 'click' && ev.i === 2 ? [{ kind: 'open', ref: 'README.md#L3' }] : [])
  await openTermView($, w)
  const pane = await look($, SHORT)
  // a press on the third row's hit (the frame's hits: the control, then the three rows, then the strip)
  await pane.pointer({ type: 'down', x: 8, y: 3, button: 'left', in: 'm:view-frame' } as never)
  await w.clock.settle()
  await pane.unmount()
  const click = events(w).find(e => e.t === 'click')
  expect(click).toMatchObject({ t: 'click', i: 3, x: 6, seq: 1 })
  // a drag on the strip, from its cell 1 to its cell 4
  const pane2 = await look($, SHORT)
  await pane2.pointer({ type: 'down', x: 3, y: 4, button: 'left', in: 'm:view-frame' } as never)
  await pane2.pointer({ type: 'move', x: 5, y: 4, button: 'left', in: 'm:view-frame' } as never)
  await pane2.pointer({ type: 'up', x: 6, y: 4, button: 'left', in: 'm:view-frame' } as never)
  await w.clock.settle()
  await pane2.unmount()
  expect(events(w).find(e => e.t === 'drag')).toMatchObject({ t: 'drag', i: 4, x0: 1, x1: 4 })
  // the wheel over the view
  await (await look($, SHORT)).unmount()
  await $.ui.scroll({ requestId: PANEL, component: 'Pane', by: 3, pointer: { x: 10, y: 10 }, origin: { kind: 'person' } } as never)
  await w.clock.settle()
  expect(events(w).find(e => e.t === 'wheel')).toMatchObject({ t: 'wheel', by: 3 })
  // an act with the answer to the analyst's click: the record's place opens in the citation panel
  await takesKeys($)
  const pane3 = await look($, SHORT)
  await pane3.pointer({ type: 'down', x: 8, y: 2, button: 'left', in: 'm:view-frame' } as never)
  await w.clock.settle()
  await pane3.unmount()
  expect(events(w).filter(e => e.t === 'click').at(-1)).toMatchObject({ i: 2 })
  expect((await seen($, SHORT)).text).toContain('An export of 4,579 wiki pages')
  // back to the view: its program opens again; back again to the views list ends it
  await hotkey($, w, 'back')
  expect(w.viewHost.requests.filter(r => r.path === '/close').length).toBeGreaterThanOrEqual(1)
})

test('keys · view · while its field takes typing, every key goes to the view, x and b among them', async ($, on) => {
  const w = world(on)
  w.states.home = { ...w.states.home, views: TERM_VIEWS } as never
  w.viewHost.frame = n => viewFrame(n, { typing: true, hints: ['Enter to finish', 'Backspace to delete'], keys: ['up', 'down'] })
  await openTermView($, w)
  const s = await seen($, SHORT)
  named(s.hint, ['Enter to finish', 'Backspace to delete'])
  expect(s.relay).toBe(true)
  for (const ch of ['d', 'x', 'b']) await type($, w, SHORT, ch)
  expect(events(w).filter(e => e.t === 'key').map(e => e.key)).toEqual(['d', 'x', 'b'])
  expect(w.closed).not.toContain(PANEL)
  await backspace($, w, SHORT)
  expect(events(w).at(-1)).toMatchObject({ key: 'backspace' })
  await enter($, w, SHORT)
  expect(events(w).at(-1)).toMatchObject({ key: 'return' })
})

// ------------------------------------------------------------------------------------------------ files and a file

const LONG = {
  path: 'log.txt',
  kind: 'text',
  total_lines: 40,
  start: 1,
  records: Array.from({ length: 40 }, (_, i) => ({ line: i + 1, record: { text: `line ${i + 1} of the log` } })),
}

for (const rows of [SHORT, TALL]) {
  const size = rows === SHORT ? 'short' : 'tall'

  test(`keys · files · /thimble files, a row click and an empty click · ${size}: ↑↓ choose and stay in view, Space folds, Enter opens`, async ($, on) => {
    const w = world(on)
    w.states.files = [{ path: 'README.md', kind: 'markdown', size_bytes: 1800 }, ...Array.from({ length: 16 }, (_, i) => ({ path: `logs/run-${i + 1}.jsonl`, kind: 'records', size_bytes: 100 })), { path: 'log.txt', kind: 'text', size_bytes: 600 }]
    w.pages['log.txt'] = LONG
    await start($, w)
    await $.command.run({ command: 'thimble:thimble', args: 'files' } as never)
    await w.clock.settle()
    await takesKeys($)
    let s = await seen($, rows, 'files-tree')
    // Space folds (restored: the relay's field takes it)
    named(s.hint, ['↑↓ to choose', 'Enter to open', 'Space to fold', 'x to close'])
    await down($, w)
    expect((await seen($, rows, 'files-tree')).chosen).toContain('log.txt')
    await down($, w)
    expect((await seen($, rows, 'files-tree')).chosen).toContain('README.md')
    // the logs/ folder unfolded by a click on its row: its files
    await click($, w, rows, 'files-tree', 'logs/')
    await takesKeys($)
    await down($, w, 12)
    s = await seen($, rows, 'files-tree')
    expect(s.chosen).toContain('run-12.jsonl')
    expect(s.hint).toContain('Space to fold')
    if (rows === TALL) expect(s.rows.some(r => /↑ \d+ more/.test(r))).toBe(true)
    // Space folds the chosen file's folder
    await type($, w, rows, ' ')
    expect((await seen($, rows, 'files-tree')).rows.join('\n')).not.toContain('run-12.jsonl')
    // an empty click (the column names' row is no hit) hands the keys back
    w.focusAsked.length = 0
    const pane = await look($, rows)
    await pane.pointer({ type: 'down', x: 4, y: 0, button: 'left', in: 'm:files-tree' } as never)
    await w.clock.settle()
    await pane.unmount()
    expect(w.focusAsked).toEqual([true])
    await takesKeys($)
    await up($, w, 30)
    await enter($, w, rows)
    await takesKeys($)
    expect((await seen($, rows, 'file-body')).rows.join('\n')).toContain('line 1 of the log')
  })

  test(`keys · file · a row click and /thimble files <path> · ${size}: ↑↓ choose and stay in view, Enter opens the citation, Backspace goes back; never ←`, async ($, on) => {
    const w = world(on)
    w.states.files = [{ path: 'log.txt', kind: 'text', size_bytes: 600 }]
    w.pages['log.txt'] = LONG
    await start($, w)
    await $.command.run({ command: 'thimble:thimble', args: 'files' } as never)
    await w.clock.settle()
    await takesKeys($)
    await click($, w, rows, 'files-tree', 'log.txt')
    await click($, w, rows, 'files-tree', 'log.txt')
    await takesKeys($)
    let s = await seen($, rows, 'file-body')
    named(s.hint, ['↑↓ to choose', 'Enter to open', 'Backspace for the files', 'x to close'])
    expect(s.hint).not.toContain('←')
    await down($, w)
    await takesKeys($)
    s = await seen($, rows, 'file-body')
    expect(s.rows.find(r => /line 1 of the log/.test(r))).toBeDefined()
    await down($, w, 25)
    await takesKeys($)
    s = await seen($, rows, 'file-body')
    // the chosen line (26) shows, lit, in a pane shorter than the file
    expect(s.rows.some(r => r.includes('line 26 of the log'))).toBe(true)
    const detail = await look($, rows)
    expect(shown(await detail.drawn({ in: 'file-detail' }))).toContain('log.txt line 26')
    await detail.unmount()
    if (rows === TALL) expect(s.rows.length).toBeLessThan(rows)
    // Enter opens the chosen record's citation
    await enter($, w, rows)
    expect((await seen($, rows)).text).toMatch(/citation/)
    await hotkey($, w, 'back')
    await takesKeys($)
    // Backspace goes back to the file browser
    await backspace($, w, rows)
    expect((await seen($, rows, 'files-tree')).text).toContain('Files')
    // from /thimble files <path>:<line>, the line chosen
    await $.command.run({ command: 'thimble:thimble', args: 'files log.txt:30' } as never)
    await w.clock.settle()
    await takesKeys($)
    s = await seen($, rows, 'file-body')
    expect(s.rows.some(r => r.includes('line 30 of the log'))).toBe(true)
    await type($, w, rows, 'x')
    expect(w.closed).toContain(PANEL)
  })
}

test('keys · file · a transcript: 1 2 for the tabs from the relay', async ($, on) => {
  const w = world(on)
  w.states.files = [{ path: 'chat.jsonl', kind: 'records', size_bytes: 10 }]
  w.pages['chat.jsonl'] = { path: 'chat.jsonl', kind: 'records', total_lines: 2, start: 1, transcript: { format: 'messages', score: 0.95, keys: { speaker: 'author', text: 'body' } }, records: [{ line: 1, record: { author: 'alice', body: 'Who saved it?' } }, { line: 2, record: { author: 'bob', body: 'An agent.' } }] }
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'files chat.jsonl' } as never)
  await w.clock.settle()
  await takesKeys($)
  const s = await seen($, SHORT, 'file-body')
  named(s.hint, ['1 2 3 for the tabs', '↑↓ to choose'])
  await type($, w, SHORT, '3')
  expect(JSON.stringify(await (await look($, SHORT)).drawn())).toContain('{"type":"Text","props":{"inverse":true},"children":[" Raw "]}')
})

// ------------------------------------------------------------------------------------------------ the panels with no list

test('keys · card, label, document and a new thread: no relay; their letters work; no ↑↓, Enter, Space or ← named', async ($, on) => {
  const w = world(on)
  await start($, w)
  const noList = async (keys: string[], press: string, effect: () => void) => {
    await takesKeys($)
    const s = await seen($, SHORT)
    expect(s.relay).toBe(false)
    named(s.hint, keys)
    expect(s.hint).not.toMatch(/↑↓|Enter to open|Space/)
    const pane = await look($, SHORT)
    await pane.press({ key: press })
    await w.clock.settle()
    await pane.unmount()
    effect()
  }
  // a card, from /thimble card <id>
  await $.command.run({ command: 'thimble:thimble', args: 'card ff73e071' } as never)
  await w.clock.settle()
  await noList(['c for its code', 'a to ask', 'x to close'], 'hk-code', () => undefined)
  expect((await seen($, SHORT)).text).toContain('its code')
  // a label, from its row on home
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  await click($, w, SHORT, 'home', 'links through a fetch proxy', '█')
  await noList(['r to run a sample', 'c counts, e examples, d cards', 'l for labels'], 'hk-counts', () => undefined)
  expect((await seen($, SHORT)).text).toContain('proxy-link')
  // a document
  await $.command.run({ command: 'thimble:thimble', args: 'documents' } as never)
  await w.clock.settle()
  await takesKeys($)
  await type($, w, SHORT, '1')
  await noList(['l for all documents'], 'hk-all', () => undefined)
  await takesKeys($)
  expect((await seen($, SHORT, 'docs-list')).hint).toContain('↑↓ to choose')
  // a new thread: its field has the ring
  await $.command.run({ command: 'thimble:thimble', args: 'card ff73e071' } as never)
  await w.clock.settle()
  const pane = await look($, SHORT)
  await pane.press({ key: 'hk-ask' })
  await w.clock.settle()
  await pane.unmount()
  const ask = await seen($, SHORT)
  expect(ask.relay).toBe(false)
  expect(ask.hint).toBe('Enter to ask · Esc to leave the field')
})
