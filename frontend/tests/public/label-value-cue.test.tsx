// @vitest-environment jsdom
// A label card's value says what a click on it does (src/canvas/bodies.tsx ValueButton, labelValueCue): a tooltip on
// hover and at keyboard focus, such as "Show these 4,124 records in Files", and "Show all records in Files" while that
// value's filter is on.
import { act } from 'react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { labelValueCue } from '../../src/canvas/bodies.tsx'
import { CardFace } from '../../src/canvas/CardFace.tsx'
import { CanvasContext, type CanvasCtx } from '../../src/canvas/context.ts'
import { api, labelApi } from '../../src/lib/api.ts'
import type { Cell, Concept, ConceptDetail } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const VALUES = ['note to a peer', 'link list']
const COUNTS = { 'note to a peer': 4124, 'link list': 1 }
const RUN = { ts: '2026-10-15T11:58:00+00:00', paths: ['edits.jsonl'], total: 4125, matched_total: 4125, labeled: 4125, failed: 0, status: 'done', matches: 4124 }
const LABEL = { id: 'k1', name: 'edit kind', description: '', unit: 'record', kind: 'code', spec: 'def label(r):\n    return "link list", 1.0', glob: 'edits.jsonl', marks: 'record', labels: VALUES, counts: COUNTS, n_labeled: 4125, created_by: 'model', ts: '', shown: true, last_run: RUN } as unknown as Concept
const DETAIL = { ...LABEL, applications: [RUN], run: null } as unknown as ConceptDetail
const CELL = { id: 'c1', notebook: 'g', kind: 'label', title: 'What does each edit hold?', takeaway: '', created_by: 'model', ts: '', labels: ['k1'], payload: { concept: 'k1' } } as unknown as Cell

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('what a click on a value does', () => {
  test('in the words of where the scope shows its units', () => {
    expect(labelValueCue('files', 'record', 43, false)).toBe('Show these 43 records in Files')
    expect(labelValueCue('files', 'record', 1, false)).toBe('Show this record in Files')
    expect(labelValueCue('files', 'record', 43, true)).toBe('Show all records in Files')
    expect(labelValueCue('canvas', 'cell', 3, false)).toBe('Show only these 3 cards')
    expect(labelValueCue('report', 'span', 5, false)).toBe('Show only these 5 sentences in the report')
    expect(labelValueCue('files', 'record', null, false)).toBe('Show the records with this value in Files')
  })

  test('the value says it on hover', async () => {
    vi.spyOn(labelApi, 'rows').mockResolvedValue({ rows: [], total: 0 } as never)
    vi.spyOn(api, 'settings').mockRejectedValue(new Error('no server'))
    const ctx: CanvasCtx = { ws: 'ws', filters: null, keep: null, concepts: new Map([[DETAIL.id, DETAIL]]), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set(), refresh: () => undefined, openThread: () => undefined }
    const el = await mount(
      <CanvasContext.Provider value={ctx}>
        <CardFace cell={CELL} width={600} label={{ concept: DETAIL, error: null, reload: async () => undefined, set: () => undefined } as never} />
      </CanvasContext.Provider>,
    )
    await settle()
    const btn = [...el.querySelectorAll<HTMLButtonElement>('button.bcell-value')].find((b) => b.textContent === 'note to a peer')!
    vi.useFakeTimers()
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
      vi.advanceTimersByTime(1000)
    })
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Show these 4,124 records in Files')
  })
})
