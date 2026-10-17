// @vitest-environment jsdom
// A trial, a label run on a sample (backend concepts.py, Trials), in the label editor (src/files/LabelCard.tsx): it
// offers Run on all N at all times, which runs it on every record, and after an edit its Re-run runs the sample again
// (bug hunt G3: the editor had no run on all, and Re-run quietly ran all 9,921 records).
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { useLabelRuns, useLabelSide } from '../../src/files/ViewSide.tsx'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import type { Concept } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const trial = {
  id: 'k1',
  name: 'own build broke',
  description: "The post's author says a build they ran failed.",
  unit: 'record',
  kind: 'prompt',
  spec: '',
  glob: 'logs/*/notes.jsonl',
  marks: 'record',
  n_labeled: 40,
  labels: ['broke', 'fine'],
  counts: { broke: 4, fine: 36 },
  trial: true,
  created_by: 'chat:main',
  ts: '',
  shown: true,
  classes: [
    { name: 'broke', color: 3, highlight: true },
    { name: 'fine', color: 0, highlight: false },
  ],
  last_run: { ts: '2026-10-08T10:00:00+00:00', paths: ['logs/*/notes.jsonl'], total: 40, matched_total: 9921, labeled: 40, failed: 0, status: 'done', matches: 4, limit: 40 },
} as unknown as Concept

const labels: FilesLabels = {
  all: [trial],
  on: [trial],
  focus: trial.id,
  setFocus: () => undefined,
  byId: new Map([[trial.id, trial]]),
  presence: new Map(),
  toggle: () => undefined,
  setClasses: () => undefined,
  setColour: vi.fn(),
  save: vi.fn(async () => trial),
  remove: vi.fn(async () => undefined),
}

/** the bodies of the runs the editor started */
let applied: unknown[] = []

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
beforeEach(() => {
  applied = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://thimble.test').pathname
    if (path.endsWith('/apply')) {
      applied.push(JSON.parse(String(init?.body ?? '{}')))
      return new Response(JSON.stringify({ status: 'running' }), { status: 202, headers: { 'content-type': 'application/json' } })
    }
    const body = path.endsWith('/concepts') ? [trial] : path.endsWith('/labels/presence') ? [] : path.endsWith('/labels/glob') ? { files: ['logs/a/notes.jsonl'], total: 1 } : null
    return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

function SideCard() {
  const runs = useLabelRuns('w', labels)
  const { card } = useLabelSide({ ws: 'w', labels, runs, open: true, onToggleOpen: () => undefined, editing: 'k1', onEdit: () => undefined, drafted: null, onDraft: () => undefined, appliesTo: ['logs/a/notes.jsonl'], width: 250, onWidth: () => undefined, onWidthEnd: () => undefined, maxWidth: 400 })
  return <div className="side">{card}</div>
}

const foot = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>('.label-card-foot button')]
const press = async (root: ParentNode, words: string) => {
  const b = foot(root).find((x) => x.textContent?.trim() === words)
  expect(b, words).toBeTruthy()
  await act(async () => b!.click())
  await settle()
}

test('a trial offers Run on all N, which runs it on every record', async () => {
  const el = await mount(<SideCard />)
  await settle()
  expect(foot(el).map((b) => b.textContent?.trim())).toEqual(['Run on all 9,921'])
  await press(el, 'Run on all 9,921')
  expect(applied).toEqual([{}])
  expect(labels.save).not.toHaveBeenCalled()
})

test("after an edit, a trial's Re-run runs its sample again, beside Run on all", async () => {
  const el = await mount(<SideCard />)
  await settle()
  const prompt = el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, `${trial.description} Broken tests count too.`)
    prompt.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(foot(el).map((b) => b.textContent?.trim())).toEqual(['Cancel', 'Run on all 9,921', 'Re-run'])
  await press(el, 'Re-run')
  expect(labels.save).toHaveBeenCalledTimes(1)
  expect(applied).toEqual([{ limit: 40 }])
})
