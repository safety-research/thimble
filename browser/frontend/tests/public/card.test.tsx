// @vitest-environment jsdom
// A card on the canvas as the analyst reads it (src/canvas/Cell.tsx, CardFace.tsx, CheckDetails.tsx): a card whose run
// failed says so in one line; a click on a takeaway's citation opens its evidence and a click on its words edits it; the
// card check marks a card only when it found a problem, and its details hold the fix's Undo; and a label's card names
// its label by the label's own tag alone.
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { CardFace } from '../../src/canvas/CardFace.tsx'
import { CellCard } from '../../src/canvas/Cell.tsx'
import { CheckDetails } from '../../src/canvas/CheckDetails.tsx'
import { CanvasContext } from '../../src/canvas/context.ts'
import { DOUBLE_MS } from '../../src/canvas/layout.ts'
import { ERROR_MIME } from '../../src/components/Outputs.tsx'
import type { Cell, Concept, MimeBundle } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const ctx = { ws: 'ws', filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set<string>(), refresh: () => undefined, openThread: () => undefined }
const noop = () => undefined

/** The card as the board draws it, selected alone; the handlers it calls. */
async function card(cell: Cell) {
  const onEdit = vi.fn()
  const el = await mount(
    <CanvasContext.Provider value={ctx}>
      <CellCard
        cell={cell} x={0} y={0} w={420} h={null} selected alone collapsed={false} deck={false} dragging={false} detailOpen={false} editing={null} z={1}
        register={noop} onPress={noop} onFocusMode={noop} onResizeStart={noop} onAction={noop} onEdit={onEdit}
      />
    </CanvasContext.Provider>,
  )
  await settle()
  return { el, onEdit }
}
const face = (cell: Cell) =>
  mount(
    <CanvasContext.Provider value={ctx}>
      <CardFace cell={cell} width={400} label={{ concept: null, error: null, reload: async () => undefined, set: () => undefined }} onCheckAgain={noop} />
    </CanvasContext.Provider>,
  )
const note = (over: Partial<Cell>): Cell => ({ id: 'c1', kind: 'note', title: 'Who merged most?', created_by: 'model', ts: '2026-10-06T00:00:00Z', payload: { text: 'x' }, status: 'ok', ...over }) as Cell

test("a failed card's body is the error's one line, without its traceback, and the card says it failed", async () => {
  const error = {
    [ERROR_MIME]: {
      ename: 'ValueError',
      evalue: "No runs match the filter.\nThe column 'status' holds only 'pass' and 'fail'.",
      traceback: ['\u001b[0;31mValueError\u001b[0m Traceback (most recent call last)', "Cell In[2], line 6\n----> 6 rate = failures(runs, status='flaky')"],
    },
  } as unknown as MimeBundle
  const { el } = await card({ id: 'c1', kind: 'table', title: 'Which nightly runs failed?', created_by: 'main', ts: '2026-10-15T10:00:00Z', code: "failures(runs, status='flaky')", outputs: [error], status: 'error' } as Cell)
  expect(el.querySelector('.bcell-output .outputs-error')?.textContent).toBe('ValueError: No runs match the filter.')
  expect(el.querySelector('.bcell-failed')?.textContent).toContain('failed')
})

test("a click on a takeaway's citation opens its evidence, and a click on its words edits it", async () => {
  const { el, onEdit } = await card(note({ takeaway: 'agent-03 merged [[12|card:c1#merged/agent-03]] PRs.' }))
  const press = async (target: Element) => {
    await act(async () => {
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 1 }))
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: 1 }))
    })
    // past the wait for a double click
    await act(async () => new Promise((r) => setTimeout(r, DOUBLE_MS + 40)))
  }
  const cited = el.querySelector<HTMLElement>('.bcell-take .mark-words')!
  expect(cited.textContent).toBe('12')
  await press(cited)
  expect(document.querySelector('.refchip-pop.mark-pop')).not.toBeNull()
  expect(onEdit).not.toHaveBeenCalled()
  await press(el.querySelector<HTMLElement>('.bcell-take-text p')!)
  expect(onEdit).toHaveBeenCalledWith('c1', 'takeaway')
})

test("the card check marks a card only for a problem it found, and the card's details hold the fix's Undo", async () => {
  const check = (status: string, extra: Record<string, unknown> = {}) => ({ id: 'chk_1', status, started: '2026-10-06T04:00:00Z', ended: '2026-10-06T04:01:00Z', stages: {}, ...extra })
  const marks = async (c: Cell) => {
    const el = await face(c)
    const got = [...el.querySelectorAll('.bcell-check-mark')].map((m) => m.querySelector('.mark-failed')?.textContent)
    unmountAll()
    return got
  }
  expect(await marks(note({ check: check('ok') } as Partial<Cell>))).toEqual([])
  // numbers its code types in, rather than computes
  expect(await marks(note({ check: check('ok', { stages: { render: { status: 'ok', typed: ['12', '35', '44'] } } }) } as Partial<Cell>))).toEqual(['✕'])
  // a check that revised the card: the card shows the fix, and its details offer Undo
  const revised = note({
    takeaway: 'agent-03 merged 12 PRs.',
    check: check('fixed'),
    fixes: [{ id: 'fix_1', check: 'chk_1', ts: '2026-10-06T04:01:00Z', state: 'applied', reason: 'the takeaway overstated', fields: ['takeaway'], before: { takeaway: 'agent-03 merged every PR.' }, after: { takeaway: 'agent-03 merged 12 PRs.' } }],
  } as Partial<Cell>)
  expect(await marks(revised)).toEqual([])
  const details = await mount(
    <CanvasContext.Provider value={ctx}>
      <CheckDetails cell={revised} />
    </CanvasContext.Provider>,
  )
  expect([...details.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['Undo', 'Check again'])
  expect(details.textContent).toContain('agent-03 merged every PR.')
})

test("a label card names its label by the label's own tag, with no thimble tag that says Label", async () => {
  const k = {
    id: 'k1', name: 'shows a failure', description: '', unit: 'record', kind: 'regex', spec: '(?i)fail', labels: ['yes', 'no'], created_by: 'main',
    ts: '2026-11-01T00:00:00Z', glob: 'runs/*.jsonl', counts: { yes: 10, no: 2 }, n_labeled: 12,
    classes: [{ name: 'yes', color: 1, highlight: true }, { name: 'no', color: 0, highlight: false }],
  } as Concept
  const withLabel = { ...ctx, concepts: new Map([['k1', k]]) }
  const labelCard = (title: string) =>
    mount(
      <CanvasContext.Provider value={withLabel}>
        <CardFace cell={{ id: 'c9', kind: 'label', title, created_by: 'main', ts: '2026-11-01T00:00:00Z', payload: { concept: 'k1' }, status: 'ok' } as Cell} width={400} label={{ concept: k, error: null, reload: async () => undefined, set: () => undefined }} onCheckAgain={noop} />
      </CanvasContext.Provider>,
    )
  // its question of its own, then the label's tag on the row under it
  const asked = await labelCard('Which runs show a failure?')
  await settle()
  expect(asked.querySelector('.bcell-label-who')?.textContent).toBe('shows a failure')
  // the label's name as its head
  const named = await labelCard('shows a failure')
  await settle()
  expect(named.querySelector('.bcell-label-name')?.textContent).toBe('shows a failure')
  for (const el of [asked, named]) {
    expect(el.querySelector('.bcell-kind-tag')).toBeNull()
    expect(el.querySelector('svg.icon-thimble')).toBeNull()
  }
})
