// @vitest-environment jsdom
// A label's run can be stopped and is seen (bug hunt G12: Label from prompt started a prompt label over 42,205 records at
// the bottom of a scrolled Labels list, with no way to stop it but to delete the label). A running label's ⋯ menu in
// the Labels pane offers Stop run, and so does its edit card; either sends POST /concepts/{id}/apply/cancel. A run the
// analyst starts from the edit card brings its label's row into view in the list, once the list holds it. A run that was
// stopped says so on its row, with the records it read rather than all it would have read.
import { act, useState } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { labelStatus, outcomeText } from '../../src/files/labels.ts'
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
    calls.push({ method, path })
    const answer = (status: number, json: unknown) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
    if (path.endsWith('/apply/cancel')) return answer(200, { ok: true, cancelling: true })
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
