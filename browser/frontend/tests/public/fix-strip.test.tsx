// @vitest-environment jsdom
// thimble fix in the page (src/chat/fix.ts, src/chat/FixStrip.tsx, backend fixes.py): `/thimble-fix <words>` goes to
// the server with a text copy of what the page shows, and one row above the composer says how the newest fix goes:
// what Claude does now while it works, then "✓ thimble fixed: <title> · tests pass" with Undo, or why it did not pass
// with Redo and Dismiss.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fixActions, fixText, fixWords, pageText, type FixRow } from '../../src/chat/fix.ts'
import { FixStrip } from '../../src/chat/FixStrip.tsx'
import { bus } from '../../src/lib/bus.ts'
import { dispatch } from '../../src/lib/events.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const row = (over: Partial<FixRow> = {}): FixRow => ({ id: 3, title: 'Card says how many rows', state: 'on', phase: null, kind: 'fixed', said: 'thimble fixed: Card says how many rows · tests pass', words: "make this card's title say how many rows", tests: 'passed', error: null, at: 1, ...over })

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

describe('the row', () => {
  test('its words: the step while Claude works, how it went after', () => {
    expect(fixText(row({ phase: 'fixing', kind: null, said: null }))).toBe("Fixing: make this card's title say how many rows · Claude works in a copy of thimble")
    expect(fixText(row({ phase: 'testing' }))).toBe('Testing fix 3: Card says how many rows')
    expect(fixText(row({ phase: 'restarting' }))).toBe('thimble restarts with fix 3: Card says how many rows')
    expect(fixText(row())).toBe('thimble fixed: Card says how many rows · tests pass')
  })

  test('Undo on a fix that is on, Redo on one that did not pass, nothing while it works', () => {
    expect(fixActions(row())).toEqual(['undo'])
    expect(fixActions(row({ state: 'failed', kind: 'failed' }))).toEqual(['redo'])
    expect(fixActions(row({ state: 'off', kind: 'undone' }))).toEqual([])
    expect(fixActions(row({ phase: 'testing' }))).toEqual([])
  })

  let fixes: FixRow[] = []
  let sent: string[] = []
  beforeEach(() => {
    fixes = []
    sent = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      const u = String(url)
      if (method !== 'GET') sent.push(`${method} ${u.replace(/^.*\/api/, '')}`)
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
      if (u.endsWith('/fixes') && method === 'GET') return json({ problem: '', fixes })
      return json({ ok: true, restart: true })
    })
  })
  afterEach(() => {
    unmountAll()
    vi.unstubAllGlobals()
  })
  const click = (el: Element | null | undefined) => act(async () => (el as HTMLButtonElement).click())

  test('nothing to say, no row; a fix that works shows its step and follows the stream', async () => {
    const el = await mount(<FixStrip ws="mini" />)
    await settle()
    expect(el.querySelector('.chat-fix')).toBeNull()
    fixes = [row({ phase: 'fixing', kind: null, said: null, state: 'working' })]
    await act(async () => dispatch({ type: 'fix', id: 3, state: 'fixing' } as never))
    await settle()
    expect(el.querySelector('.chat-fix')?.getAttribute('data-phase')).toBe('fixing')
    expect(el.querySelector('.chat-fix .spinner')).not.toBeNull()
    expect(el.querySelectorAll('.chat-fix button')).toHaveLength(0)
  })

  test('the fixed row offers Undo, which takes the fix off; × dismisses it', async () => {
    fixes = [row()]
    const el = await mount(<FixStrip ws="mini" />)
    await settle()
    expect(el.querySelector('.chat-fix-text')?.textContent).toBe('thimble fixed: Card says how many rows · tests pass')
    expect(el.querySelector('.chat-fix')?.getAttribute('data-kind')).toBe('fixed')
    await click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Undo'))
    await click(el.querySelector('.chat-fix-x'))
    expect(sent).toEqual(['POST /fixes/3/undo', 'POST /fixes/3/dismiss'])
  })

  test('a fix that did not pass says why, with Redo and Dismiss', async () => {
    fixes = [row({ state: 'failed', kind: 'failed', said: 'Fix 3 did not pass: Card says how many rows · its tests failed in the sandbox' })]
    const el = await mount(<FixStrip ws="mini" />)
    await settle()
    expect(el.querySelector('.chat-fix-text')?.textContent).toContain('its tests failed in the sandbox')
    const names = [...el.querySelectorAll('button')].map((b) => b.textContent)
    expect(names).toEqual(['Redo', 'Dismiss'])
    await click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Redo'))
    expect(sent).toEqual(['POST /ws/mini/fixes/3/redo'])
  })

  test("the stream's fix event reaches the bus", () => {
    const got: unknown[] = []
    const off = bus.on('fix', (e) => void got.push(e))
    dispatch({ type: 'fix', id: 4, state: 'testing' } as never)
    off()
    expect(got).toEqual([{ id: 4, state: 'testing' }])
  })
})
