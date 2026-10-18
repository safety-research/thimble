// @vitest-environment jsdom
// The label editor's file count beside Applies to (src/files/LabelCard.tsx): it follows the glob as the analyst edits
// it, once the typing pauses, while the list of files stays closed (bug hunt E7: it kept the first glob's count until
// the list was opened).
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { LabelEditor } from '../../src/files/LabelEditor.tsx'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import { mount, unmountAll } from './mount.tsx'

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

const RUNS = Array.from({ length: 24 }, (_, i) => `lamp-${i}/stderr.log`)
let globs: string[] = []

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
beforeEach(() => {
  globs = []
  vi.stubGlobal('fetch', async (url: string) => {
    const u = new URL(String(url), 'http://thimble.test')
    const answer = (json: unknown) => new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
    if (u.pathname.endsWith('/labels/glob')) {
      const pattern = u.searchParams.get('pattern') ?? ''
      globs.push(pattern)
      const files = pattern === '*/stderr.log' ? RUNS : pattern === 'lamp-3/transcript.jsonl' ? [pattern] : []
      return answer({ files: files.slice(0, 10), total: files.length })
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

/** Wait past the count's pause after typing, and let its read land. */
const pause = () => act(async () => void (await new Promise((r) => setTimeout(r, 350))))

test('the file count follows Applies to while it is edited, with the list of files closed', async () => {
  const el = await mount(<LabelEditor ws="w" labels={labels} editing="new" drafted={null} appliesTo={['lamp-3/transcript.jsonl']} onEdit={() => undefined} onDraft={() => undefined} onRun={() => undefined} />)
  const count = () => el.querySelector<HTMLButtonElement>('.label-card-files')!
  await pause()
  expect(count().textContent).toBe('1 file')

  const field = el.querySelector<HTMLInputElement>('[aria-label="Applies to"]')!
  const type = (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  // typed on without a pause: one read, of the glob as it ends
  type('*/')
  type('*/stderr.log')
  await pause()
  expect(count().getAttribute('aria-expanded')).toBe('false')
  expect(count().textContent).toBe('24 files')
  expect(globs).toEqual(['lamp-3/transcript.jsonl', '*/stderr.log'])
})
