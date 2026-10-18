// @vitest-environment jsdom
// A label card on the canvas shows its label's counts once the label's run ended, also when the run's own `concepts`
// event never reached the page: the workspace's list of labels, which every label's event reads again, shows the run
// ended, and the card reads its label again (bug hunt C8: the card kept 0 per value while the Labels pane had them).
import { afterEach, expect, test, vi } from 'vitest'
import { useConceptDetail, useConcepts } from '../../src/canvas/concepts.ts'
import { api, labelApi } from '../../src/lib/api.ts'
import { bus } from '../../src/lib/bus.ts'
import type { Concept, ConceptDetail } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

const WS = 'ws-run-ended'
const BEFORE = { id: 'lbl-a', name: 'tidy notes', unit: 'agent', kind: 'code', spec: '', labels: ['tidy', 'messy'], counts: {}, n_labeled: 0, last_run: null, run: null } as unknown as Concept
const AFTER = { ...BEFORE, counts: { tidy: 40, messy: 2 }, n_labeled: 42, last_run: { ts: '2026-10-01T00:00:08Z', status: 'done' } } as unknown as Concept
const OTHER = { id: 'lbl-b', name: 'long notes', unit: 'agent', kind: 'code', spec: '', labels: ['yes', 'no'] } as unknown as Concept

function Card() {
  useConcepts(WS)
  const { concept } = useConceptDetail(WS, 'lbl-a')
  const counts = concept?.counts ?? {}
  return <p className="counts">{concept ? concept.labels.map((v) => `${v} ${counts[v] ?? 0}`).join(' · ') : ''}</p>
}

test("a label card reads its label again when the list of labels shows its run ended, though the run's event was lost", async () => {
  let ended = false
  vi.spyOn(api, 'concepts').mockImplementation(async () => (ended ? [AFTER, OTHER] : [BEFORE]))
  vi.spyOn(labelApi, 'detail').mockImplementation(async () => ({ ...(ended ? AFTER : BEFORE), applications: [] }) as unknown as ConceptDetail)
  const el = await mount(<Card />)
  await settle()
  expect(el.querySelector('.counts')?.textContent).toBe('tidy 0 · messy 0')
  // the run ends in another process; its `concepts applied` for lbl-a never arrives, and the next label's event does
  ended = true
  bus.emit('concepts', { concept: 'lbl-b', what: 'defined', rows: true })
  await settle()
  await settle()
  expect(el.querySelector('.counts')?.textContent).toBe('tidy 40 · messy 2')
})
