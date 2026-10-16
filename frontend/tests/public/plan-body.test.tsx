// @vitest-environment jsdom
// A plan card drawn by the canvas's own CardFace (canvas/PlanBody.tsx): each step's number, text and status, what it
// makes as chips (dashed until it runs), a done step as one line that a click opens, a step's details behind Show more,
// the live rows of a running step's runs read from the plan-runs route, the last edit's marks, and no takeaway. The steps' times and refs come from canvas/plan.ts.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CardFace } from '../../src/canvas/CardFace.tsx'
import { CanvasContext } from '../../src/canvas/context.ts'
import { planSteps } from '../../src/canvas/plan.ts'
import type { Cell, PlanStep } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const MIN = 60_000
const now = Date.parse('2026-10-08T12:00:00Z')
const at = (minsAgo: number) => new Date(now - minsAgo * MIN).toISOString()

const step = (over: Partial<PlanStep>): PlanStep => ({ id: 's1', text: 'Run it', makes: [], status: 'not started', note: '', details: '', runs: [], time: '', started: null, ended: null, ...over })

function plan(steps: Partial<PlanStep>[], over: Partial<Cell> = {}): Cell {
  return {
    id: 'p1an0001',
    notebook: 'nb',
    kind: 'plan',
    title: 'Plan: build the environment and pilot it',
    created_by: 'chat:main',
    ts: at(60),
    payload: { steps: steps.map((s, i) => step({ id: `s${i + 1}`, ...s })), follows: null },
    takeaway: '',
    ...over,
  }
}

const RUNS = {
  runs: [
    { step: 2, name: 'Run the emergent condition', chat: 'c0ffee01', state: 'running', latest: 'Bash swarmctl status runs/emergent', elapsed: '40 m' },
    { step: 2, name: 'Run the managed condition', chat: null, state: 'not started', latest: '', elapsed: '' },
  ],
}

let errors: string[] = []
let asked: string[] = []

beforeEach(() => {
  errors = []
  asked = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(' ')))
  vi.stubGlobal('fetch', async (url: string) => {
    asked.push(String(url))
    if (String(url).includes('/plan-runs')) return new Response(JSON.stringify(RUNS), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function face(cell: Cell): Promise<HTMLElement> {
  const ctx = { ws: 'w', filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set<string>(), refresh: () => undefined, openThread: () => undefined }
  const el = await mount(
    <CanvasContext.Provider value={ctx}>
      <CardFace cell={cell} width={560} label={{ concept: null, error: null } as never} />
    </CanvasContext.Provider>,
  )
  await settle()
  return el
}

const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.plan-step')]

describe('a plan card', () => {
  test('a new plan: each step numbered, its status not started, what it makes dashed, no takeaway', async () => {
    const el = await face(plan([{ text: 'Mirror pandas into a local GitHub', makes: ['mirror/', 'forge/'] }, { text: 'Pilot: 2 agents', makes: ['pilot/'] }], { takeaway: 'stray' }))
    const r = rows(el)
    expect(r.map((x) => x.querySelector('.plan-n')?.textContent)).toEqual(['1', '2'])
    expect(r[0].querySelector('.plan-text')?.textContent).toBe('Mirror pandas into a local GitHub')
    expect(r.map((x) => x.querySelector('.plan-status')?.textContent)).toEqual(['not started', 'not started'])
    expect([...r[0].querySelectorAll('.plan-make')].map((c) => [c.textContent, c.classList.contains('is-will')])).toEqual([
      ['mirror/', true],
      ['forge/', true],
    ])
    expect(r[1].getAttribute('data-step')).toBe('s2')
    expect(r[1].getAttribute('data-anchor')).toBe('card:p1an0001#step-2')
    expect(el.querySelector('.plan')?.getAttribute('data-anchor')).toBe('card:p1an0001')
    expect(el.querySelector('.bcell-take')).toBeNull()
    expect(asked.filter((u) => u.includes('/plan-runs'))).toEqual([])
    expect(errors).toEqual([])
  })
})

describe('plan steps, times and refs', () => {
  test("a plan's steps read from its payload, every field filled; another card has none", () => {
    const steps = planSteps({ kind: 'plan', payload: { steps: [{ text: 'a', status: 'bogus' }, { id: 's7', text: 'b', makes: 'x/', runs: ['r'] }] } })
    expect(steps.map((s) => [s.id, s.status, s.makes, s.runs])).toEqual([
      ['s1', 'not started', [], []],
      ['s7', 'not started', ['x/'], ['r']],
    ])
    expect(planSteps({ kind: 'note', payload: { text: 'x' } })).toEqual([])
  })
})
