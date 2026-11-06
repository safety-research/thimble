// @vitest-environment jsdom
// A card on the canvas as the analyst reads it (src/canvas/Cell.tsx, CardFace.tsx, CheckDetails.tsx, PlanBody.tsx): a
// card whose run failed says so in one line; a click on a takeaway's citation opens its evidence and a click on its
// words edits it; the card check marks a card only when it found a problem, and its details hold the fix's Undo; and a
// plan card shows its steps as they go.
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { CardFace } from '../../src/canvas/CardFace.tsx'
import { CellCard } from '../../src/canvas/Cell.tsx'
import { CheckDetails } from '../../src/canvas/CheckDetails.tsx'
import { CanvasContext } from '../../src/canvas/context.ts'
import { DOUBLE_MS } from '../../src/canvas/layout.ts'
import { ERROR_MIME } from '../../src/components/Outputs.tsx'
import type { Cell, MimeBundle, PlanStep } from '../../src/lib/types.ts'
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

test('a plan card shows each step with its status: a running step its time and a live row per run, a done step one line a click opens', async () => {
  const now = Date.parse('2026-10-08T12:00:00Z')
  const at = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString()
  const step = (id: string, over: Partial<PlanStep>): PlanStep => ({ id, text: '', makes: [], status: 'not started', note: '', details: '', runs: [], time: '', started: null, ended: null, ...over })
  const steps = [
    step('s1', { text: 'Mirror pandas', makes: ['mirror/'], status: 'done', note: 'six repos mirrored', started: at(70), ended: at(64) }),
    step('s2', { text: 'Run both conditions', makes: ['runs/'], status: 'running', started: at(40), runs: ['Run the emergent condition', 'Run the managed condition'] }),
    step('s3', { text: 'Ask which model the manager runs on', status: 'needs you' }),
  ]
  const runs = {
    runs: [
      { step: 2, name: 'Run the emergent condition', chat: 'c0ffee01', state: 'running', latest: 'Bash swarmctl status runs/emergent', elapsed: '40 m' },
      { step: 2, name: 'Run the managed condition', chat: null, state: 'not started', latest: '', elapsed: '' },
    ],
  }
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(String(url).endsWith('/ws/ws/cards/p1an0001/plan-runs') ? runs : {}), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  try {
    const el = await face({ id: 'p1an0001', notebook: 'nb', kind: 'plan', title: 'Plan: build the environment and pilot it', created_by: 'chat:main', ts: at(60), payload: { steps, follows: null }, takeaway: '' } as Cell)
    await settle()
    const [done, running, you] = [...el.querySelectorAll<HTMLElement>('.plan-step')]
    expect([done, running, you].map((s) => s.querySelector('.plan-status')?.textContent)).toEqual(['done · 6 m', 'running · 40 m', 'needs you'])
    expect([...running.querySelectorAll('.plan-run')].map((r) => r.getAttribute('data-run'))).toEqual(['Run the emergent condition', 'Run the managed condition'])
    expect(running.querySelector('.plan-run-latest')?.textContent).toBe('⎿ Bash swarmctl status runs/emergent')
    expect(done.querySelector('.plan-note')).toBeNull()
    await act(async () => done.querySelector<HTMLButtonElement>('button.plan-toggle')!.click())
    expect(done.querySelector('.plan-note')?.textContent).toBe('six repos mirrored')
  } finally {
    vi.useRealTimers()
  }
})
