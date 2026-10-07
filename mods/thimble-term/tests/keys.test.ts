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
//   citation     a file citation in a reply                    ↑↓ and the wheel scroll the whole file, a click on a
//                                                              count a page, a f b x
//   card, label, document, ask: no list                      their letters; no ↑↓, Enter, Space or ← named
//   back from a new thread's form   a card, a file's line, after Esc   the view's own hints, never the field's; the list's
//                                                              keys where it draws a list
//   home's `… N more`                ↓ until it is chosen               Space and Enter show the section, the choice on
//                                                              its first row shown then
//   l, show all threads             a document, a label, home           the list in place of the step, the item it came
//                                                              from chosen, b to home; the threads take the list's
//                                                              keys though the ring was on the control; no `t`
//   back                            a line chosen in a file, a thread   where the file or the form was opened from
//                                   just asked
//
// `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { width } from '../hooks/lib'
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
  // a digit that reaches a document's key after a letter went to the prompt (the panel not drawn again yet) is typed into
  // the prompt too (live check term-fix10: `table` typed into the prompt opened the threads at its `t`)
  await type($, w, SHORT, 'q')
  const pane = await look($, SHORT)
  await pane.press({ key: 'doc-open-0' })
  await w.clock.settle()
  await pane.unmount()
  expect(w.filled).toEqual(['q', '1'])
  expect((await seen($, SHORT)).text).not.toContain('The main claim')
  w.paneFocused = false
  await seen($, SHORT)
  w.paneFocused = true
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

test('keys · view · a hint row longer than the panel is wide wraps, whole hints on each row, so no key the view binds goes unnamed; the view hears the theme', async ($, on) => {
  const w = world(on)
  w.states.home = { ...w.states.home, views: TERM_VIEWS } as never
  const hints = ['↑↓ to choose', 'Enter to open', 'c to color by', '/ to search', 'i for incident', '[ ] to pan', '+ - to zoom', 'a to ask', 'r to reset']
  w.viewHost.frame = n => viewFrame(n, { hints, hintKeys: hints.map(() => []), keys: ['up', 'down', 'return', 'c', '/', 'i', '[', ']', '+', '-', 'a', 'r'] })
  await openTermView($, w)
  const open = w.viewHost.requests.find(r => r.path === '/open')
  expect(open?.body.theme).toBe('dark')
  const pane = await look($, SHORT)
  const box = (await pane.find({ key: 'h-hints' })) as { children?: unknown[] }
  await pane.unmount()
  const rows = (box.children ?? []).map(r => shown(r).trim())
  expect(rows.length).toBeGreaterThan(1)
  named(rows.join(' · '), [...hints, 'b to go back', 'x to close'])
  // each hint stands whole on one row
  for (const h of hints) expect(rows.some(r => r.includes(h))).toBe(true)
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
  expect((await seen($, SHORT, 'cite-lines')).rows.join('\n')).toContain('An export of 4,579 wiki pages')
  // the citation panel shows no view: the timer ends the view's program
  await (await look($, SHORT)).unmount()
  await w.clock.advance(300)
  expect(w.viewHost.requests.filter(r => r.path === '/close').length).toBeGreaterThanOrEqual(1)
})

test('keys · view · from the moment it opens until its first frame the view says it is starting; a reader query out says loading against R', async ($, on) => {
  const w = world(on)
  w.states.home = { ...w.states.home, views: TERM_VIEWS } as never
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  await click($, w, SHORT, 'home', 'Views (1)')
  await takesKeys($)
  await enter($, w, SHORT)
  // the host has not answered yet: no frame
  expect((await seen($, SHORT)).text).toContain('◌ starting the view…')
  // a first frame drawn while its first query is out
  w.viewHost.frame = n => viewFrame(n, { loading: true })
  await (await look($, SHORT)).unmount()
  await w.clock.advance(300)
  await w.clock.advance(300)
  const s = await seen($, SHORT)
  expect(s.text).not.toContain('starting the view')
  expect(s.text).toContain('Timeline')
  expect(s.text).toContain('◌ loading…')
  expect((await viewRows($)).join('\n')).toContain('first row')
})

test('keys · view · a chart\'s region under the pointer marks its column on every chart over the same cells, never an inverse band, with that cell\'s tip', async ($, on) => {
  const w = world(on)
  w.states.home = { ...w.states.home, views: TERM_VIEWS } as never
  // a strip and a lane over the same six cells, each a chart region with a tip per cell
  w.viewHost.frame = n => viewFrame(n, {
    lines: [
      [{ s: '  ' }, { s: 'Color by', d: true }, { s: '  ' }, { s: 'Kind' }],
      [{ s: '  ' }, { s: '▁▃█ ▃▁', fg: '#1d7fc0' }],
      [{ s: '  ' }, { s: '─▆  ▆─', fg: '#1d7fc0' }],
      [{ s: '  ' }, { s: 'a row under the lanes' }],
    ],
    hits: [
      { y: 0, x0: 12, x1: 16, tip: 'choose what colors the view' },
      { y: 1, x0: 2, x1: 8, cursor: true, tip: 'drag to frame a range', tips: ['09:00', '09:01', '09:02 · 4 records', '09:03', '09:04', '09:05'] },
      { y: 2, x0: 2, x1: 8, cursor: true, tips: ['lead · 09:00', 'lead · 09:01 · 1 record', 'lead · 09:02', 'lead · 09:03', 'lead · 09:04', 'lead · 09:05'] },
    ],
  })
  await openTermView($, w)
  const pane = await look($, SHORT)
  // the pointer over the lane's fourth cell, which is empty
  await pane.pointer({ type: 'move', x: 5, y: 2, in: 'm:view-frame' } as never)
  await w.clock.settle()
  const tree = await pane.drawn({ in: 'm:view-frame' })
  const rows = (((tree as { children?: unknown[] }).children ?? []).map(r => shown(r)))
  expect(rows[1]).toBe('  ▁▃█┊▃▁')
  expect(rows[2]).toBe('  ─▆ ┊▆─')
  // the cell's own tip on the row under the lane
  expect(rows[3]).toContain('lead · 09:03')
  expect(JSON.stringify(tree)).not.toContain('"inverse":true')
  // over a bar: the bar stays, in the text color, and its cell's tip shows
  await pane.pointer({ type: 'move', x: 3, y: 2, in: 'm:view-frame' } as never)
  await w.clock.settle()
  const tree2 = await pane.drawn({ in: 'm:view-frame' })
  const rows2 = (((tree2 as { children?: unknown[] }).children ?? []).map(r => shown(r)))
  expect(rows2[2]).toBe('  ─▆  ▆─')
  expect(rows2[3]).toContain('lead · 09:01 · 1 record')
  expect(JSON.stringify(tree2)).not.toContain('"inverse":true')
  // a control that is no chart is still inverse under the pointer
  await pane.pointer({ type: 'move', x: 13, y: 0, in: 'm:view-frame' } as never)
  await w.clock.settle()
  expect(JSON.stringify(await pane.drawn({ in: 'm:view-frame' }))).toContain('"inverse":true')
  await pane.unmount()
})

test('keys · view · while its field takes typing, the relay\'s field holds its text and sends each change whole, x and b among them; Enter ends it', async ($, on) => {
  const w = world(on)
  w.states.home = { ...w.states.home, views: TERM_VIEWS } as never
  w.viewHost.frame = n => viewFrame(n, { typing: true, field: { text: 're' }, hints: ['Enter to finish'], keys: ['up', 'down'] })
  await openTermView($, w)
  const s = await seen($, SHORT)
  named(s.hint, ['Enter to finish', 'Esc to leave the field'])
  expect(s.hint).not.toContain('b to go back')
  const pane = await look($, SHORT)
  expect(await relayText(pane)).toBe('re')
  await pane.unmount()
  // what the analyst types goes into the field, which sends its whole text: no letter is a hotkey there
  for (const ch of ['d', 'x', 'b']) await type($, w, SHORT, ch)
  expect(events(w).filter(e => e.t === 'text').map(e => e.value)).toEqual(['red', 'redx', 'redxb'])
  expect(w.closed).not.toContain(PANEL)
  await backspace($, w, SHORT)
  expect(events(w).at(-1)).toMatchObject({ t: 'text', value: '' })
  await enter($, w, SHORT)
  expect(events(w).at(-1)).toMatchObject({ t: 'key', key: 'return' })
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
    // a row is chosen as the browser opens, the first file of the first folder; the folder's row is a row the keys
    // choose too (live check term-fix9, quirk 7)
    expect(s.chosen).toContain('log.txt')
    await up($, w)
    expect((await seen($, rows, 'files-tree')).chosen).toMatch(/^▾ wiki\//)
    await down($, w, 2)
    expect((await seen($, rows, 'files-tree')).chosen).toContain('README.md')
    // the logs/ folder unfolded by a click on its row: its files, the choice on the folder's row
    await click($, w, rows, 'files-tree', 'logs/')
    await takesKeys($)
    expect((await seen($, rows, 'files-tree')).chosen).toMatch(/^▾ logs\//)
    await down($, w, 12)
    s = await seen($, rows, 'files-tree')
    expect(s.chosen).toContain('run-12.jsonl')
    expect(s.hint).toContain('Space to fold')
    if (rows === TALL) expect(s.rows.some(r => /↑ \d+ more/.test(r))).toBe(true)
    // Space folds the chosen file's folder, and the choice goes onto the folder's row, never a hidden file
    await type($, w, rows, ' ')
    s = await seen($, rows, 'files-tree')
    expect(s.rows.join('\n')).not.toContain('run-12.jsonl')
    expect(s.chosen).toMatch(/^▸ logs\//)
    // Enter on a folder's row unfolds it, Space folds it again; neither opens a file
    await enter($, w, rows)
    s = await seen($, rows, 'files-tree')
    expect(s.rows.join('\n')).toContain('run-1.jsonl')
    expect(s.chosen).toMatch(/^▾ logs\//)
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
    expect((await seen($, rows, 'files-tree')).chosen).toMatch(/^▾ wiki\//)
    await down($, w)
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
    // the one file is chosen as the browser opens: a click on it opens it
    expect((await seen($, rows, 'files-tree')).chosen).toContain('log.txt')
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
    // Backspace goes back to the file browser, the file chosen there
    await backspace($, w, rows)
    s = await seen($, rows, 'files-tree')
    expect(s.text).toContain('Files')
    expect(s.chosen).toContain('log.txt')
    // from /thimble files <path>:<line>, the line chosen; Backspace: the browser, the file chosen there (live check
    // term-fix9, quirk 7: no row was chosen)
    await $.command.run({ command: 'thimble:thimble', args: 'files log.txt:30' } as never)
    await w.clock.settle()
    await takesKeys($)
    s = await seen($, rows, 'file-body')
    expect(s.rows.some(r => r.includes('line 30 of the log'))).toBe(true)
    await backspace($, w, rows)
    await takesKeys($)
    s = await seen($, rows, 'files-tree')
    expect(s.chosen).toContain('log.txt')
    expect(s.text).toMatch(/‹ back {2}home › files(?! ›)/)
    await type($, w, rows, 'x')
    expect(w.closed).toContain(PANEL)
  })
}

test('keys · file · a transcript: 1 2 3 4 for the tabs from the relay', async ($, on) => {
  const w = world(on)
  w.states.files = [{ path: 'chat.jsonl', kind: 'records', size_bytes: 10 }]
  w.pages['chat.jsonl'] = { path: 'chat.jsonl', kind: 'records', total_lines: 2, start: 1, transcript: { format: 'messages', score: 0.95, keys: { speaker: 'author', text: 'body' } }, records: [{ line: 1, record: { author: 'alice', body: 'Who saved it?' } }, { line: 2, record: { author: 'bob', body: 'An agent.' } }] }
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'files chat.jsonl' } as never)
  await w.clock.settle()
  await takesKeys($)
  const s = await seen($, SHORT, 'file-body')
  named(s.hint, ['1 2 3 4 for the tabs', '↑↓ to choose'])
  await type($, w, SHORT, '4')
  expect(JSON.stringify(await (await look($, SHORT)).drawn())).toContain('{"type":"Text","props":{"inverse":true},"children":[" Raw "]}')
})

// ------------------------------------------------------------------------------------------------ a file citation

/** A file of 900 lines, paged as thimble pages it: 200 lines from the line `--start` names. */
const LOG = (start: number) => ({ path: 'log.txt', kind: 'text', total_lines: 900, start, records: Array.from({ length: Math.max(0, Math.min(200, 901 - start)) }, (_, i) => ({ line: start + i, record: { text: `line ${start + i} of the log` } })) })
const logLine = (n: number) => ({ line: n, record: { text: `line ${n} of the log` } })
const CITE_ROWS = 36
const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: PANEL, component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never

/** The first and last line numbers a file citation's window shows. */
function shownLines(rows: string[]): { first: number; last: number } {
  const ns = rows.map(r => Number(/^\s+(\d+)\s{2}line/.exec(r)?.[1] ?? 0)).filter(n => n > 0)
  return { first: ns[0] ?? 0, last: ns.at(-1) ?? 0 }
}

/** The ring moved onto `element` of the citation panel as drawn in a pane of CITE_ROWS rows. */
async function citeRing($: E, w: World, element: string): Promise<void> {
  await (await look($, CITE_ROWS)).unmount()
  expect(await ring($, element)).toEqual({})
  await w.clock.settle()
}

/** The wheel over the citation panel as drawn in a pane of CITE_ROWS rows, then a drawing, which reads a page the
 *  window reached, then that page's arrival. */
async function citeWheel($: E, w: World, by: number): Promise<void> {
  await (await look($, CITE_ROWS)).unmount()
  await $.ui.scroll({ requestId: PANEL, component: 'Pane', by, pointer: { x: 10, y: 10 }, origin: { kind: 'person' } } as never)
  await w.clock.settle()
  await (await look($, CITE_ROWS)).unmount()
  await w.clock.settle()
}

test('keys · citation · a file citation: ↑↓ and the wheel move its window over the whole file a line at a time, a click on a count a page, the next page read as it is reached; f opens the file and b comes back to the window where it was', async ($, on) => {
  // Matt, 2026-10-07: "you can't see beyond the few lines it picks"
  const w = world(on)
  w.pages['log.txt'] = LOG
  w.resolve['log.txt#L450'] = { ref: 'log.txt#L450', kind: 'record', path: 'log.txt', line: 450, record: { text: 'line 450 of the log' }, blocks: [{ text: 'line 450 of the log' }], excerpt: 'line 450 of the log', context: { before: [448, 449].map(logLine), after: [451, 452].map(logLine) } }
  await start($, w)
  const text = 'See [[log.txt#L450]] for the restart.'
  let ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  await w.clock.advance(300)
  await ui.unmount()
  ui = (await $.ui.mount(MESSAGE('m1', text))) as unknown as M
  await ui.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.pointer({ type: 'up', x: 5, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.unmount()
  await w.clock.settle()
  await takesKeys($)
  let s = await seen($, CITE_ROWS, 'cite-lines')
  expect(s.relay).toBe(true)
  named(s.hint, ['↑↓ to scroll', 'a to ask', 'f for its file', 'x to close'])
  const at0 = shownLines(s.rows).first
  expect(at0).toBeLessThan(450)
  expect(s.rows[0]!.trim()).toBe(`↑ ${at0 - 1} more`)
  // ↓ and ↑ a line
  await citeRing($, w, RELAY.down)
  expect(shownLines((await seen($, CITE_ROWS, 'cite-lines')).rows).first).toBe(at0 + 1)
  await citeRing($, w, RELAY.up)
  await citeRing($, w, RELAY.up)
  expect(shownLines((await seen($, CITE_ROWS, 'cite-lines')).rows).first).toBe(at0 - 1)
  // the wheel, by its lines
  await citeWheel($, w, 5)
  s = await seen($, CITE_ROWS, 'cite-lines')
  expect(shownLines(s.rows).first).toBe(at0 + 4)
  // a click on `↓ N more`: a page, the last line shown before among the first shown now
  const before = shownLines(s.rows)
  const pane = await look($, CITE_ROWS)
  await pane.pointer({ type: 'down', x: 5, y: s.rows.length - 1, button: 'left', in: 'm:cite-lines' } as never)
  await w.clock.settle()
  await pane.unmount()
  s = await seen($, CITE_ROWS, 'cite-lines')
  expect(shownLines(s.rows).first).toBeGreaterThan(before.first + 10)
  expect(shownLines(s.rows).first).toBeLessThanOrEqual(before.last)
  // far past the page it opened on (lines 401-600): the page that holds the file's end is read, and the window stops
  // with the last line on its last row
  await citeWheel($, w, 1000)
  s = await seen($, CITE_ROWS, 'cite-lines')
  expect(w.calls.some(c => c[2] === 'files' && c[5] === 'log.txt' && c[7] === '801')).toBe(true)
  expect(s.rows.at(-1)).toMatch(/^\s+900 {2}line 900 of the log$/)
  expect(s.rows.join('\n')).not.toContain('↓')
  const end = shownLines(s.rows).first
  await citeRing($, w, RELAY.down)
  expect(shownLines((await seen($, CITE_ROWS, 'cite-lines')).rows).first).toBe(end)
  // and back to the file's first line: no `↑` row
  await citeWheel($, w, -2000)
  s = await seen($, CITE_ROWS, 'cite-lines')
  expect(s.rows[0]).toMatch(/^\s+1 {2}line 1 of the log$/)
  expect(s.rows.join('\n')).not.toContain('↑')
  // f opens the file at the cited line; b comes back to the window where it was
  await type($, w, CITE_ROWS, 'f')
  await takesKeys($)
  s = await seen($, CITE_ROWS, 'file-body')
  expect(s.text).toContain('log.txt line 450')
  await type($, w, CITE_ROWS, 'b')
  await takesKeys($)
  s = await seen($, CITE_ROWS, 'cite-lines')
  expect(s.rows[0]).toMatch(/^\s+1 {2}line 1 of the log$/)
  // x closes
  await type($, w, CITE_ROWS, 'x')
  expect(w.closed).toContain(PANEL)
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

// ------------------------------------------------------------------------------------------------ the way: back, lists, rows

test('keys · back from a new thread\'s form: the view shown names its own keys, never those of the field it left; a list takes the ring', async ($, on) => {
  // live check term-fix9, quirk 1: after Esc and ‹ back from the form, the card read `Enter to ask · Esc to leave the
  // field` though it draws no field
  const w = world(on)
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'card ff73e071' } as never)
  await w.clock.settle()
  await hotkey($, w, 'ask')
  await $.ui.focus({ requestId: PANEL, component: 'Pane', element: 'ask-new', origin: { kind: 'plugin', name: PANEL } } as never)
  expect((await seen($, SHORT)).hint).toBe('Enter to ask · Esc to leave the field')
  // Esc, then a click on ‹ back; Claude Code puts the ring back where it was in the pane, on the form's field
  w.paneFocused = false
  expect((await seen($, SHORT)).hint).toBe(UNFOCUSED_HINT)
  let pane = await look($, SHORT)
  await pane.press({ key: 'nav-back' })
  await w.clock.settle()
  await pane.unmount()
  w.paneFocused = true
  await ring($, 'ask-new')
  await w.clock.advance(300)
  let s = await seen($, SHORT)
  expect(s.text).toContain('What does the export hold per wiki?')
  expect(s.text).not.toContain('New thread')
  expect(s.hint).not.toContain('Enter to ask')
  named(s.hint, ['c for its code', 'a to ask', 'x to close'])
  // from a file's chosen line, whose view draws a list: back from the form, the ring goes onto the list's keys
  w.states.files = [{ path: 'log.txt', kind: 'text', size_bytes: 600 }]
  w.pages['log.txt'] = LONG
  await $.command.run({ command: 'thimble:thimble', args: 'files log.txt:3' } as never)
  await w.clock.settle()
  await takesKeys($)
  pane = await look($, SHORT)
  await pane.pointer({ type: 'down', x: width('↗ log.txt line 3  '), y: 0, button: 'left', in: 'file-detail' } as never)
  await w.clock.settle()
  await pane.unmount()
  expect((await seen($, SHORT)).text).toContain('New thread')
  w.paneFocused = false
  pane = await look($, SHORT)
  await pane.press({ key: 'nav-back' })
  await w.clock.settle()
  await pane.unmount()
  w.paneFocused = true
  await ring($, 'ask-new')
  await w.clock.advance(300)
  s = await seen($, SHORT, 'file-body')
  expect(s.relay).toBe(true)
  named(s.hint, ['↑↓ to choose', 'Enter to open', 'Backspace for the files'])
  await down($, w)
  expect((await seen($, SHORT, 'file-body')).rows.find(r => r.includes('line 4 of the log'))).toBeDefined()
})

test('keys · home · a section\'s `… N more` is a row ↑↓ reach; Enter or Space shows the section whole, the choice on its first row shown then', async ($, on) => {
  // live check term-fix9, quirk 6: ↑↓ skipped `… 2 more`, so two groups of 18 cards could not be reached
  const w = world(on)
  const more = Array.from({ length: 14 }, (_, i) => ({ ...w.states.labels[0]!, id: `lab${String(i).padStart(5, '0')}`, name: `label number ${i + 2}` }))
  w.states.labels = [...w.states.labels, ...more] as typeof w.states.labels
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  let s = await seen($, SHORT, 'home')
  for (let i = 0; i < 40 && !/^… 10 more/.test(s.chosen); i++) {
    await down($, w)
    s = await seen($, SHORT, 'home')
  }
  expect(s.chosen).toBe('… 10 more')
  expect(s.rows.join('\n')).not.toContain('label number 6')
  await type($, w, SHORT, ' ')
  s = await seen($, SHORT, 'home')
  expect(s.rows.join('\n')).toContain('label number 15')
  expect(s.rows.join('\n')).not.toContain('10 more')
  expect(s.chosen).toContain('label number 6')
  await down($, w)
  expect((await seen($, SHORT, 'home')).chosen).toContain('label number 7')
  // Enter on another section's `… N more` (the cards of a big group fold into none: threads here)
  for (let i = 0; i < 6; i++) w.states.threads.push({ ...w.states.threads[1]!, id: `t${i + 10}`, title: `thread number ${i + 10}`, created_at: '2026-10-06T09:00:00+00:00' } as never)
  w.stamps.set(`${WS}/chats`, 9)
  await w.clock.advance(1100)
  await up($, w, 60)
  s = await seen($, SHORT, 'home')
  for (let i = 0; i < 20 && !/^… \d+ more/.test(s.chosen); i++) {
    await down($, w)
    s = await seen($, SHORT, 'home')
  }
  expect(s.chosen).toMatch(/^… 3 more/)
  await enter($, w, SHORT)
  s = await seen($, SHORT, 'home')
  expect(s.rows.join('\n')).not.toMatch(/… 3 more/)
  expect(s.chosen).toContain('thread number')
})

test('keys · `l` and `show all threads`: the list in place of the step that holds it, the item `l` came from chosen and b back to home; the threads with their list\'s keys whatever the ring was on', async ($, on) => {
  // live check term-fix9, quirk 10: `l` pushed `home › documents › "…" › documents`; quirk 12: threads opened with `t`
  // had no list keys, the ring on the pressed key; live check term-fix10, new quirk 8: `l` chose the list's remembered
  // row, and b returned to the step `l` replaced, not the home the path showed
  const w = world(on)
  // a newer document and another label listed first, so the row `l` chooses is not the list's first
  ;(w.states.docs as Record<string, unknown>).slides = { exists: true, title: 'Slides of the relay', renderer: 'slides', name: 'Slides', generated_at: '2026-10-07T10:00:00Z' }
  w.states.labels.unshift({ ...(w.states.labels[0] as object), id: 'a0other0', name: 'another label' } as never)
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  await click($, w, SHORT, 'home', 'Agents used the dse wiki as a relay')
  const way = async () => {
    const pane = await look($, SHORT)
    const t = shown(await pane.find({ type: 'Box', key: 'way' }))
    await pane.unmount()
    return t
  }
  expect(await way()).toMatch(/home › documents › "Agents used the dse wiki/)
  await hotkey($, w, 'all')
  expect(await way()).toMatch(/home › documents(?! ›)/)
  await takesKeys($)
  expect((await seen($, SHORT, 'docs-list')).chosen).toContain('Agents used the dse wiki')
  // back leads to home, as the path shows
  await type($, w, SHORT, 'b')
  expect(await way()).toMatch(/^home(?! ›)/)
  expect((await seen($, SHORT, 'home')).rows.join('\n')).toContain('Documents (2)')
  // a label's `l`
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  await click($, w, SHORT, 'home', 'links through a fetch proxy', '█')
  await hotkey($, w, 'list')
  expect(await way()).toMatch(/home › labels(?! ›)/)
  await takesKeys($)
  expect((await seen($, SHORT, 'labels-list')).chosen).toContain('links through a fetch proxy')
  // `show all threads` from home, pressed and the ring left on it by Claude Code: the threads take the list's keys
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  const pane = await look($, SHORT)
  expect(await pane.find({ type: 'Button', key: 'hk-threads' })).toBeUndefined()
  await pane.press({ key: 'threads' })
  await w.clock.settle()
  await pane.unmount()
  await ring($, 'threads')
  await w.clock.advance(600)
  // the panel asks the ring onto the list's keys though a button holds it (term.ts giveKeys; this kit plays Claude
  // Code's move as it makes it)
  await takesKeys($)
  const s = await seen($, SHORT, 'threads-tree')
  expect(s.relay).toBe(true)
  named(s.hint, ['↑↓ to choose', 'x to close'])
  await down($, w)
  expect((await seen($, SHORT)).text).toMatch(/home › threads › (◌ )?"/)
})

test('the path row: `show all threads` and `N new` on home alone; the threads panel, a thread, a view, a file, a card, a citation, a label and a document leave them out, home one step away', async ($, on) => {
  // Matt, 2026-10-07: "does 'show all threads' really need to be there when you're not in a thread?"
  const w = world(on)
  w.states.home = { ...w.states.home, views: TERM_VIEWS } as never
  await start($, w)
  const way = async () => {
    const pane = await look($, SHORT)
    // the row's words, without the labels of the hidden keys (their Boxes no row tall)
    const box = (await pane.find({ type: 'Box', key: 'way' })) as { children?: { props?: { height?: unknown } }[] } | undefined
    const out = { text: shown((box?.children ?? []).filter(k => k?.props?.height !== 0)), threads: Boolean(await pane.find({ type: 'Button', key: 'threads' })) }
    await pane.unmount()
    return out
  }
  const without = async (step: RegExp) => {
    const r = await way()
    expect(r.text).toMatch(step)
    // neither `show all threads` nor its narrow form `threads` at R (a step may be the threads panel's), nor `1 new`
    expect(r.text).not.toContain('show all threads')
    expect(r.text).not.toContain('1 new')
    expect(r.threads).toBe(false)
  }
  const home = async () => {
    await $.command.run({ command: 'thimble:thimble', args: '' } as never)
    await w.clock.settle()
    await takesKeys($)
    const r = await way()
    expect(r.text).toMatch(/^(‹ back {2})?home\s*show all threads {2}1 new$/)
    expect(r.threads).toBe(true)
  }
  await home()
  // a thread, from its row on home, and the threads panel
  await click($, w, SHORT, 'home', 'why is events.jsonl bigger?')
  await without(/home › threads › "why is events\.jsonl bigger\?"/)
  await $.command.run({ command: 'thimble:thimble', args: 'threads' } as never)
  await w.clock.settle()
  await without(/home › threads$/)
  // a view, the views and a file it claims
  await home()
  await click($, w, SHORT, 'home', 'Views (1)')
  await without(/home › views$/)
  await takesKeys($)
  await enter($, w, SHORT)
  await without(/home › views › Timeline$/)
  await $.command.run({ command: 'thimble:thimble', args: 'files README.md' } as never)
  await w.clock.settle()
  await without(/home › files › README\.md$/)
  await $.command.run({ command: 'thimble:thimble', args: 'files' } as never)
  await w.clock.settle()
  await without(/home › files$/)
  // a card, and a citation from it
  await $.command.run({ command: 'thimble:thimble', args: 'card ff73e071' } as never)
  await w.clock.settle()
  await without(/home › card "What does the export hold…"$/)
  const reply = { plugin: PANEL, component: 'AssistantMessage', requestId: 'm1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text: 'The README says [4,579](README.md#L3) pages.', isFirstOfReply: true } } as never
  let ui = (await $.ui.mount(reply)) as unknown as M
  await w.clock.advance(300)
  await ui.unmount()
  ui = (await $.ui.mount(reply)) as unknown as M
  await ui.pointer({ type: 'down', x: 18, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.pointer({ type: 'up', x: 18, y: 0, button: 'left', in: 'para-1' } as never)
  await ui.unmount()
  await w.clock.settle()
  await without(/citation 4,579$/)
  // a label, the documents and a document
  await home()
  await click($, w, SHORT, 'home', 'links through a fetch proxy', '█')
  await without(/home › labels › links through a fetch proxy$/)
  await $.command.run({ command: 'thimble:thimble', args: 'documents' } as never)
  await w.clock.settle()
  await without(/home › documents$/)
  await takesKeys($)
  await type($, w, SHORT, '1')
  await without(/home › documents › "Agents used the dse wiki as a…"$/)
  // home is one click away from each of them
  const pane = await look($, SHORT)
  await pane.press({ key: 'crumb-home' })
  await w.clock.settle()
  await pane.unmount()
  expect((await way()).text).toMatch(/show all threads {2}1 new$/)
})

test('keys · home · tall, scrolled: ↑ back to a section\'s first row shows its heading, and back to the first row shows the top', async ($, on) => {
  // live check term-fix10, new quirk 5: after ↓ through a tall home, ↑ back to the first row left `↑ 4 more` and hid
  // Views and the Documents heading
  const w = world(on)
  w.states.home = { ...w.states.home, views: [{ slug: 'board', name: 'Board', status: 'built', ts: '2026-10-07T02:00:00Z', files: ['board.jsonl'] }] } as never
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  const first = await seen($, TALL, 'home')
  expect(first.rows.some(r => /↑ \d+ more/.test(r))).toBe(false)
  let n = 0
  for (; n < 30; n++) {
    await down($, w)
    if ((await seen($, TALL, 'home')).rows.some(r => /↑ \d+ more/.test(r))) break
  }
  // scrolled past the top; a few more rows down, then back up
  await down($, w, 3)
  for (let i = 0; i < n + 4; i++) {
    await up($, w)
    const s = await seen($, TALL, 'home')
    const at = s.rows.findIndex(r => r.startsWith('❯'))
    // the chosen row shows, and never right under `↑ N more`: the window starts at the row that leads it, its
    // section's heading
    expect(at).toBeGreaterThanOrEqual(0)
    const more = s.rows.findIndex(r => /↑ \d+ more/.test(r))
    if (more >= 0) expect(at).toBeGreaterThan(more + 1)
  }
  const back = await seen($, TALL, 'home')
  expect(back.chosen).toBe(first.chosen)
  expect(back.rows.some(r => /↑ \d+ more/.test(r))).toBe(false)
  // the title, its rule, then the Views heading over the first row
  expect(back.rows.slice(0, 4).map(r => r.trim())).toEqual(['Home', expect.stringMatching(/^─+$/), expect.stringMatching(/^Views \(1\)/), expect.stringMatching(/Board/)])
})

test('keys · home · a word typed while home holds the keys reaches the prompt whole: `t` opens no threads', async ($, on) => {
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

test('keys · back after a line chosen in a file, and after a thread asked: where the file or the form was opened from', async ($, on) => {
  // live check term-fix9, quirk 12: after a click on a file's line, b returned to the line clicked before; back from a
  // thread just asked showed an empty form
  const w = world(on)
  w.states.files = [{ path: 'log.txt', kind: 'text', size_bytes: 600 }]
  w.pages['log.txt'] = LONG
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'files' } as never)
  await w.clock.settle()
  await takesKeys($)
  await click($, w, SHORT, 'files-tree', 'log.txt')
  await takesKeys($)
  await click($, w, SHORT, 'file-body', 'line 3 of the log')
  await click($, w, SHORT, 'file-body', 'line 7 of the log')
  await takesKeys($)
  await down($, w)
  await hotkey($, w, 'back')
  let s = await seen($, SHORT, 'files-tree')
  expect(s.text).toContain('Files')
  expect(s.chosen).toContain('log.txt')
  // a thread asked about a card: back from it shows the card
  await $.command.run({ command: 'thimble:thimble', args: 'card ff73e071' } as never)
  await w.clock.settle()
  await hotkey($, w, 'ask')
  const pane = await look($, SHORT)
  await pane.input({ key: 'ask-new', text: 'Why so many pages?' })
  await w.clock.settle()
  await pane.unmount()
  s = await seen($, SHORT)
  expect(s.text).toMatch(/home|card "What does the export hold per wiki\?" › "Why so many pages\?"|"Why so many pages\?"/)
  expect(s.text).not.toContain('New thread')
  await hotkey($, w, 'back')
  s = await seen($, SHORT)
  expect(s.text).toContain('What does the export hold per wiki?')
  expect(s.text).not.toContain('New thread')
  expect(s.text).toContain('c for its code')
})
