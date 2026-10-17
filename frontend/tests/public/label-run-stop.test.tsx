// @vitest-environment jsdom
// A label's run can be stopped and is seen (bug hunt G12: Label from prompt started a prompt label over 42,205 records at
// the bottom of a scrolled Labels list, with no way to stop it but to delete the label). A running label's ⋯ menu in
// the Labels pane offers Stop run, and so does its edit card; either sends POST /concepts/{id}/apply/cancel. A run the
// analyst starts from the edit card brings its label's row into view in the list, once the list holds it. A run that was
// stopped says so on its row, with the records it read rather than all it would have read.
import { act, useState } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { labelStatus, noValueText, outcomeText, stoppedText } from '../../src/files/labels.ts'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import { useLabelRuns, useLabelSide } from '../../src/files/ViewSide.tsx'
import type { Concept, ConceptRun } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const label = (id: string, name: string, run: ConceptRun | null = null): Concept =>
  ({
    id,
    name,
    description: 'The page title is in German.',
    unit: 'record',
    kind: 'prompt',
    spec: '',
    glob: '*',
    marks: 'record',
    labels: ['match', 'no match'],
    created_by: 'analyst',
    ts: '',
    shown: false,
    run,
    classes: [
      { name: 'match', color: 1, highlight: true },
      { name: 'no match', color: 0, highlight: false },
    ],
  }) as unknown as Concept

const RUNNING: ConceptRun = { status: 'running', run_id: 'r1', done: 1650, total: 42205 }
const others = Array.from({ length: 6 }, (_, i) => label(`o${i}`, `orientation label ${i}`))
const german = label('g1', 'German page title', RUNNING)

const labelsOf = (all: Concept[]): FilesLabels => ({
  all,
  on: [],
  focus: null,
  setFocus: () => undefined,
  byId: new Map(all.map((k) => [k.id, k])),
  presence: new Map(),
  toggle: () => undefined,
  setClasses: () => undefined,
  setColour: () => undefined,
  save: async () => all[0],
  remove: async () => undefined,
})

interface Call {
  method: string
  path: string
  body?: unknown
}
let calls: Call[] = []

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://thimble.test').pathname
    const method = init?.method ?? 'GET'
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const answer = (status: number, json: unknown) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
    if (path.endsWith('/apply/cancel')) return answer(200, { ok: true, cancelling: true })
    if (path.endsWith('/apply') && method === 'POST') return answer(202, { status: 'running', run_id: 'r3' })
    if (path.endsWith('/concepts') && method === 'POST') return answer(200, { ...label('n1', 'Asks for help'), run: { status: 'running', run_id: 'r2' } })
    if (path.endsWith('/labels/glob')) return answer(200, { files: ['pages.jsonl'], total: 1 })
    return answer(404, {})
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

let setLabels: (l: FilesLabels) => void = () => undefined

/** Files' Labels sidebar: the Labels pane and the edit card at its edge, with the runs the pane follows. */
function Side({ start, editing = null }: { start: FilesLabels; editing?: string | 'new' | null }) {
  const [labels, set] = useState(start)
  setLabels = set
  const runs = useLabelRuns('w', labels)
  const { pane, card } = useLabelSide({ ws: 'w', labels, runs, open: true, onToggleOpen: () => undefined, editing, onEdit: () => undefined, drafted: null, onDraft: () => undefined, appliesTo: [], width: 250, onWidth: () => undefined, onWidthEnd: () => undefined, maxWidth: 400 })
  return (
    <div className="side">
      {pane}
      {card}
    </div>
  )
}

const button = (root: ParentNode, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)
const cancels = () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/concepts/g1/apply/cancel'))

/** Type `value` into a field as the analyst does (React hears the input event). */
function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('a running label', () => {
  test("its ⋯ in the Labels pane offers Stop run, which stops the run", async () => {
    const el = await mount(<Side start={labelsOf([...others, german])} />)
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Stop, edit or delete German page title"]')!.click())
    expect([...document.querySelectorAll('.menu-item')].map((b) => b.textContent)).toEqual(['Stop run', 'Edit label', 'Delete label'])
    await act(async () => button(document, 'Stop run')!.click())
    await settle()
    expect(cancels()).toHaveLength(1)
    // a label that does not run has no Stop run
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Edit or delete orientation label 0"]')!.click())
    expect([...document.querySelectorAll('.menu-item')].map((b) => b.textContent)).toEqual(['Edit label', 'Delete label'])
  })

  test('its edit card offers Stop run, which stops the run', async () => {
    const el = await mount(<Side start={labelsOf([...others, german])} editing="g1" />)
    const card = el.querySelector('.label-card')!
    expect([...card.querySelectorAll('.label-card-foot button')].map((b) => b.textContent?.trim())).toEqual(['Stop run'])
    await act(async () => button(card, 'Stop run')!.click())
    await settle()
    expect(cancels()).toHaveLength(1)
  })
})

describe('a run started in the edit card', () => {
  test("brings its label's row into view in the Labels list once the list holds it", async () => {
    // the list shows 100 px; the new label's row stands below it, at 300 px
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 200, width: 200, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
      if (this.classList.contains('files-labels-list')) return box(0, 100)
      if (this.dataset.anchor === 'concept:n1') return box(300, 44)
      return box(0, 0)
    })
    const el = await mount(<Side start={labelsOf(others)} editing="new" />)
    typeInto(el.querySelector<HTMLInputElement>('[aria-label="Name"]')!, 'Asks for help')
    typeInto(el.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')!, 'The post asks another agent for help.')
    await act(async () => [...el.querySelectorAll<HTMLButtonElement>('.label-card-foot button')].find((b) => b.textContent?.startsWith('Run'))!.click())
    await settle()
    const list = el.querySelector<HTMLElement>('.files-labels-list')!
    expect(list.scrollTop).toBe(0)
    // the labels are read again with the new label in them, at the bottom of the list
    await act(async () => setLabels(labelsOf([...others, label('n1', 'Asks for help', { status: 'running', run_id: 'r2' })])))
    expect(list.scrollTop).toBe(244)
    // once only: the analyst's own scroll stays where they put it
    list.scrollTop = 0
    await act(async () => setLabels(labelsOf([...others, label('n1', 'Asks for help', { status: 'running', run_id: 'r2', done: 10, total: 42205 })])))
    expect(list.scrollTop).toBe(0)
  })
})

describe('a stopped run', () => {
  test('says it stopped, with the records it read', () => {
    const live: ConceptRun = { status: 'done', run_id: 'r1', done: 1700, total: 42205, matches: 120, failed: 0, started: '2026-10-17T15:39:39Z', summary: { stopped: true } }
    const s = labelStatus(label('g1', 'German page title'), live)!
    expect(s).toMatchObject({ state: 'done', stopped: true, total: 1700 })
    expect(outcomeText(s as Extract<typeof s, { state: 'done' }>)).toBe('120 of 1,700 records')
  })
})

describe('a run that quitting Claude Code stopped (bug hunt H3)', () => {
  // the server keeps such a run as stopped by the quit, with the units it read of those it would have read
  const QUIT = { ts: '2026-10-17T16:45:02Z', paths: ['revisions.jsonl'], total: 14591, matched_total: 14591, labeled: 8447, failed: 0, matches: 4296, status: 'done', stopped: true, stopped_by: 'quit' }
  const halfway = { ...label('q1', 'adds outside link'), last_run: QUIT, counts: { match: 4296, 'no match': 4151 }, n_labeled: 8447 } as unknown as Concept

  test('its row says where it stopped, and Run again runs it', async () => {
    const s = labelStatus(halfway)!
    expect(s).toMatchObject({ state: 'done', stopped: true, total: 8447, stoppedAt: { read: 8447, of: 14591, quit: true } })
    expect(stoppedText((s as Extract<typeof s, { state: 'done' }>).stoppedAt!, 'record')).toBe('stopped at 8,447 of 14,591 records when Claude Code quit')
    const el = await mount(<Side start={labelsOf([halfway])} />)
    const row = el.querySelector('[data-anchor="concept:q1"]')!
    expect(row.querySelector('.files-label-stopped')?.textContent).toBe('stopped at 8,447 of 14,591 records when Claude Code quitRun again on all 14,591')
    await act(async () => button(row, 'Run again on all 14,591')!.click())
    await settle()
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/concepts/q1/apply')).map((c) => c.body)).toEqual([{}])
  })
})

describe('Run again after a stop (bug hunt I3)', () => {
  // it started over at record 0 and labeled the 7,527 records the stopped run had read again, with no word of it
  const STOPPED = { ts: '2026-10-17T18:24:45Z', paths: ['*'], total: 29555, matched_total: 29555, labeled: 7527, failed: 0, matches: 276, status: 'done', stopped: true }
  const stopped = { ...label('s1', 'kills another process'), last_run: STOPPED, counts: { match: 276, 'no match': 7251 }, n_labeled: 7527 } as unknown as Concept

  test('goes on with the records the stopped run never read while its definition stands, and says so', async () => {
    const el = await mount(<Side start={labelsOf([{ ...stopped, resume: { read: 7527, left: 22028, total: 29555 } } as Concept])} />)
    const row = el.querySelector('[data-anchor="concept:s1"]')!
    expect(row.querySelector('.files-label-stopped')?.textContent).toBe('stopped at 7,527 of 29,555 recordsLabel the other 22,028')
    await act(async () => button(row, 'Label the other 22,028')!.click())
    await settle()
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/concepts/s1/apply')).map((c) => c.body)).toEqual([{ resume: true }])
  })

  test('labels every record again once its definition changed, and says so', async () => {
    const el = await mount(<Side start={labelsOf([{ ...stopped, resume: null } as Concept])} />)
    const row = el.querySelector('[data-anchor="concept:s1"]')!
    await act(async () => button(row, 'Run again on all 29,555')!.click())
    await settle()
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/concepts/s1/apply')).map((c) => c.body)).toEqual([{}])
  })
})

describe('one count for a label everywhere (bug hunt I10)', () => {
  // the terminal, main's card and read_ref count the records a label gave a value, as its rows hold them; the Labels
  // pane counted a stopped run's records read (9 of 370, the terminal 9 + 391 after a trial) and a code label's every
  // record (1,521 of 71,298, the terminal 8,496)
  test("a stopped run after a trial counts the label's records with a value, the trial's among them", () => {
    const STOPPED = { ts: '2026-10-17T19:21:55Z', paths: ['*'], total: 1521, matched_total: 1521, labeled: 370, failed: 0, matches: 9, status: 'done', stopped: true }
    const s = labelStatus({ ...label('t1', 'claims task done'), last_run: STOPPED, counts: { match: 9, 'no match': 391 } } as unknown as Concept)!
    const done = s as Extract<typeof s, { state: 'done' }>
    expect(outcomeText(done)).toBe('9 of 400 records')
    expect(stoppedText(done.stoppedAt!, 'record')).toBe('stopped at 370 of 1,521 records')
  })

  test("a code label's records its code returned None for are no part of its total, and its row says so", async () => {
    const DONE = { ts: '2026-10-17T19:19:53Z', paths: ['*/transcript.jsonl'], total: 71298, matched_total: 71298, labeled: 8496, failed: 0, skipped: 62802, matches: 1521, status: 'done' }
    const code = { ...label('c1', 'assistant text message'), kind: 'code', last_run: DONE, counts: { match: 1521, 'no match': 6975 } } as unknown as Concept
    const s = labelStatus(code)! as Extract<ReturnType<typeof labelStatus>, { state: 'done' }>
    expect(outcomeText(s)).toBe('1,521 of 8,496 records')
    expect(noValueText(s)).toBe('62,802 records got no value from its code')
    const el = await mount(<Side start={labelsOf([code])} />)
    expect(el.querySelector('[data-anchor="concept:c1"] .files-label-none')?.textContent).toBe('62,802 records got no value from its code')
    // a prompt label's records with no words
    expect(noValueText(labelStatus({ ...code, kind: 'prompt' } as Concept) as typeof s)).toBe('62,802 records had no words to read')
  })
})
