// @vitest-environment jsdom
// The card check shows only problems: a card whose check passed, revised it, runs, was stopped or could not finish has
// no mark; a red ✕ marks numbers its code types in and a revision that would not run; the fix's Undo, Stop and Check
// again are in the card's details.
import { afterEach, beforeAll, expect, test } from 'vitest'
import { CardFace } from '../../src/canvas/CardFace.tsx'
import { CheckDetails } from '../../src/canvas/CheckDetails.tsx'
import { CanvasContext } from '../../src/canvas/context.ts'
import { checkOf, checkProblem, checkState } from '../../src/lib/cardCheck.ts'
import type { Cell } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(unmountAll)

const TAKE = 'agent-03 merged 12 PRs.'
const card = (over: Partial<Cell>): Cell =>
  ({ id: 'c1', kind: 'note', title: 'Who merged most?', takeaway: TAKE, created_by: 'model', ts: '2026-10-06T00:00:00Z', payload: { text: 'x' }, status: 'ok', ...over }) as Cell

const rec = (status: string, extra: Record<string, unknown> = {}) => ({ id: 'chk_1', status, started: '2026-10-06T04:00:00Z', ended: '2026-10-06T04:01:00Z', stages: {}, ...extra })

const CARDS: Record<string, Cell> = {
  passed: card({ check: rec('ok') }),
  revised: card({
    check: rec('fixed'),
    fixes: [{ id: 'fix_1', check: 'chk_1', ts: '2026-10-06T04:01:00Z', state: 'applied', reason: 'the takeaway overstated', fields: ['takeaway'], before: { takeaway: 'agent-03 merged every PR.' }, after: { takeaway: TAKE } }],
  }),
  running: card({ check: rec('pending', { phase: 'checking', ended: null }) }),
  stopped: card({ check: rec('stopped') }),
  unfinished: card({ check: rec('error', { reason: "Anthropic's API is overloaded" }) }),
  typed: card({ check: rec('ok', { stages: { render: { status: 'ok', typed: ['12', '35', '44'] } } }) }),
  unrun: card({
    check: rec('error', { reason: 'its revision was not kept: its code did not run clean: NameError', stages: { critique: { status: 'ok', assessment: [{ problem: '' }, { problem: 'The takeaway names a count the table does not show' }] } } }),
    fixes: [{ id: 'fix_2', check: 'chk_1', ts: '2026-10-06T04:01:00Z', state: 'rejected', reason: 'its code did not run clean: NameError', fields: ['code'], before: { code: '' }, after: { code: 'len(posts)' } }],
  }),
  // a revision an earlier check could not run says nothing about the check that came after it
  olderUnrun: card({
    check: rec('error', { id: 'chk_2', reason: "Anthropic's API is overloaded" }),
    fixes: [{ id: 'fix_2', check: 'chk_1', ts: '2026-10-06T03:01:00Z', state: 'rejected', reason: 'its code did not run clean', fields: ['code'], before: {}, after: {} }],
  }),
}

const ctx = { ws: 'ws', filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set<string>(), refresh: () => undefined, openThread: () => undefined }
const face = (c: Cell, board = true) =>
  mount(
    <CanvasContext.Provider value={ctx}>
      <CardFace cell={c} width={400} label={{ concept: null, error: null, reload: async () => undefined, set: () => undefined }} onCheckAgain={board ? () => undefined : undefined} />
    </CanvasContext.Provider>,
  )
const details = (c: Cell) =>
  mount(
    <CanvasContext.Provider value={ctx}>
      <CheckDetails cell={c} />
    </CanvasContext.Provider>,
  )
const buttons = (el: HTMLElement) => [...el.querySelectorAll('button')].map((b) => b.textContent?.trim())

test('only typed-in numbers and a revision that would not run are problems', () => {
  const problems = Object.fromEntries(Object.entries(CARDS).map(([k, c]) => [k, checkProblem(checkOf(c))]))
  for (const k of ['passed', 'revised', 'running', 'stopped', 'unfinished', 'olderUnrun']) expect(problems[k], k).toBe('')
  expect(problems.typed).toMatch(/types in 3 numbers/)
  expect(problems.unrun).toMatch(/^The takeaway names a count the table does not show\. Its revision of the card would not run: its code did not run clean: NameError\.$/)
})

test("the filter's check state follows the mark: the ✕ is Failed, a check that could not finish Unverified", () => {
  const states = Object.fromEntries(Object.entries(CARDS).map(([k, c]) => [k, checkState(c)]))
  expect(states).toEqual({ passed: 'verified', revised: 'verified', running: 'unverified', stopped: 'unverified', unfinished: 'unverified', typed: 'failed', unrun: 'failed', olderUnrun: 'unverified' })
  expect(checkState(card({}))).toBe('unchecked')
})

test('a card shows no mark unless its check found a problem, and then one red ✕', async () => {
  for (const [k, c] of Object.entries(CARDS)) {
    const el = await face(c)
    const marks = el.querySelectorAll('.bcell-check-mark')
    const problem = k === 'typed' || k === 'unrun'
    expect(marks.length, k).toBe(problem ? 1 : 0)
    if (problem) {
      expect(marks[0].classList.contains('is-problem'), k).toBe(true)
      expect(marks[0].querySelector('.mark-failed')?.textContent, k).toBe('✕')
    }
    expect(el.textContent, k).not.toContain('✓')
    unmountAll()
  }
})

test('a running check shimmers the card, and a fix shows in place', async () => {
  const running = await face(CARDS.running)
  expect(running.querySelector('.canvas-card')?.classList.contains('is-checking')).toBe(true)
  unmountAll()
  const revised = await face(CARDS.revised)
  expect(revised.querySelector('.bcell-take-text')?.textContent).toBe(TAKE)
})

test('the card the check harness draws has no mark', async () => {
  const el = await face(CARDS.typed, false)
  expect(el.querySelectorAll('.bcell-check-mark').length).toBe(0)
})

test("the card's details hold the fix's Undo, Stop while it runs, and Check again", async () => {
  const revised = await details(CARDS.revised)
  expect(buttons(revised)).toEqual(['Undo', 'Check again'])
  expect(revised.textContent).toContain('agent-03 merged every PR.')
  unmountAll()
  expect(buttons(await details(CARDS.running))).toEqual(['Stop'])
  unmountAll()
  const unrun = await details(CARDS.unrun)
  expect(unrun.querySelector('.mark-failed')).not.toBeNull()
  expect(buttons(unrun)).toEqual(['Check again'])
  unmountAll()
  expect(buttons(await details(card({})))).toEqual(['Check the card'])
  unmountAll()
  expect((await details(card({ created_by: 'user' }))).textContent).toBe('')
})
