// @vitest-environment jsdom
// thimble fix in the page (src/chat/fix.ts, src/chat/FixStrip.tsx, backend fixes.py): `/thimble-fix <words>` goes to
// the server with a text copy of what the page shows. While Claude works, one row above the composer says what it
// fixes. How the fix ended is a row of the chat, where it ended: the newest row of a fix asks, when it passed its
// checks, Use it now (the person's click puts it on), What changed (a few lines, not a diff) and Later. After Use it
// now: "Reloading thimble…", then the row says what it said, with nothing left to ask (Your fixes offers Undo). A fix
// that did not pass says why, with Redo. An earlier row of a fix is a quiet line of what it said.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { changedLines, fixActions, fixText, fixWords, pageText, workingText, type FixRow } from '../../src/chat/fix.ts'
import { FixPage, FixResult, FixWorking } from '../../src/chat/FixStrip.tsx'
import { bus } from '../../src/lib/bus.ts'
import { dispatch } from '../../src/lib/events.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const row = (over: Partial<FixRow> = {}): FixRow => ({ id: 3, title: 'Card says how many rows', state: 'on', phase: null, kind: 'fixed', said: 'Card says how many rows is on', words: "make this card's title say how many rows", summary: "The card's title ends with its row count.", files: 2, tests: 'passed', error: null, created: 100, at: 1, ...over })
const ready = (over: Partial<FixRow> = {}) => row({ state: 'ready', kind: 'ready', said: 'thimble fixed: Card says how many rows · tests pass', ...over })

describe('the command and the page', () => {
  test('the words after /thimble-fix; anything else is no fix', () => {
    expect(fixWords('/thimble-fix make this card say rows')).toBe('make this card say rows')
    expect(fixWords('  /thimble-fix\ntwo lines ')).toBe('two lines')
    expect(fixWords('/thimble-fix')).toBe('')
    expect(fixWords('/thimble-fixes')).toBeNull()
    expect(fixWords('what does /thimble-fix do?')).toBeNull()
  })

  test('the text copy names the card open in focus, a dialog, and each pane by its surface', () => {
    document.body.innerHTML = `
      <section data-pane="p1" data-surface="canvas"><h3>Incidents by week</h3><p>week 2: 7</p></section>
      <article class="bfocus-card" data-anchor="card:c1" data-anchor-text="Incidents by week"><p>Week 2 had 7.</p></article>
      <div role="dialog" aria-label="Settings">Model: Opus</div>`
    const got = pageText()
    expect(got).toContain('The card open in focus (card:c1), "Incidents by week":\nWeek 2 had 7.')
    expect(got).toContain('The open dialog, Settings:\nModel: Opus')
    expect(got).toContain('The canvas panel:\nIncidents by weekweek 2: 7')
    document.body.innerHTML = ''
    expect(pageText()).toBe('')
  })
})

describe('the row and the notice', () => {
  test('its words: what Claude fixes and for how long, then how it went', () => {
    expect(workingText(row({ phase: 'fixing', kind: null, said: null }), 152)).toBe('Fixing “Card says how many rows” · 52s')
    expect(workingText(row({ phase: 'fixing', change: true }), 152)).toBe('Changing “Card says how many rows” · 52s')
    expect(workingText(row({ phase: 'testing' }), 400)).toBe('Testing “Card says how many rows” · 5 min')
    expect(fixText(row({ phase: 'applying' }))).toBe('Reloading thimble…')
    expect(fixText(row({ phase: 'restarting' }))).toBe('Reloading thimble…')
    expect(fixText(ready())).toBe('thimble fixed: Card says how many rows · tests pass')
    expect(fixText(row())).toBe('Card says how many rows is on')
  })

  test('a ready fix asks; Undo on a fix that is on, Redo on one that did not pass, nothing while it works', () => {
    expect(fixActions(ready())).toEqual(['use', 'what', 'later'])
    expect(fixActions(row())).toEqual(['undo'])
    expect(fixActions(row({ state: 'failed', kind: 'failed' }))).toEqual(['redo'])
    expect(fixActions(row({ state: 'off', kind: 'undone' }))).toEqual([])
    expect(fixActions(row({ phase: 'testing' }))).toEqual([])
  })

  test('What changed is a few lines, not a diff', () => {
    expect(changedLines(ready())).toEqual([
      { label: 'You asked', text: "make this card's title say how many rows" },
      { label: 'Claude did', text: "The card's title ends with its row count." },
      { label: 'Changed', text: '2 files · tests pass' },
    ])
  })

  let fixes: FixRow[] = []
  let every: FixRow[] = []
  let sent: string[] = []
  beforeEach(() => {
    fixes = []
    every = []
    sent = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      const u = String(url)
      if (method !== 'GET') sent.push(`${method} ${u.replace(/^.*\/api/, '')}`)
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
      if (u.endsWith('/fixes?every=true') && method === 'GET') return json({ problem: '', fixes: every })
      if (u.endsWith('/fixes') && method === 'GET') return json({ problem: '', fixes })
      return json({ ok: true, restart: true })
    })
  })
  afterEach(() => {
    unmountAll()
    vi.unstubAllGlobals()
  })
  const click = (el: Element | null | undefined) => act(async () => (el as HTMLButtonElement).click())
  const button = (el: Element, name: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === name)

  const said = 'thimble fixed: Card says how many rows · tests pass'
  const result = (latest = true, text = said, kind = 'ready') => <FixResult ws="mini" fid={3} text={text} kind={kind} latest={latest} />

  test('nothing to say, nothing shown; a fix that works shows its row above the composer, and nothing at the top', async () => {
    const foot = await mount(<FixWorking />)
    const top = await mount(<FixPage ws="mini" />)
    await settle()
    expect(foot.querySelector('.chat-fix')).toBeNull()
    fixes = [row({ phase: 'fixing', kind: null, said: null, state: 'working' })]
    await act(async () => dispatch({ type: 'fix', id: 3, state: 'fixing' } as never))
    await settle()
    expect(foot.querySelector('.chat-fix')?.getAttribute('data-phase')).toBe('fixing')
    expect(foot.querySelector('.chat-fix .spinner')).not.toBeNull()
    expect(foot.querySelector('.chat-fix-text')?.textContent).toMatch(/^Fixing “Card says how many rows” · /)
    fixes = [ready()]
    await act(async () => dispatch({ type: 'fix', id: 3, state: 'ready' } as never))
    await settle()
    expect(top.innerHTML).toBe('')
  })

  test('the newest row of a fix that passed asks: Use it now puts it on, and the row says Reloading thimble…', async () => {
    fixes = [ready()]
    const el = await mount(result())
    await settle()
    expect(el.querySelector('.chat-fix')?.getAttribute('data-kind')).toBe('ready')
    expect(el.querySelector('.chat-fix-lead')?.textContent).toBe('thimble fixed:')
    expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Use it now', 'What changed', 'Later'])
    expect(sent).toEqual([])
    await click(button(el, 'What changed'))
    expect(el.querySelector('.chat-fix-what')?.textContent).toContain('Changed:2 files · tests pass')
    fixes = [ready({ phase: 'applying', kind: null, said: null })]
    await click(button(el, 'Use it now'))
    await settle()
    expect(sent).toEqual(['POST /fixes/3/apply'])
    expect(el.querySelector('.chat-fix')?.getAttribute('data-kind')).toBe('reloading')
    expect(el.querySelector('.chat-fix-text')?.textContent).toBe('Reloading thimble…')
    // the server is back with the fix on: the row says what it said, and asks nothing more
    fixes = []
    await act(async () => bus.emit('wsStream', { connected: true } as never))
    await settle()
    expect(el.querySelector('.chat-fix')).toBeNull()
    expect(el.querySelector('.chat-fix-said')?.textContent).toBe(said)
    expect(el.querySelector('button')).toBeNull()
  })

  test('an earlier row of a fix is a quiet line of what it said, with no clicks', async () => {
    fixes = [ready()]
    const el = await mount(result(false, '“Card says how many rows” did not pass: its tests failed', 'failed'))
    await settle()
    expect(el.querySelector('.chat-fix-said')?.getAttribute('data-kind')).toBe('failed')
    expect(el.textContent).toBe('“Card says how many rows” did not pass: its tests failed')
    expect(el.querySelector('button')).toBeNull()
  })

  test('Later: the row asks no more; Your fixes still offers Use it', async () => {
    fixes = [ready()]
    const el = await mount(result())
    const top = await mount(<FixPage ws="mini" />)
    await settle()
    fixes = []
    await click(button(el, 'Later'))
    await settle()
    expect(sent).toEqual(['POST /fixes/3/dismiss'])
    expect(el.querySelector('.chat-fix-said')?.textContent).toBe(said)
    expect(el.querySelector('button')).toBeNull()
    every = [ready({ kind: null, said: null }), row({ id: 2, title: 'Wider pane', kind: null })]
    await act(async () => bus.emit('fixList', { open: true }))
    await settle()
    const items = [...top.querySelectorAll('.chat-fixes-list li')].map((li) => li.textContent)
    expect(items).toEqual(['Card says how many rowsreadyUse it', 'Wider paneonUndo'])
    await click(button(top, 'Use it'))
    expect(sent).toEqual(['POST /fixes/3/dismiss', 'POST /fixes/3/apply'])
  })

  test('a fix that is on, where the server cannot start again by itself, offers Undo', async () => {
    fixes = [row()]
    const el = await mount(result(true, 'Card says how many rows is on', 'fixed'))
    await settle()
    expect(el.querySelector('.chat-fix-text')?.textContent).toBe('Card says how many rows is on')
    expect(el.querySelector('.chat-fix')?.getAttribute('data-kind')).toBe('fixed')
    await click(button(el, 'Undo'))
    expect(sent).toEqual(['POST /fixes/3/undo'])
  })

  test('a fix that did not pass says why, with Redo', async () => {
    fixes = [row({ state: 'failed', kind: 'failed', said: '“Card says how many rows” did not pass: its tests failed in the sandbox' })]
    const el = await mount(result(true, '“Card says how many rows” did not pass: its tests failed in the sandbox', 'failed'))
    await settle()
    expect(el.querySelector('.chat-fix-text')?.textContent).toContain('its tests failed in the sandbox')
    expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Redo'])
    await click(button(el, 'Redo'))
    expect(sent).toEqual(['POST /ws/mini/fixes/3/redo'])
  })

  test('back from the restart with something typed: the row offers Reload', async () => {
    fixes = [ready()]
    const el = await mount(result())
    await settle()
    await act(async () => bus.emit('fixHeld', { id: 3, held: 'typed' }))
    expect(el.querySelector('.chat-fix')?.getAttribute('data-kind')).toBe('reload')
    expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Reload'])
  })

  test("the stream's fix event reaches the bus", () => {
    const got: unknown[] = []
    const off = bus.on('fix', (e) => void got.push(e))
    dispatch({ type: 'fix', id: 4, state: 'testing' } as never)
    off()
    expect(got).toEqual([{ id: 4, state: 'testing' }])
  })
})
