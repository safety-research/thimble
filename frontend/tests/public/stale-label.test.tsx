// @vitest-environment jsdom
// A card thimble runs again because a label it read changed (cell.regenerating_for) shimmers as a card under revision
// and its label's tag says so in its tooltip; no card or label sheet offers a Regenerate Card button.
import { act } from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { CardFace, labelTagTip } from '../../src/canvas/CardFace.tsx'
import { CanvasContext } from '../../src/canvas/context.ts'
import { TIP_DELAY_MS } from '../../src/components/Tooltip.tsx'
import type { Cell, Concept } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(() => {
  unmountAll()
  vi.useRealTimers()
})

const label = { id: 'k1', name: 'mentions dse', unit: 'record', kind: 'regex', spec: 'dse', labels: ['yes', 'no'], rev: 3, changes: [{ rev: 3, what: 'prompt', text: 'its prompt' }] } as unknown as Concept

const cell = (over: Partial<Cell>): Cell => ({ id: 'c1', title: 'How many runs mention dse?', created_by: 'main', ts: '2026-10-01T00:00:00Z', labels: ['k1'], label_revs: { k1: 3 }, code: 'x = 1', outputs: [], status: 'ok', ...over }) as Cell

const face = (c: Cell) =>
  mount(
    <CanvasContext.Provider value={{ ws: 'ws', filters: null, keep: null, concepts: new Map([['k1', label]]), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set(), refresh: () => undefined, openThread: () => undefined }}>
      <CardFace cell={c} width={400} label={{ concept: null, error: null, reload: async () => undefined, set: () => undefined }} />
    </CanvasContext.Provider>,
  )

async function tipOf(el: HTMLElement): Promise<string | null> {
  const tag = el.querySelector<HTMLElement>('.bcell-tag')!
  vi.useFakeTimers()
  await act(async () => {
    tag.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body }))
    vi.advanceTimersByTime(TIP_DELAY_MS + 10)
  })
  return document.querySelector('[role="tooltip"]')?.textContent ?? null
}

test('the tag tooltip names a label the card is running again for, then unrun edits, then a stale label', () => {
  const stale = new Map([['k1', 'its prompt']])
  const edited = new Map([['k1', ['its prompt']]])
  expect(labelTagTip('k1', new Set(['k1']), edited, stale)).toBe('Stale label: card regenerating…')
  expect(labelTagTip('k1', new Set(), edited, stale)).toBe('Edited, not run yet: its prompt')
  expect(labelTagTip('k1', new Set(), new Map(), stale)).toBe('Stale label')
  expect(labelTagTip('k1', new Set(), new Map(), new Map())).toBeNull()
})

test('a card run again for a changed label shimmers and its tag says why, with no Regenerate Card button', async () => {
  const el = await face(cell({ status: 'running', regenerating_for: ['k1'] }))
  const card = el.querySelector('.canvas-card')!
  expect(card.classList.contains('is-regenerating')).toBe(true)
  expect(el.querySelector('.bcell-tag.is-plain')).toBeNull()
  expect([...el.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Regenerate Card')
  expect(await tipOf(el)).toBe('Stale label: card regenerating…')
})

test('once the run ends the tag is normal, and a card still stale shows its tag in ink, with no button', async () => {
  let el = await face(cell({ status: 'ok', regenerating_for: null }))
  expect(el.querySelector('.canvas-card')!.classList.contains('is-regenerating')).toBe(false)
  expect(await tipOf(el)).toBeNull()
  unmountAll()
  vi.useRealTimers()
  el = await face(cell({ status: 'ok', label_revs: { k1: 2 } }))
  expect(el.querySelector('.canvas-card')!.classList.contains('is-regenerating')).toBe(false)
  expect(el.querySelector('.bcell-tag')!.classList.contains('is-plain')).toBe(true)
  expect(el.textContent).not.toContain('Regenerate Card')
  expect(await tipOf(el)).toBe('Stale label')
})
