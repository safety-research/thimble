// @vitest-environment jsdom
// The marks a view's page hears (src/files/ViewerFrame.tsx) while a label's rows arrive in batches, as for the rows a
// table holds in Files' Timeline mode: the page's first `labels` after it says ready carries every mark, and each batch
// of rows after it only the marks of that batch's records (`merge`), so a batch costs its own records and not every
// record the page holds.
import { afterEach, expect, test, vi } from 'vitest'
import timeline from '../../src/files/views/timeline'
import type { FilesLabels } from '../../src/files/useLabels'
import { api, scaleApi } from '../../src/lib/api'
import type { Concept } from '../../src/lib/types'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

const REFS = 2500
const ref = (i: number) => `run.jsonl#L${i + 1}`
const marked = (n: number) => n % 2 === 1

test("each batch of a label's rows sends the page the marks of that batch's records alone", async () => {
  vi.spyOn(api, 'timelinePage').mockResolvedValue('<!doctype html><html><head></head><body></body></html>')
  vi.spyOn(api, 'filters').mockResolvedValue({} as never)
  // each request's rows held until the test answers it, one at a time
  const asked: { refs: string[]; answer: () => void }[] = []
  vi.spyOn(scaleApi, 'labelsForRefs').mockImplementation(
    (_ws, refs) =>
      new Promise((done) => {
        const rows = refs.map((r) => ({ ref: r, label: marked(Number(r.split('#L')[1])) ? 'edit' : 'other', confidence: null, source: 'regex' }))
        asked.push({ refs, answer: () => done([{ concept_id: 'k1', name: 'edit', labels: ['edit', 'other'], unit: 'record', rows }] as never) })
      }),
  )
  const label = { id: 'k1', name: 'edit', unit: 'record', kind: 'regex', spec: 'edit', labels: ['edit', 'other'], shown: true, classes: [{ name: 'edit', color: 2, highlight: true }, { name: 'other', color: 0, highlight: false }] } as unknown as Concept
  const labels = { all: [label], on: [label], focus: 'k1', setFocus: vi.fn(), byId: new Map([['k1', label]]), presence: new Map(), toggle: vi.fn(), setColour: vi.fn() } as unknown as FilesLabels
  const Timeline = timeline.component
  const el = await mount(<Timeline workspace="mini" path="run.jsonl" kind="events" page={null as never} loadMore={() => undefined} labels={labels} />)
  await settle()
  await settle()
  const page = el.querySelector('iframe')!.contentWindow!
  const heard: { marks: Record<string, unknown>; merge?: boolean }[] = []
  page.addEventListener('message', (e: MessageEvent) => e.data?.type === 'thimble:labels' && heard.push(e.data))
  const fromPage = (data: object) => window.dispatchEvent(new MessageEvent('message', { data, source: page }))
  fromPage({ type: 'thimble:ready' })
  await settle()
  // every row of the page's table, reported at once
  fromPage({ type: 'thimble:anchors', refs: Array.from({ length: REFS }, (_, i) => ref(i)), seq: REFS, seen: [] })
  await vi.waitFor(() => expect(asked.length).toBe(Math.ceil(REFS / 1000)))
  await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0))
  const before = heard.length
  for (const a of asked) {
    const seen = heard.length
    a.answer()
    await vi.waitFor(() => expect(heard.length).toBeGreaterThan(seen))
    await settle()
  }
  await vi.waitFor(() => expect(Object.keys(Object.assign({}, ...heard.map((m) => m.marks))).length).toBe(REFS / 2))

  expect(heard[0].merge).toBeUndefined()
  const deltas = heard.slice(before)
  expect(deltas.length).toBe(asked.length)
  // each batch's message: merged, with the marks of that batch's marked records alone
  deltas.forEach((m, i) => {
    expect(m.merge).toBe(true)
    expect(Object.keys(m.marks).sort()).toEqual(asked[i].refs.filter((r) => marked(Number(r.split('#L')[1]))).sort())
  })
})
