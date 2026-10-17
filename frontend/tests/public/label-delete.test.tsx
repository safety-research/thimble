// @vitest-environment jsdom
// A label's delete (src/files/DeleteLabelConfirm.tsx): the Labels pane's ⋯ menu offers Edit label and Delete label, and
// the label editor's More ends with Delete label. Either opens a confirm that names the label and says that its marks,
// its card and any filter that uses it go with it; Cancel keeps it, Delete deletes it (FilesLabels.remove) and closes
// the label's editor. useFilesLabels' remove takes the label out of the list at once, sends DELETE /concepts/{id} and
// has every reader of the labels read them again; when the server refuses, the label comes back with a toast. Files'
// Color by, colored by a label that is deleted, falls back to Off.
import { act, useEffect } from 'react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { LabelsPane } from '../../src/files/LabelsPane.tsx'
import { useFilesLabels, type FilesLabels } from '../../src/files/useLabels.ts'
import { bus } from '../../src/lib/bus.ts'
import type { Concept } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const kind = {
  id: 'k1',
  name: 'activity type',
  description: 'What the agent is doing in this message.',
  unit: 'record',
  kind: 'prompt',
  spec: '',
  glob: 'transcript.jsonl',
  marks: 'record',
  labels: ['reading', 'writing', 'other'],
  created_by: 'analyst',
  ts: '',
  shown: true,
  classes: [
    { name: 'reading', color: 1, highlight: true },
    { name: 'writing', color: 2, highlight: true },
    { name: 'other', color: 0, highlight: false },
  ],
} as unknown as Concept

function labelsOf(remove = vi.fn(async () => undefined)): FilesLabels {
  return {
    all: [kind],
    on: [kind],
    focus: kind.id,
    setFocus: () => undefined,
    byId: new Map([[kind.id, kind]]),
    presence: new Map(),
    toggle: () => undefined,
    setClasses: () => undefined,
    setColour: () => undefined,
    save: async () => kind,
    remove,
  }
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const frames = () => new Promise((r) => setTimeout(r, 40))
const confirm = () => document.querySelector<HTMLElement>('.popover.files-label-delete')
const button = (root: ParentNode, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)

describe("the Labels pane's ⋯", () => {
  test('offers Edit label and Delete label; Delete label asks first, naming the label and what goes with it', async () => {
    const labels = labelsOf()
    const onEdit = vi.fn()
    const el = await mount(<LabelsPane labels={labels} open onToggleOpen={() => undefined} editing={null} onEdit={onEdit} runs={new Map()} onRetry={async () => undefined} onStop={async () => undefined} />)
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Edit or delete activity type"]')!.click())
    const items = [...document.querySelectorAll<HTMLButtonElement>('.menu-item')]
    expect(items.map((b) => b.textContent)).toEqual(['Edit label', 'Delete label'])
    expect(items[1].classList.contains('danger')).toBe(true)
    await act(async () => items[0].click())
    expect(onEdit).toHaveBeenCalledWith('k1')

    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Edit or delete activity type"]')!.click())
    await act(async () => button(document, 'Delete label')!.click())
    const pop = confirm()!
    expect(pop.getAttribute('aria-label')).toBe('Delete activity type')
    expect(pop.textContent).toContain('Delete activity type? Its marks, its card and any filter that uses it are deleted with it.')
    await act(frames)
    expect(document.activeElement?.textContent).toBe('Cancel')
    await act(async () => button(pop, 'Cancel')!.click())
    expect(confirm()).toBeNull()
    expect(labels.remove).not.toHaveBeenCalled()
  })
})

describe("useFilesLabels' remove", () => {
  function Probe({ ws, got }: { ws: string; got: (l: FilesLabels) => void }) {
    const labels = useFilesLabels(ws)
    useEffect(() => {
      got(labels)
    })
    return null
  }

  test('a refusal brings the label back with a toast', async () => {
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const path = new URL(String(url), 'http://thimble.test').pathname
      if (init?.method === 'DELETE') return new Response('{"detail":"no such concept: k1"}', { status: 404, headers: { 'content-type': 'application/json' } })
      const body = path.endsWith('/concepts') ? [kind] : path.endsWith('/labels/presence') ? [] : {}
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    let labels: FilesLabels | null = null
    const toasts: string[] = []
    const off = bus.on('toast', (t) => toasts.push(t.text))
    await mount(<Probe ws="wd2" got={(l) => (labels = l)} />)
    await settle()
    await act(async () => labels!.remove('k1'))
    off()
    expect(labels!.all.map((k) => k.id)).toEqual(['k1'])
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatch(/^Could not delete activity type\./)
  })
})

describe("Files' Color by", () => {
  test('a label deleted while the file is colored by it leaves Color by at Off; another label is left alone', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"path":"m.jsonl","total":0,"bins":0,"partial":false,"bytes":[],"keys":[]}', { status: 200, headers: { 'content-type': 'application/json' } }))
    const { useColorBy } = await import('../../src/files/useColorBy.ts')
    const { readColor, writeColor } = await import('../../src/files/colorChoice.ts')
    writeColor('wc', 'm.jsonl', { by: 'l:k1', off: {} })
    function Probe() {
      useColorBy('wc', 'm.jsonl', true, labelsOf(), [], new Map(), null)
      return null
    }
    await mount(<Probe />)
    act(() => bus.emit('concepts', { concept: 'k2', what: 'deleted' }))
    expect(readColor('wc', 'm.jsonl').by).toBe('l:k1')
    act(() => bus.emit('concepts', { concept: 'k1', what: 'changed' }))
    expect(readColor('wc', 'm.jsonl').by).toBe('l:k1')
    act(() => bus.emit('concepts', { concept: 'k1', what: 'deleted' }))
    expect(readColor('wc', 'm.jsonl').by).toBe('off')
  })
})
