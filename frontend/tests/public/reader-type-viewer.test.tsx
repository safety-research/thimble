// @vitest-environment jsdom
// Viewers for a file type in the File browser (src/files/Reader.tsx, typeViewers.ts). A file whose best built-in mode
// is Raw shows the viewer proposed for its type beside Raw: the sparkle and the name, the proposal's why on hover, a
// click that builds it (a spinner at once) as the file's mode once built, even after a pick of Raw, and an × that
// dismisses it. With no proposal for the type nothing shows and nothing is asked. A built viewer for the type is a mode
// before Raw and the file's default, and a pick of Raw for the file still wins. The files are invented and the server
// is a fake fetch.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { TIP_DELAY_MS } from '../../src/components/Tooltip.tsx'
import { Reader } from '../../src/files/Reader.tsx'
import { bus } from '../../src/lib/bus.ts'
import { storageKey, writeStorage } from '../../src/lib/workspace.ts'
import { suffixOf, typeProposal, typeSuffix } from '../../src/files/typeViewers.ts'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import type { Proposal, View } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const labels = { on: [], all: [], presence: new Map(), byId: new Map() } as unknown as FilesLabels
const WHY = 'A session replayed as the terminal showed it, with a scrubber over its time.'

const proposal = (status: Proposal['status'], extra: Partial<Proposal> = {}): Proposal => ({
  slug: 'session-replay', name: 'Session Replay', status, why: WHY, claims: ['**/*.rec'], arrangement: 'one file', proposed_by: 'orient', ts: '2026-09-25T10:00:00+00:00', ...extra,
})
const viewer = (extra: Partial<View> = {}): View => ({
  slug: 'session-replay', origin: 'workspace', name: 'Session Replay', why: WHY, claims: ['**/*.rec'], accepts: [{ form: 'L<n>', means: 'an event' }], declares: [], default: false, libs: [], built: '2026-09-25T10:05:00+00:00', ok: true, forms: [], file_type: true, ...extra,
})

interface Server {
  proposals: Proposal[]
  views: View[]
  eligible: boolean
  suggested: string | null
}
let server: Server
let calls: { method: string; url: string }[] = []

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  calls = []
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ method, url })
    if (url.includes('/source')) {
      const lines = ['{"v": 2, "cols": 80}', '[0.5, "o", "$ make test"]', '[1.2, "o", "12 passed"]']
      return json({ path: 'runs/a.rec', kind: 'text', total_lines: lines.length, start: 1, records: lines.map((text, i) => ({ line: i + 1, record: { text }, blocks: [], meta: {} })) })
    }
    if (url.includes('/views/suggestions')) return json({ path: 'runs/a.rec', suffix: '.rec', eligible: server.eligible, reason: '', answer: null, proposal: null })
    if (url.includes('/views/suggest')) {
      if (server.suggested) server.proposals = [proposal('suggested', { slug: server.suggested })]
      return json({ slug: server.suggested })
    }
    if (url.endsWith('/accept')) {
      server.proposals = server.proposals.map((p) => ({ ...p, status: 'queued' as const, asked: true }))
      return json(server.proposals[0])
    }
    if (method === 'DELETE' && url.includes('/views/proposals/')) {
      server.proposals = []
      return json({ ok: true })
    }
    if (url.includes('/views/proposals')) return json(server.proposals)
    if (url.includes('/views?')) return json(server.views)
    return json({})
  })
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

async function open(ws: string, onMode?: (title: string) => void) {
  const el = await mount(<Reader workspace={ws} path="runs/a.rec" kind="text" lead={null} labels={labels} onMode={onMode} />)
  for (let i = 0; i < 4; i++) await settle()
  return el
}

const modes = (el: HTMLElement) => [...el.querySelectorAll('.reader-modes .seg[role="radiogroup"] .seg-opt')].map((o) => [o.textContent, o.classList.contains('active')])

describe('a viewer proposed for the file type', () => {
  test('shows beside Raw with the sparkle, says what it shows on hover, and builds on a click', async () => {
    server = { proposals: [proposal('suggested')], views: [], eligible: false, suggested: null }
    const el = await open('suggested')
    expect(modes(el)).toEqual([['Raw', true]])
    const chip = el.querySelector('.reader-modes .files-proposal[data-status="suggested"]')!
    expect(chip).not.toBeNull()
    const opt = chip.querySelector<HTMLButtonElement>('.files-proposal-opt')!
    expect(opt.querySelector('.seg-label')?.textContent).toBe('Session Replay')
    expect(opt.querySelector('.icon-sparkle')).not.toBeNull()
    expect(chip.querySelector('[aria-label="Dismiss Session Replay"]')).not.toBeNull()
    vi.useFakeTimers()
    act(() => opt.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
    act(() => opt.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false })))
    act(() => vi.advanceTimersByTime(TIP_DELAY_MS + 10))
    vi.useRealTimers()
    expect(document.querySelector('.tip.files-proposal-tip')?.textContent).toBe(WHY)
    await act(async () => opt.click())
    expect(el.querySelector('.reader-modes .files-proposal .spinner'), 'a spinner at once').not.toBeNull()
    await settle()
    await settle()
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/ws/suggested/views/proposals/session-replay/accept')).toBe(true)
    const building = el.querySelector('.reader-modes .files-proposal')!
    expect(building.getAttribute('data-status')).toBe('queued')
    expect(building.querySelector('.icon-view')).not.toBeNull()
    expect(building.querySelector('.spinner')).not.toBeNull()
  })

  test('built from the chip after a pick of Raw, it opens as the file\'s mode', async () => {
    server = { proposals: [proposal('suggested')], views: [], eligible: false, suggested: null }
    writeStorage(storageKey('picked', 'viewOf:runs/a.rec'), 'raw')
    const el = await open('picked')
    await act(async () => el.querySelector<HTMLButtonElement>('.reader-modes .files-proposal-opt')!.click())
    await settle()
    server = { proposals: [proposal('built')], views: [viewer()], eligible: false, suggested: null }
    await act(async () => bus.emit('view', { slug: 'session-replay', status: 'built' }))
    for (let i = 0; i < 3; i++) await settle()
    expect(modes(el)).toEqual([
      ['Session Replay', true],
      ['Raw', false],
    ])
    expect(el.querySelector('.reader-viewer .viewer-frame')).not.toBeNull()
  })

  test('× dismisses it', async () => {
    server = { proposals: [proposal('suggested')], views: [], eligible: false, suggested: null }
    const el = await open('dismissed')
    await act(async () => el.querySelector<HTMLButtonElement>('.reader-modes .files-proposal-x')!.click())
    expect(el.querySelector('.reader-modes .files-proposal')).toBeNull()
    await settle()
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/ws/dismissed/views/proposals/session-replay')).toBe(true)
    expect(el.querySelector('.reader-modes')).toBeNull()
  })

  test('with no proposal for the type, nothing shows and nothing is asked', async () => {
    server = { proposals: [], views: [], eligible: true, suggested: 'session-replay' }
    const el = await open('none')
    for (let i = 0; i < 4; i++) await settle()
    expect(calls.some((c) => c.url.includes('/views/suggest'))).toBe(false)
    expect(el.querySelector('.reader-modes')).toBeNull()
  })
})

describe('a built viewer for the file type', () => {
  test('is a mode before Raw and the default, drawn in the reader; a pick of Raw wins', async () => {
    server = { proposals: [proposal('built')], views: [viewer()], eligible: false, suggested: null }
    const titles: string[] = []
    const el = await open('built', (t) => titles.push(t))
    expect(modes(el)).toEqual([
      ['Session Replay', true],
      ['Raw', false],
    ])
    expect(el.querySelector('.reader-viewer .viewer-frame')).not.toBeNull()
    expect(el.querySelector('.reader-body'), 'no raw lines under it').toBeNull()
    expect(el.querySelector('.reader-find-open'), 'no find over a view').toBeNull()
    expect(el.querySelector('.files-proposal')).toBeNull()
    expect(titles.at(-1)).toBe('Session Replay')
    const raw = [...el.querySelectorAll<HTMLButtonElement>('.reader-modes .seg-opt')].find((o) => o.textContent === 'Raw')!
    await act(async () => raw.click())
    await settle()
    expect(modes(el)).toEqual([
      ['Session Replay', false],
      ['Raw', true],
    ])
    expect(el.querySelector('.reader-viewer')).toBeNull()
    expect(el.querySelector('.reader-body')).not.toBeNull()
    unmountAll()
    const again = await open('built')
    expect(modes(again)[1], 'the pick is kept for the file').toEqual(['Raw', true])
  })

  test('a view that claims named files is no mode', async () => {
    server = { proposals: [], views: [viewer({ claims: ['runs/a.rec'], file_type: false })], eligible: false, suggested: null }
    const el = await open('named')
    expect(el.querySelector('.reader-viewer')).toBeNull()
    expect(modes(el)).toEqual([])
  })
})

test('the suffix a claim names, and the proposal for a file type', () => {
  expect(typeSuffix('**/*.REC')).toBe('.rec')
  expect(typeSuffix('*.rec')).toBe('.rec')
  expect(typeSuffix('runs/*.rec')).toBeNull()
  expect(suffixOf('runs/a.REC')).toBe('.rec')
  expect(suffixOf('runs/.hidden')).toBe('')
  expect(suffixOf('Makefile')).toBe('')
  const list = [proposal('dropped', { slug: 'a' }), proposal('built', { slug: 'b' }), proposal('building', { slug: 'c' })]
  expect(typeProposal(list, 'runs/z.rec')?.slug).toBe('c')
  expect(typeProposal(list, 'runs/z.txt')).toBeNull()
  expect(typeProposal(null, 'runs/z.rec')).toBeNull()
})
