// @vitest-environment jsdom
// A card that does not fit on the analyst's screen while its author makes a version that fits (`held`, backend
// card_fit.py) shows on the board as a card that still runs: its question and the running line, not its content or its
// takeaway (src/canvas/CardFace.tsx). The card harness measures a card whole for that (src/canvas/bodyHeight.ts): a
// table's rows behind Show all, and the rows pandas left out of a DataFrame it cut, count at the height of the rows it
// shows, and a custom card's page or a table that lays out wider than its room gives its width and the room's.
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { bodyHeight, bodyInner, bodyWidth } from '../../src/canvas/bodyHeight.ts'
import { CellCard } from '../../src/canvas/Cell.tsx'
import { CanvasContext } from '../../src/canvas/context.ts'
import { CustomFrame, SIZE_MESSAGE, withSizer } from '../../src/canvas/DataViz.tsx'
import type { Cell } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const note = (over: Partial<Cell>): Cell =>
  ({ id: 'c1', notebook: 'nb', kind: 'note', title: 'Which runs failed?', created_by: 'terminal', ts: '2026-10-15T10:00:00Z', payload: { text: 'Every one of the 56 runs, one per line.' }, takeaway: '14 of the 56 runs failed.', ...over }) as Cell

function card(c: Cell) {
  const noop = () => undefined
  return mount(
    <CanvasContext.Provider value={{ ws: 'ws', filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: 'main', name: 'main', writable: true }), unread: new Set(), refresh: noop, openThread: noop }}>
      <CellCard
        cell={c} x={0} y={0} w={420} h={null} selected={false} alone={false} collapsed={false} deck={false} dragging={false}
        detailOpen={false} editing={null} z={1} register={noop} onPress={noop} onFocusMode={noop} onResizeStart={noop}
        onAction={noop} onEdit={noop}
      />
    </CanvasContext.Provider>,
  )
}

test('a held card shows its question and the running line, and neither its content nor its takeaway', async () => {
  const el = await card(note({ held: { since: '2026-10-15T10:00:01Z' } }))
  await settle()
  expect(el.textContent).toContain('Which runs failed?')
  expect(el.querySelector('.bcell-run')?.textContent).toContain('running')
  expect(el.textContent).not.toContain('Every one of the 56 runs')
  expect(el.textContent).not.toContain('14 of the 56 runs failed.')
})

test('a card that is not held shows its content and its takeaway, with no running line', async () => {
  const el = await card(note({ held: null }))
  await settle()
  expect(el.querySelector('.bcell-run')).toBeNull()
  expect(el.textContent).toContain('Every one of the 56 runs')
  expect(el.textContent).toContain('14 of the 56 runs failed.')
})

const rect = (height: number) => ({ height, width: 700, x: 0, y: 0, top: 0, left: 0, right: 700, bottom: height, toJSON: () => ({}) }) as DOMRect

test("the harness counts a table's rows behind Show all at the height of the rows it shows", () => {
  const el = document.createElement('article')
  const rows = Array.from({ length: 30 }, (_, i) => `<tr${i >= 12 ? ' hidden' : ''}><td>run ${i + 1}</td></tr>`).join('')
  el.innerHTML = `<div class='bcell-body'><div class='outputs-html outputs-html-capped'><table><tbody>${rows}</tbody></table></div></div>`
  document.body.appendChild(el)
  el.querySelector<HTMLElement>('.bcell-body')!.getBoundingClientRect = () => rect(460)
  el.querySelectorAll<HTMLElement>('tbody tr').forEach((tr) => (tr.getBoundingClientRect = () => rect(tr.hidden ? 0 : 30)))
  // 12 rows shown at 30 px: the 18 behind Show all add 540 px
  expect(bodyHeight(el)).toBe(1000)
})

test('the harness counts the rows pandas left out of a DataFrame it cut to its first and last rows, as if shown', () => {
  const el = document.createElement('article')
  const row = (i: number) => `<tr><th>2026-09-${String(i).padStart(2, '0')}</th><td>ok</td><td>${i * 7}</td></tr>`
  const gap = '<tr><th>...</th><td>...</td><td>...</td></tr>'
  const rows = [1, 2, 3, 4, 5].map(row).join('') + gap + [26, 27, 28, 29, 30].map(row).join('')
  el.innerHTML = `<div class='bcell-body'><div class='outputs-html outputs-html-table'><div><table class='dataframe'><thead><tr><th></th><th>status</th><th>rows</th></tr></thead><tbody>${rows}</tbody></table><p>140 rows × 2 columns</p></div></div></div>`
  document.body.appendChild(el)
  el.querySelector<HTMLElement>('.bcell-body')!.getBoundingClientRect = () => rect(381)
  el.querySelectorAll<HTMLElement>('tbody tr').forEach((tr) => (tr.getBoundingClientRect = () => rect(30)))
  // 10 of the 140 records shown at 30 px: the 130 pandas left out add 3,900 px
  expect(bodyHeight(el)).toBe(4281)
  // a DataFrame pandas showed whole has no such line, and nothing is added
  el.querySelector('p')!.remove()
  expect(bodyHeight(el)).toBe(381)
})

test('the harness gives the widest content that lays out wider than its room, and nothing when all of it fits', () => {
  const el = document.createElement('article')
  el.innerHTML = "<div class='bcell-body'><div data-page-width='1180' data-frame-width='692'></div><div class='outputs-html'></div></div>"
  document.body.appendChild(el)
  const table = el.querySelector<HTMLElement>('.outputs-html')!
  Object.defineProperty(table, 'scrollWidth', { value: 900 })
  Object.defineProperty(table, 'clientWidth', { value: 692 })
  expect(bodyWidth(el)).toEqual({ width: 1180, frame: 692 })
  const fits = document.createElement('article')
  fits.innerHTML = "<div class='bcell-body'><div class='outputs-html'></div></div>"
  expect(bodyWidth(fits)).toBeNull()
})

test("a custom card's frame names the width of a page wider than it, for the harness", async () => {
  const el = await mount(<CustomFrame html="<p>a timeline</p>" title="How did the outage unfold?" />)
  let frame: HTMLIFrameElement | null = null
  for (let i = 0; i < 40 && !(frame = el.querySelector('iframe')); i++) await settle()
  expect(frame).not.toBeNull()
  const sized = (wide: boolean) =>
    act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: SIZE_MESSAGE, height: 120, wide, width: wide ? 1180 : 692, frame: 692 }, source: frame!.contentWindow }))
    })
  await sized(true)
  const box = el.querySelector<HTMLElement>('.canvas-card-frame')!
  expect([box.dataset.pageWidth, box.dataset.frameWidth]).toEqual(['1180', '692'])
  await sized(false)
  expect(box.dataset.pageWidth).toBeUndefined()
})

test("the frame's script says what the page's own scroll boxes hold past their size, the outermost box alone", () => {
  const script = withSizer('').replace(/^<script>|<\/script>$/g, '')
  const sent: Record<string, unknown>[] = []
  // a box 560 px tall that scrolls a table 3,000 px tall, a box inside it that scrolls too, and a row 900 px wide in a
  // box 692 px wide that scrolls sideways
  const box = { contains: (e: unknown) => e === inner, scrollHeight: 3000, clientHeight: 560, scrollWidth: 692, clientWidth: 692, style: { overflowY: 'auto', overflowX: 'visible' } }
  const inner = { contains: () => false, scrollHeight: 400, clientHeight: 100, scrollWidth: 10, clientWidth: 10, style: { overflowY: 'scroll', overflowX: 'visible' } }
  const row = { contains: () => false, scrollHeight: 20, clientHeight: 20, scrollWidth: 900, clientWidth: 692, style: { overflowY: 'visible', overflowX: 'auto' } }
  const document = { body: { offsetHeight: 600, getElementsByTagName: () => [box, inner, row] }, documentElement: { scrollWidth: 692, clientWidth: 692, clientHeight: 600 } }
  const style = (e: { style?: Record<string, string> }) => ({ marginTop: '0', marginBottom: '0', ...(e.style ?? {}) })
  const run = new Function('document', 'window', 'parent', 'getComputedStyle', 'addEventListener', 'innerHeight', script)
  run(document, {}, { postMessage: (m: Record<string, unknown>) => sent.push(m) }, style, () => undefined, 600)
  expect(sent[0]).toMatchObject({ type: SIZE_MESSAGE, height: 600, wide: false, inner: 2440, innerWide: 208 })
})

test("the frame names what the page's scroll boxes hold, which the harness counts in the card's height and width", async () => {
  const el = await mount(<CustomFrame html="<div style='max-height:560px;overflow-y:auto'>runs</div>" title="Every stage" />)
  let frame: HTMLIFrameElement | null = null
  for (let i = 0; i < 40 && !(frame = el.querySelector('iframe')); i++) await settle()
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: SIZE_MESSAGE, height: 600, wide: false, width: 692, frame: 692, inner: 2440, innerWide: 208 }, source: frame!.contentWindow }))
  })
  const box = el.querySelector<HTMLElement>('.canvas-card-frame')!
  expect([box.dataset.innerHeight, box.dataset.pageWidth, box.dataset.frameWidth]).toEqual(['2440', '900', '692'])
  const card = document.createElement('article')
  card.innerHTML = `<div class='bcell-body'>${el.innerHTML}</div>`
  card.querySelector<HTMLElement>('.bcell-body')!.getBoundingClientRect = () => rect(620)
  card.querySelector<HTMLElement>('iframe')!.getBoundingClientRect = () => rect(600)
  expect(bodyInner(card)).toBe(2440)
  expect(bodyHeight(card)).toBe(3060)
  expect(bodyWidth(card)).toEqual({ width: 900, frame: 692 })
})
