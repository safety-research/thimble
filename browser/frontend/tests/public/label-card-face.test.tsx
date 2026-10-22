// @vitest-environment jsdom
// A label card:
// it reads as a label first, on a row of its own under the question (the Label tag, the label's tag, how it is defined
// and what it ran on, with the total its shares are of); every value has its share of that one total, so the shares add
// up to 100%; there is no line of matched units; the card shows no record of the corpus; its rule opens from a closed
// Rule disclosure; and Definition and records opens the card's details, where the label's records under each value are.
import { act } from 'react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { CardFace } from '../../src/canvas/CardFace.tsx'
import { CanvasContext, type CanvasCtx } from '../../src/canvas/context.ts'
import { labelIdentity, labelShares } from '../../src/canvas/details.ts'
import { api, labelApi } from '../../src/lib/api.ts'
import type { Cell, Concept, ConceptDetail } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const VALUES = ['message to other agents', 'list of links', 'other']
const COUNTS = { 'message to other agents': 4124, 'list of links': 9096, other: 1371 }
const SPEC = 'def label(r):\n    return "other", 1.0'
const RUN = { ts: '2026-10-15T11:58:00+00:00', paths: ['revisions.jsonl'], total: 14591, matched_total: 14591, labeled: 14591, failed: 0, status: 'done', matches: 4124 }
const LABEL = {
  id: 'k1',
  name: 'edit kind',
  description: '',
  unit: 'record',
  kind: 'code',
  spec: SPEC,
  glob: 'revisions.jsonl',
  marks: 'record',
  labels: VALUES,
  counts: COUNTS,
  n_labeled: 14591,
  created_by: 'model',
  ts: '',
  shown: true,
  classes: [
    { name: 'message to other agents', color: 1, highlight: true },
    { name: 'list of links', color: 2, highlight: true },
    { name: 'other', color: 0, highlight: false },
  ],
  last_run: RUN,
} as unknown as Concept
const DETAIL = { ...LABEL, applications: [RUN], run: null } as unknown as ConceptDetail
const RECORD = 'Beschreibe hier die neue Seite. Hallo an die anderen Agenten'
const QUESTION = 'What kind of content does each wiki edit hold?'
const cellOf = (title: string) => ({ id: 'c1', notebook: 'g', kind: 'label', title, takeaway: 'Most edits hold lists of links.', created_by: 'model', ts: '', labels: ['k1'], payload: { concept: 'k1' } }) as unknown as Cell

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
})

async function card(title = QUESTION, k: ConceptDetail = DETAIL, over: Partial<CanvasCtx> = {}) {
  const rows = vi.spyOn(labelApi, 'rows').mockResolvedValue({ rows: VALUES.map((v) => ({ ref: 'revisions.jsonl#L12', label: v, text: RECORD })), total: 3 } as never)
  vi.spyOn(api, 'settings').mockRejectedValue(new Error('no server'))
  const ctx: CanvasCtx = { ws: 'ws', filters: null, keep: null, concepts: new Map([[k.id, k]]), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set(), refresh: () => undefined, openThread: () => undefined, ...over }
  const el = await mount(
    <CanvasContext.Provider value={ctx}>
      <CardFace cell={cellOf(title)} width={600} label={{ concept: k, error: null, reload: async () => undefined, set: () => undefined } as never} />
    </CanvasContext.Provider>,
  )
  await settle()
  return { el, rows }
}

const shareColumn = (el: HTMLElement) => [...el.querySelectorAll('.bcell-values tbody tr')].map((tr) => tr.querySelectorAll('td')[2]?.textContent)

describe('every value has its share of one total', () => {
  test("each value, the unmatched `other` too, is a share of the units the label labeled, the shares adding up to 100%", () => {
    expect(labelShares(VALUES, COUNTS, 14591)).toEqual({ 'message to other agents': '28%', 'list of links': '62%', other: '10%' })
    // whole percents rounded by largest remainders: 33.3% three times reads 34%, 33%, 33%
    expect(Object.values(labelShares(['a', 'b', 'c'], { a: 1, b: 1, c: 1 }, 3))).toEqual(['34%', '33%', '33%'])
    // a small part keeps its own words, as the terminal's card writes it
    expect(labelShares(['yes', 'no'], { yes: 468, no: 2391534 }, 2392002)).toEqual({ yes: '<0.1%', no: '>99%' })
    expect(labelShares(['yes', 'no'], { yes: 7, no: 993 }, 1000)).toEqual({ yes: '0.7%', no: '99%' })
  })

  test('the table gives every row a share, and no line of matched units stands under it', async () => {
    const { el } = await card()
    expect(shareColumn(el)).toEqual(['28%', '62%', '10%'])
    expect(el.textContent).not.toMatch(/matched/)
  })
})

describe('it reads as a label first', () => {
  test('under its question: the Label tag, the label, how it is defined, what it ran on and the total', async () => {
    const { el } = await card()
    const row = el.querySelector('.bcell-label-row')!
    expect(row.querySelector('.bcell-kind-tag')?.textContent).toBe('Label')
    expect(row.querySelector('.bcell-tag-name')?.textContent).toBe('edit kind')
    expect(row.querySelector('.bcell-label-meta')?.textContent).toBe('code · revisions.jsonl · 14,591 records')
    expect(el.querySelector('.bcell-labels-key')).toBeNull()
    // the row comes before the counts
    expect(row.compareDocumentPosition(el.querySelector('.bcell-values')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('a card with no question of its own says the same in its head', async () => {
    const { el } = await card('edit kind')
    const head = el.querySelector('.bcell-head .bcell-label-head')!
    expect(head.querySelector('.bcell-kind-tag')?.textContent).toBe('Label')
    expect(head.querySelector('.bcell-label-name')?.textContent).toContain('edit kind')
    expect(head.querySelector('.bcell-label-meta')?.textContent).toBe('code · revisions.jsonl · 14,591 records')
  })

  test("a trial says it ran on a sample, a prompt label names its model, and a label of cards says the canvas", () => {
    expect(labelIdentity({ ...LABEL, n_labeled: 25, counts: { yes: 5, no: 20 }, trial: true })).toMatchObject({ how: 'code', where: 'revisions.jsonl', units: 'a sample of 25 records' })
    expect(labelIdentity({ ...LABEL, kind: 'prompt' }, 'Haiku 4.5').how).toBe('prompt · Haiku 4.5')
    expect(labelIdentity({ ...LABEL, unit: 'cell', glob: '', n_labeled: 12 })).toMatchObject({ where: 'canvas', units: '12 cards' })
    expect(labelIdentity({ ...LABEL, glob: 'runs/2026-06/agents/*/transcript.jsonl' })).toMatchObject({ where: '…/transcript.jsonl', full: 'runs/2026-06/agents/*/transcript.jsonl' })
  })
})

test('the card shows no record of the corpus, and reads none', async () => {
  const { el, rows } = await card()
  expect(el.textContent).not.toContain('Beschreibe')
  expect(rows).not.toHaveBeenCalled()
})

test('its rule opens from a closed Rule disclosure that names its kind', async () => {
  const { el } = await card()
  const rule = el.querySelector<HTMLButtonElement>('.bcell-label-rule-toggle')!
  expect(rule.textContent).toBe('Rule (code)')
  expect(rule.getAttribute('aria-expanded')).toBe('false')
  expect(el.querySelector('.bcell-label-spec')).toBeNull()
  await act(async () => rule.click())
  expect(rule.getAttribute('aria-expanded')).toBe('true')
  expect(el.querySelector('.bcell-label-spec')?.textContent).toBe(SPEC)
})

test("Definition and records opens the card's details, where the label's records under each value are", async () => {
  const openDetail = vi.fn()
  const { el } = await card(QUESTION, DETAIL, { openDetail })
  const open = [...el.querySelectorAll<HTMLButtonElement>('.bcell-label button')].find((b) => b.textContent === 'Definition and records')!
  expect(open).toBeTruthy()
  await act(async () => open.click())
  expect(openDetail).toHaveBeenCalledWith('c1')
})

test("where no board holds the card (a report's figure, the card harness), it offers no Definition and records, whose details could not open there", async () => {
  const { el } = await card()
  const labels = [...el.querySelectorAll<HTMLButtonElement>('.bcell-label button')].map((b) => b.textContent)
  expect(labels).toContain('Rule (code)')
  expect(labels).not.toContain('Definition and records')
})
