// @vitest-environment jsdom
// Label from prompt (src/files/LabelPrompt.tsx), the new-label card's top row: the draft applies to what the card's
// Applies to says (`*` when no file is open, bug hunt D1) and fills the card, whose Run names how many records it reads;
// nothing is created or run until the analyst presses Run (bug hunt G12: the draft ran at once as a prompt label over
// all 42,205 records of every file). Run creates and runs the label in one call (POST /concepts with `run`), which the
// server answers only once the run starts. A run the server refuses leaves no label: the toast says what to change and
// the card holds the draft. An empty Applies to is caught before anything is sent.
import { act, useState } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { LabelEditor } from '../../src/files/LabelEditor.tsx'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import { bus } from '../../src/lib/bus.ts'
import type { ConceptRun, LabelDraft } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const labels: FilesLabels = {
  all: [],
  on: [],
  focus: null,
  setFocus: () => undefined,
  byId: new Map(),
  presence: new Map(),
  toggle: () => undefined,
  setClasses: () => undefined,
  setColour: () => undefined,
  save: async () => {
    throw new Error('no label to save')
  },
  remove: async () => undefined,
}

interface Call {
  method: string
  path: string
  body: Record<string, unknown> | null
}
let calls: Call[] = []
/** what POST /concepts answers */
let created: { status: number; body: unknown } = { status: 200, body: {} }
let toasts: string[] = []
let off: () => void = () => undefined

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
beforeEach(() => {
  calls = []
  toasts = []
  off = bus.on('toast', (t) => void toasts.push(t.text))
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://thimble.test').pathname
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    calls.push({ method, path, body })
    const answer = (status: number, json: unknown) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
    if (path.endsWith('/concepts/draft')) {
      const draft: LabelDraft = { name: 'Claims a fix', over: 'files', marks: 'record', glob: (body!.paths as string[]).join(', '), kind: 'regex', text: '(?i)fixed it', values: ['claims', 'no claim'] }
      return answer(200, draft)
    }
    if (path.endsWith('/concepts') && method === 'POST') return answer(created.status, created.body)
    // with the unit, how many a run reads: 42,205 records over every file, 8 over the board
    if (path.endsWith('/labels/glob')) {
      const q = new URL(String(url), 'http://thimble.test').searchParams
      const all = q.get('pattern') === '*'
      return answer(200, { files: all ? ['board.jsonl', 'pages.jsonl'] : ['board.jsonl'], total: all ? 2 : 1, ...(q.get('unit') === 'record' ? { units: all ? 42205 : 8 } : {}) })
    }
    return answer(404, {})
  })
})
afterEach(() => {
  off()
  unmountAll()
  vi.unstubAllGlobals()
})

/** The new-label card as Files shows it with no file open (`appliesTo` empty): the card's Applies to says `*`. */
function NewLabel({ onEdit, onRun }: { onEdit: (id: string | 'new' | null) => void; onRun: (id: string, run: ConceptRun) => void }) {
  const [drafted, setDrafted] = useState<LabelDraft | null>(null)
  return <LabelEditor ws="w" labels={labels} editing="new" drafted={drafted} appliesTo={[]} onEdit={onEdit} onDraft={setDrafted} onRun={onRun} />
}

/** Type `value` into a field as the analyst does (React hears the input event). */
function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const field = <T extends HTMLElement>(el: ParentNode, label: string) => el.querySelector<T>(`[aria-label="${label}"]`)!
const sent = (method: string, end: string) => calls.filter((c) => c.method === method && c.path.endsWith(end))
const applied = () => calls.filter((c) => c.path.includes('/apply'))
/** The card's Run, which names how many records it reads once they are counted. */
const runButton = (el: ParentNode) => [...el.querySelectorAll<HTMLButtonElement>('.label-card-foot button')].find((b) => b.textContent?.trim().startsWith('Run'))!
/** Wait past the count's pause after the glob changes, and let its read land. */
const pause = () => act(async () => void (await new Promise((r) => setTimeout(r, 300))))

async function describeLabel(el: HTMLElement, text: string) {
  typeInto(field<HTMLInputElement>(el, 'Label from prompt'), text)
  await act(async () => void el.querySelector('form.label-prompt')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await settle()
  await settle()
}

describe('Label from prompt', () => {
  test("with no file open, the draft applies to the card's * and fills the card, whose Run names the records it reads; nothing runs before Run", async () => {
    created = { status: 200, body: { id: 'n1', name: 'Claims a fix', glob: '*', run: { status: 'running', run_id: 'r1' } } }
    const onEdit = vi.fn()
    const onRun = vi.fn()
    const el = await mount(<NewLabel onEdit={onEdit} onRun={onRun} />)
    expect(field<HTMLInputElement>(el, 'Applies to').value).toBe('*')
    await describeLabel(el, 'posts that claim a fix')
    await pause()
    expect(sent('POST', '/concepts/draft').map((c) => c.body!.paths)).toEqual([['*']])
    // the drafted form, for the analyst to check: its name, classifier, Applies to and how many records Run reads
    expect(sent('POST', '/concepts')).toEqual([])
    expect(applied()).toEqual([])
    expect(onRun).not.toHaveBeenCalled()
    expect(onEdit).not.toHaveBeenCalled()
    expect(field<HTMLInputElement>(el, 'Name').value).toBe('Claims a fix')
    expect(field<HTMLInputElement>(el, 'Pattern').value).toBe('(?i)fixed it')
    expect(field<HTMLInputElement>(el, 'Applies to').value).toBe('*')
    expect(runButton(el).textContent).toBe('Run on 42,205 records')
    // the analyst narrows it, and Run says what it reads now
    typeInto(field<HTMLInputElement>(el, 'Applies to'), 'board.jsonl')
    await pause()
    expect(runButton(el).textContent).toBe('Run on 8 records')
    expect(sent('POST', '/concepts')).toEqual([])

    await act(async () => runButton(el).click())
    await settle()
    const [create] = sent('POST', '/concepts')
    expect(create.body).toMatchObject({ name: 'Claims a fix', glob: 'board.jsonl', kind: 'regex', spec: '(?i)fixed it', run: true })
    expect(applied()).toEqual([])
    expect(onRun).toHaveBeenCalledWith('n1', { status: 'running', run_id: 'r1' })
    expect(onEdit).toHaveBeenCalledWith(null)
    expect(toasts).toEqual([])
  })

  test('the draft applies to what the analyst typed in Applies to', async () => {
    created = { status: 200, body: { id: 'n1', name: 'Claims a fix', run: { status: 'running' } } }
    const el = await mount(<NewLabel onEdit={() => undefined} onRun={() => undefined} />)
    typeInto(field<HTMLInputElement>(el, 'Applies to'), 'board.jsonl, agents/*.jsonl')
    await describeLabel(el, 'posts that claim a fix')
    expect(sent('POST', '/concepts/draft').map((c) => c.body!.paths)).toEqual([['board.jsonl', 'agents/*.jsonl']])
    expect(field<HTMLInputElement>(el, 'Applies to').value).toBe('board.jsonl, agents/*.jsonl')
    await act(async () => runButton(el).click())
    await settle()
    expect(sent('POST', '/concepts')[0].body).toMatchObject({ glob: 'board.jsonl, agents/*.jsonl', run: true })
  })

  test('a run the server refuses leaves no label: the toast says what to change and the card holds the draft', async () => {
    const why = 'This prompt label would run over more than 50,000 records (61,000 in 12 files). Narrow Applies to to some files.'
    created = { status: 400, body: { detail: why } }
    const onEdit = vi.fn()
    const el = await mount(<NewLabel onEdit={onEdit} onRun={() => undefined} />)
    await describeLabel(el, 'posts that claim a fix')
    await act(async () => runButton(el).click())
    await settle()
    expect(toasts).toEqual([`Could not run Claims a fix. 400 ${why}`])
    expect(applied()).toEqual([])
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([])
    expect(onEdit).not.toHaveBeenCalled()
    expect(field<HTMLInputElement>(el, 'Name').value).toBe('Claims a fix')
    expect(field<HTMLInputElement>(el, 'Applies to').value).toBe('*')
  })
})

describe("the new-label card's Run", () => {
  test('creates and runs the label in one call', async () => {
    created = { status: 200, body: { id: 'n2', name: 'Asks for help', run: { status: 'running' } } }
    const onRun = vi.fn()
    const el = await mount(<NewLabel onEdit={() => undefined} onRun={onRun} />)
    typeInto(field<HTMLInputElement>(el, 'Name'), 'Asks for help')
    typeInto(field<HTMLTextAreaElement>(el, 'Prompt'), 'The post asks another agent for help.')
    await act(async () => runButton(el).click())
    await settle()
    expect(sent('POST', '/concepts')[0].body).toMatchObject({ name: 'Asks for help', glob: '*', run: true })
    expect(applied()).toEqual([])
    expect(onRun).toHaveBeenCalledWith('n2', { status: 'running' })
  })

  test('with an empty Applies to, says so in plain words and sends nothing', async () => {
    const el = await mount(<NewLabel onEdit={() => undefined} onRun={() => undefined} />)
    typeInto(field<HTMLInputElement>(el, 'Name'), 'Asks for help')
    typeInto(field<HTMLTextAreaElement>(el, 'Prompt'), 'The post asks another agent for help.')
    typeInto(field<HTMLInputElement>(el, 'Applies to'), ' ')
    await act(async () => runButton(el).click())
    await settle()
    expect(toasts).toEqual(['Applies to is empty. Name the files the label runs over, such as * for every file.'])
    expect(sent('POST', '/concepts')).toEqual([])
  })
})
