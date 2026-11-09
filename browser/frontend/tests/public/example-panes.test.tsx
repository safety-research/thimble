// @vitest-environment jsdom
// The tour's example panes (src/example/main.tsx, the page example.html): thimble's own Files pane and Labels sidebar
// over the example folder, used as in a workspace. A file opens from the tree in a tab of its own, the reader's modes
// switch, Color by colors the records by the label, the sidebar lists the label and its records, and a record opens in
// the Files pane. The frame's requests are answered by the example (src/example/shield.ts): none reaches the network,
// and the browser's storage keeps nothing of it.
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { PANES_KEY, type ExamplePanes } from '../../src/example/panes.ts'

const network: string[] = []
let panes: ExamplePanes
const storage = window.localStorage

/** Waits up to `ms` for `ok`, letting React and the example's answers run; what `ok` gave. */
async function until<T>(ok: () => T, ms = 4000): Promise<NonNullable<T>> {
  const t0 = Date.now()
  for (;;) {
    const got = ok()
    if (got) return got as NonNullable<T>
    if (Date.now() - t0 > ms) throw new Error(`waited ${ms} ms in vain`)
    await new Promise((r) => setTimeout(r, 20))
  }
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel)
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)]
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

beforeAll(async () => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  // jsdom has no scrollIntoView, which brings a record a ref names into view
  Element.prototype.scrollIntoView ??= () => undefined
  // the network: any request that reaches it is a failure of the example's walls
  const reached = async (input: RequestInfo | URL) => {
    network.push(String(input))
    throw new TypeError('the network was reached')
  }
  vi.stubGlobal('fetch', reached)
  window.fetch = reached
  const root = document.createElement('div')
  root.id = 'root'
  document.body.append(root)
  await import('../../src/example/main.tsx')
  panes = await until(() => (window as unknown as Record<string, ExamplePanes | undefined>)[PANES_KEY])
  panes.place({ x: 0, y: 0, width: 1000, height: 800 }, null)
  await until(() => panes.ready())
})
afterAll(() => vi.unstubAllGlobals())

test('the Files pane lists the example folder and opens its files, in each of the reader’s modes', async () => {
  // the agent's transcript in front, plain, its README in the tab beside it
  expect($$('.example-files .reader-tabs .reader-tab-name').map((t) => t.textContent)).toEqual(['README.md', 'agent-1.jsonl'])
  expect(text('.example-files .reader-colorbar .colorby-trigger:not(.filterby-trigger) b')).toBe('Off')
  const rows = () => $$('.example-files .files-side .files-row').map((r) => r.textContent?.trim())
  await until(() => rows().includes('board.jsonl'))
  expect(rows()).toEqual(['agents', 'agent-1.jsonl', 'agent-2.jsonl', 'agent-3.jsonl', 'shop', 'checkout.py', 'board.jsonl', 'README.md'])
  // another file, from the tree
  $$('.example-files .files-side .files-row').find((r) => r.textContent?.trim() === 'agent-2.jsonl')!.click()
  await until(() => text('.example-files .reader-tabs .reader-tab.active .reader-tab-name') === 'agent-2.jsonl')
  await until(() => text('.example-files .pane-status').includes('agent-2.jsonl · Transcript'))
  await until(() => $$('.example-files .reader-body .reader-card').length > 0)
  // the reader's modes
  const mode = (name: string) => $$('.example-files .reader-modes [role="radio"]').find((m) => m.textContent?.trim() === name)
  expect($$('.example-files .reader-modes [role="radio"]').map((m) => m.textContent?.trim())).toEqual(['Transcript', 'Table', 'Timeline', 'Raw'])
  for (const name of ['Table', 'Raw', 'Transcript']) {
    mode(name)!.click()
    await until(() => text('.example-files .pane-status').endsWith(`agent-2.jsonl · ${name}`))
  }
  expect(network).toEqual([])
})

test('Color by colors the records by the label, the sidebar lists it, and a record it found opens in the Files pane', async () => {
  // as the Labels step's demo starts: the transcript in front again, plain
  panes.reset()
  await until(() => text('.example-files .reader-tabs .reader-tab.active .reader-tab-name') === 'agent-1.jsonl' && $$('.example-files .reader-body .reader-card').length > 0)
  panes.part('color-by')!.click()
  const row = await until(() => panes.part('color-by-label'))
  row.click()
  await until(() => text('.example-files .reader-colorbar .colorby-trigger:not(.filterby-trigger) b') === 'what the step does')
  await until(() => $$('.example-files .reader-body .reader-card.has-cb').length > 0)
  await panes.close()
  expect($('.popover')).toBeNull()

  // the sidebar, where the page's own stands: the label, its values, and its records
  panes.place({ x: 0, y: 0, width: 600, height: 800 }, { x: 612, y: 0, width: 388, height: 800 })
  await until(() => $('.example-side .lside-row[data-label]'))
  expect(text('.example-side .lside-row .lside-name')).toBe('what the step does')
  $('.example-side .lside-row .lside-name')!.click()
  await until(() => $$('.example-side .lside-found').length > 0)
  expect(text('.example-side .lside-detail')).toContain('talks to other agents20')
  $('.example-side .lside-more')!.click()
  const found = await until(() => $$('.example-side .lside-found').find((f) => f.textContent?.includes('agent-3.jsonl#L5')))
  found.click()
  await until(() => text('.example-files .reader-tabs .reader-tab.active .reader-tab-name') === 'agent-3.jsonl')
  await until(() => $('.example-files .reader-card[data-line="5"]'))
  // turned off in its switch, the label leaves Color by
  $$('.example-side .lside-detail button[role="switch"]')[0]!.click()
  await until(() => $('.example-side .lside-detail button[role="switch"]')?.getAttribute('aria-checked') === 'false')
  expect(network).toEqual([])
  // nothing of the example is kept in the browser's storage
  expect(Object.keys(storage).filter((k) => k.includes('fernhill'))).toEqual([])
})
