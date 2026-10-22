// @vitest-environment jsdom
// The head of a view picked in the views bar (src/files/ViewPane.tsx): its name and its line of notes, with neither
// Open in nor a mode switch (the view's name beside Raw), even for a view of one file; a file picked in the line, and
// Raw beside a view that failed, open the file in the File browser, where its own modes are.
import { act } from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { bus } from '../../src/lib/bus'
import type { FilesLabels } from '../../src/files/useLabels'
import { mount, settle, unmountAll } from './mount.tsx'

let fail: ((m: string) => void) | null = null
vi.mock('../../src/files/ViewerFrame', () => ({
  ViewerFrame: (p: { onError?: (m: string) => void }) => {
    fail = p.onError ?? null
    return <div className="stub-frame" />
  },
}))

const { ViewPane } = await import('../../src/files/ViewPane.tsx')

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

const labels = { on: [], byId: new Map(), presence: new Map(), toggle: () => {}, setFocus: () => {}, setColour: () => {} } as unknown as FilesLabels
const view = { slug: 'timeline', name: 'Activity Timeline', version: 'v1', n_files: 1, files: ['runs/events.jsonl'], first_file: 'runs/events.jsonl', claims: ['runs/events.jsonl'] }

function stubFetch() {
  // the view's notes are not there: the head shows the name alone
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }))
}

test('the head has no Open in and no mode switch for a view of one file', async () => {
  stubFetch()
  const el = await mount(<ViewPane ws="mini" view={view as never} path="runs/events.jsonl" labels={labels} />)
  await settle()
  const head = el.querySelector('.view-pane-head')!
  expect(head.querySelector('.view-pane-name')?.textContent).toBe('Activity Timeline')
  expect([...head.querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain('Open in')
  expect(head.querySelector('[role="radiogroup"], .segmented, .seg')).toBeNull()
  expect(head.textContent).not.toMatch(/\bRaw\b/)
})

test('Raw beside a failed view opens the file in the File browser', async () => {
  stubFetch()
  const opened: { ref: string; browser?: boolean }[] = []
  const off = bus.on('openRef', (e) => opened.push(e))
  const el = await mount(<ViewPane ws="mini" view={view as never} path="runs/events.jsonl" targetRef="runs/events.jsonl#L4" labels={labels} />)
  await act(async () => fail?.('the page threw'))
  const raw = [...el.querySelectorAll<HTMLButtonElement>('.reader-fail button')].find((b) => b.textContent?.trim() === 'Raw')!
  await act(async () => raw.click())
  off()
  expect(opened).toEqual([{ ref: 'runs/events.jsonl#L4', browser: true }])
  expect(el.querySelector('.reader')).toBeNull()
})
