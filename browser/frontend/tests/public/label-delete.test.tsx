// @vitest-environment jsdom
// A label's delete (src/files/LabelsPane.tsx, DeleteLabelConfirm.tsx): the Labels pane's ⋯ menu offers Delete label,
// which asks first, naming the label and what goes with it; Delete deletes it (FilesLabels.remove) and closes the
// label's editor.
import { act } from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { LabelsPane } from '../../src/files/LabelsPane.tsx'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import type { Concept } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

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

const button = (root: ParentNode, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)

test("Delete label in the Labels pane's ⋯ asks first, and Delete deletes the label and closes its editor", async () => {
  const remove = vi.fn(async () => undefined)
  const labels = { all: [kind], on: [kind], focus: kind.id, setFocus: () => undefined, byId: new Map([[kind.id, kind]]), presence: new Map(), toggle: () => undefined, setClasses: () => undefined, setColour: () => undefined, save: async () => kind, remove } as unknown as FilesLabels
  const onEdit = vi.fn()
  const el = await mount(<LabelsPane labels={labels} open onToggleOpen={() => undefined} editing="k1" onEdit={onEdit} runs={new Map()} onRetry={async () => undefined} />)
  await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Edit or delete activity type"]')!.click())
  await act(async () => button(document, 'Delete label')!.click())
  const confirm = document.querySelector<HTMLElement>('.popover.files-label-delete')!
  expect(confirm.textContent).toContain('Delete activity type?')
  expect(remove).not.toHaveBeenCalled()
  await act(async () => button(confirm, 'Delete')!.click())
  expect(remove).toHaveBeenCalledWith('k1')
  expect(onEdit).toHaveBeenCalledWith(null)
  expect(document.querySelector('.popover.files-label-delete')).toBeNull()
})
