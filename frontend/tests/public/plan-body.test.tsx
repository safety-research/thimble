// @vitest-environment jsdom
// A plan card drawn by the canvas's own CardFace (canvas/PlanBody.tsx): each step's number, text and status, what it
// makes as chips (dashed until it runs), a done step as one line that a click opens, the live rows of a running step's
// runs read from the plan-runs route, and no takeaway. The steps' times and refs come from canvas/plan.ts.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CardFace } from '../../src/canvas/CardFace.tsx'
import { CanvasContext } from '../../src/canvas/context.ts'
import { durationWords, isCompact, newPlans, planSteps, statusWords, stepRef, stepTime } from '../../src/canvas/plan.ts'
import { planStepRef, plainStep, toolGroupName, toolSummary } from '../../src/chat/model.ts'
import { cardPartLabel, parseRef, refLabel } from '../../src/lib/refs.ts'
import type { Cell, PlanStep } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const MIN = 60_000
const now = Date.parse('2026-10-08T12:00:00Z')
const at = (minsAgo: number) => new Date(now - minsAgo * MIN).toISOString()

const step = (over: Partial<PlanStep>): PlanStep => ({ id: 's1', text: 'Run it', makes: [], status: 'not started', note: '', runs: [], time: '', started: null, ended: null, ...over })

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

  test('a running step shows its time, its chips solid and a live row per run; a done step is one line a click opens', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    try {
      const el = await face(
        plan([
          { text: 'Mirror pandas', makes: ['mirror/'], status: 'done', note: 'six repos mirrored', started: at(70), ended: at(64) },
          { text: 'Run both conditions', makes: ['runs/'], status: 'running', started: at(40), runs: ['Run the emergent condition', 'Run the managed condition'] },
          { text: 'Ask which model the manager runs on', status: 'needs you' },
        ]),
      )
      const [done, running, you] = rows(el)
      expect(done.classList.contains('is-compact')).toBe(true)
      expect(done.querySelector('.plan-under')).toBeNull()
      expect(done.querySelector('.plan-status')?.textContent).toBe('done · 6 m')
      expect(running.querySelector('.plan-status')?.textContent).toBe('running · 40 m')
      expect(running.querySelector('.plan-status')?.classList.contains('is-running')).toBe(true)
      expect(running.querySelector('.plan-make')?.classList.contains('is-will')).toBe(false)
      expect(you.querySelector('.plan-status')?.textContent).toBe('needs you')
      expect(you.querySelector('.plan-status')?.classList.contains('is-needs-you')).toBe(true)
      // the live rows, one per run, as the plan-runs route answers them
      expect(asked.some((u) => u.endsWith('/ws/w/cards/p1an0001/plan-runs'))).toBe(true)
      const runs = [...running.querySelectorAll<HTMLElement>('.plan-run')]
      expect(runs.map((x) => x.getAttribute('data-run'))).toEqual(['Run the emergent condition', 'Run the managed condition'])
      expect(runs[0].classList.contains('is-running')).toBe(true)
      expect(runs[0].querySelector('.plan-run-meta')?.textContent).toBe('running · 40 m')
      expect(runs[0].querySelector('.plan-run-latest')?.textContent).toBe('⎿ Bash swarmctl status runs/emergent')
      expect(runs[0].querySelector('button.plan-run-name')).not.toBeNull()
      expect(runs[1].classList.contains('is-not-started')).toBe(true)
      expect(runs[1].querySelector('.plan-run-latest')).toBeNull()
      // a click opens the done step, and another closes it
      const toggle = done.querySelector<HTMLButtonElement>('button.plan-toggle')!
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      await act(async () => toggle.click())
      expect(done.classList.contains('is-compact')).toBe(false)
      expect(done.querySelector('.plan-note')?.textContent).toBe('six repos mirrored')
      expect(done.querySelector('.plan-make')?.textContent).toBe('mirror/')
      await act(async () => toggle.click())
      expect(done.querySelector('.plan-under')).toBeNull()
      expect(errors).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  test('a done step with nothing more to show has no toggle', async () => {
    const el = await face(plan([{ text: 'Write the prompts', status: 'done', time: '4 m' }]))
    expect(el.querySelector('.plan-toggle')).toBeNull()
    expect(el.querySelector('.plan-status')?.textContent).toBe('done · 4 m')
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

  test("a step's time: the agent's, else start to end, else start to now while it runs", () => {
    expect(durationWords(42)).toBe('42 s')
    expect(durationWords(12 * 60)).toBe('12 m')
    expect(durationWords(2 * 3600)).toBe('2 h')
    expect(durationWords(80 * 60)).toBe('1 h 20 m')
    expect(stepTime(step({ status: 'running', started: at(40) }), now)).toBe('40 m')
    expect(stepTime(step({ status: 'done', started: at(130), ended: at(10) }), now)).toBe('2 h')
    expect(stepTime(step({ status: 'needs you', started: at(40) }), now)).toBe('')
    expect(stepTime(step({ status: 'done', time: '22 m' }), now)).toBe('22 m')
    expect(statusWords(step({ status: 'running', started: at(40) }), now)).toBe('running · 40 m')
    expect(statusWords(step({}), now)).toBe('not started')
    expect(isCompact(step({ status: 'done' }), new Set())).toBe(true)
    expect(isCompact(step({ status: 'done' }), new Set(['s1']))).toBe(false)
    expect(isCompact(step({ status: 'running' }), new Set())).toBe(false)
  })

  test("a step's ref parses, names its step on a chip, and update_plan's call names it", () => {
    expect(stepRef('p1an0001', 2)).toBe('card:p1an0001#step-2')
    expect(parseRef('card:p1an0001#step-2')).toEqual({ kind: 'cell', cellId: 'p1an0001', step: 2 })
    expect(parseRef('cell:p1an0001#step-12')).toEqual({ kind: 'cell', cellId: 'p1an0001', step: 12 })
    expect(refLabel('card:p1an0001#step-2')).toBe('card · step 2')
    expect(cardPartLabel({ step: 2 }, 'Plan: build it', false)).toBe('Plan: build it · step 2')
    expect(cardPartLabel({ step: 2 }, 'Plan: build it', true)).toBe('step 2')
    expect(planStepRef({ card: 'card:p1an0001', step: 3, status: 'done' })).toBe('card:p1an0001#step-3')
    expect(planStepRef({ card: 'p1an0001', step: '3' })).toBe('card:p1an0001#step-3')
    const call = `mcp__plugin_thimble_thimble__update_plan`
    expect(toolSummary(call, { card: 'card:p1an0001', step: 1, status: 'running' })).toBe('card:p1an0001#step-1')
    expect(toolGroupName(call)).toBe('Cards')
    const row = { kind: 'tool', name: call, input: { card: 'card:p1an0001', step: 1, status: 'running' }, children: [] } as never
    expect(plainStep(row, new Map([['p1an0001', 'Plan: build it']]))).toBe('Updated plan · Plan: build it · step 1 · running')
  })
})

describe("a plan main adds opens the frames it is in", () => {
  // live check plan-cards: the next phase's plan sat under the finished plan in a collapsed frame, its comments hidden
  test('the plans new since the last read, none on the first read', () => {
    const cells = [{ id: 'old', kind: 'plan' }, { id: 'note', kind: 'note' }, { id: 'next', kind: 'plan' }] as Pick<Cell, 'id' | 'kind'>[]
    expect(newPlans(cells, null)).toEqual([])
    expect(newPlans(cells, new Set(['old']))).toEqual(['next'])
    expect(newPlans(cells, new Set(['old', 'next']))).toEqual([])
  })
})
