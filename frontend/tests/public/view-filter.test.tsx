// @vitest-environment jsdom
// Labels in every view, the page half: what a view's page hears of the labels (files/labels.ts pageLabels), the Files
// label filter's verdict on each record the page shows (withKeeps), and the view's own pane, which shows its Labels
// sidebar beside it (ViewSurface), a funnel on each label's row that sets the Files filter, and the filter as a chip
// that clears it. The server is a fake fetch.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { pageLabels, withKeeps, type ViewMark } from '../../src/files/labels.ts'
import { ViewSurface } from '../../src/files/ViewSurface.tsx'
import type { Concept, LabelRow } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const concept = (id: string, name: string, shown: boolean, classes: Concept['classes']): Concept =>
  ({ id, name, unit: 'record', kind: 'regex', labels: (classes ?? []).map((c) => c.name), classes, shown, marks: 'record' }) as unknown as Concept

const ASKS = concept('k1', 'asks', true, [{ name: 'asks', color: 3, highlight: true }, { name: 'other', color: 0, highlight: false }])
const TONE = concept('k2', 'tone', false, [{ name: 'calm', color: 5, highlight: true }, { name: 'curt', color: 6, highlight: true }])
const resolve = (t: string) => `#${t.slice(2)}`

describe('what a view page hears of the labels', () => {
  test('the labels that are on with their highlighted values, and the filter with its label and value colour', () => {
    const byId = new Map([ASKS, TONE].map((k) => [k.id, k]))
    expect(pageLabels([ASKS], null, byId, resolve)).toEqual({ on: [{ name: 'asks', colour: '#label-3', values: [{ name: 'asks', colour: '#label-3' }] }], filter: null })
    // the filter's label counts as on while it filters
    const got = pageLabels([ASKS], { concept: 'k2', value: 'curt' }, byId, resolve)
    expect(got.on.map((l) => l.name)).toEqual(['asks', 'tone'])
    expect(got.filter).toEqual({ label: 'tone', value: 'curt', colour: '#label-6' })
  })

  test('the filter keeps a record whose row takes its value, and a record it drops and no label marks is left out', () => {
    const rows = new Map<string, Map<string, LabelRow>>([
      ['a.jsonl#L1', new Map([['k1', { label: 'asks' } as LabelRow]])],
      ['a.jsonl#L2', new Map([['k1', { label: 'other' } as LabelRow]])],
      ['a.jsonl#L3', new Map([['k1', { label: 'other', analyst: 'asks' } as LabelRow]])],
    ])
    const marks: Record<string, ViewMark> = { 'a.jsonl#L1': { bar: 'var(--label-3)', names: ['asks'], spans: [] } }
    const refs = ['a.jsonl#L1', 'a.jsonl#L2', 'a.jsonl#L3', 'a.jsonl#L4', 'view:v/k']
    expect(withKeeps(marks, null, rows, refs)).toBe(marks)
    expect(withKeeps(marks, { concept: 'k1', value: 'asks' }, rows, refs)).toEqual({
      'a.jsonl#L1': { bar: 'var(--label-3)', names: ['asks'], spans: [], keep: true },
      'a.jsonl#L3': { keep: true },
    })
  })
})

describe("a view's own pane", () => {
  let calls: { url: string; method: string; body: unknown }[] = []
  let filters: Record<string, unknown> = {}
  beforeEach(() => {
    calls = []
    filters = {}
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : null })
      const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } })
      if (u.includes('/concepts')) return json([ASKS, TONE])
      if (u.includes('/labels/presence')) return json([])
      if (u.endsWith('/filters') && method === 'PUT') {
        const b = JSON.parse(String(init!.body))
        filters = { files: { concept: b.concept, value: b.value } }
        return json(filters)
      }
      if (u.includes('/filters')) return json(filters)
      if (u.includes('/sources')) return json({ path: '.', files: [{ path: 'board.jsonl', kind: 'jsonl', size_bytes: 10 }], folders: [], n_files: 1 })
      if (u.includes('/frame')) return new Response('<html><head></head><body></body></html>', { status: 200 })
      return json({})
    })
  })
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  test('shows the Labels sidebar while a label is on, and a funnel on a row sets the Files filter the view keeps its records by', async () => {
    const el = await mount(<ViewSurface ws="w" view={{ slug: 'threads', name: 'Threads', claims: ['board.jsonl'], first_file: 'board.jsonl' }} active />)
    await settle()
    await settle()
    const side = el.querySelector('aside.files-side-labels')
    expect(side).not.toBeNull()
    expect([...side!.querySelectorAll('.files-label-name')].map((n) => n.textContent)).toEqual(['asks', 'tone'])
    const funnel = side!.querySelector<HTMLButtonElement>('button[aria-label="Show only the records asks marks"]')!
    expect(funnel).not.toBeNull()
    await act(async () => funnel.click())
    const put = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/filters'))
    expect(put?.body).toEqual({ scope: 'files', concept: 'k1', value: 'asks' })
  })

  test('shows the Files filter as a chip in its head, which clears it', async () => {
    filters = { files: { concept: 'k1', value: 'asks' } }
    const el = await mount(<ViewSurface ws="w2" view={{ slug: 'threads', name: 'Threads', claims: ['board.jsonl'], first_file: 'board.jsonl' }} active />)
    await settle()
    await settle()
    const chip = el.querySelector<HTMLElement>('.view-pane-head .view-pane-filter')
    expect(chip?.textContent).toContain('asks · asks')
    await act(async () => chip!.click())
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/filters/files'))).toBe(true)
  })
})
