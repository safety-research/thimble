// @vitest-environment jsdom
// A chart on the canvas draws again only when what it shows changes (src/components/Outputs.tsx Vega): the canvas reads
// its cards again whenever anything on it changes, and a new copy of the same spec must not draw the chart again, which
// emptied and refilled its box and moved every card under it. A chart that does draw again keeps its box's height
// until it is drawn.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, test, vi } from 'vitest'

const draws: { el: HTMLElement; finish: () => void }[] = []
vi.mock('../../src/lib/vegaDraw.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/vegaDraw.ts')>()),
  drawChart: vi.fn((el: HTMLElement, _spec: unknown, _load: unknown, opts: { drawn?: (d: unknown) => void; replace?: () => void }) => {
    opts.replace?.()
    el.replaceChildren()
    return new Promise<null>((resolve) => {
      draws.push({
        el,
        finish: () => {
          const svg = document.createElement('svg')
          el.appendChild(svg)
          opts.drawn?.({ view: { width: () => 300 }, finalize: () => undefined, container: true })
          resolve(null)
        },
      })
    })
  }),
  refitChart: vi.fn(),
}))
vi.mock('../../src/lib/visibleSize.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/visibleSize.ts')>()),
  useVisibleSize: () => ({ width: 600, height: 300 }),
}))

const { Output } = await import('../../src/components/Outputs.tsx')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MIME = 'application/vnd.vegalite.v5+json'
const spec = (title: string) => ({ $schema: 'https://vega.github.io/schema/vega-lite/v5.json', title, mark: 'bar', data: { values: [{ day: 'Mon', n: 3 }, { day: 'Tue', n: 5 }] }, encoding: { x: { field: 'day' }, y: { field: 'n', type: 'quantitative' } } })

afterEach(() => {
  draws.length = 0
  document.body.innerHTML = ''
})

describe('a chart on a card the canvas reads again', () => {
  test('a new copy of the same spec draws nothing again; a changed spec draws again, its box holding its height', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(<Output bundle={{ [MIME]: spec('Edits per day') }} card />))
    expect(draws).toHaveLength(1)
    await act(async () => draws[0].finish())
    // the canvas read again: the same chart, a new object
    await act(async () => root.render(<Output bundle={{ [MIME]: JSON.parse(JSON.stringify(spec('Edits per day'))) }} card />))
    expect(draws).toHaveLength(1)
    // what it shows changed: drawn again, the box held at the height it had while the new chart draws
    const box = draws[0].el
    Object.defineProperty(box, 'offsetHeight', { configurable: true, get: () => 240 })
    await act(async () => root.render(<Output bundle={{ [MIME]: spec('Edits per hour') }} card />))
    expect(draws).toHaveLength(2)
    expect(box.style.minHeight).toBe('240px')
    await act(async () => draws[1].finish())
    expect(box.style.minHeight).toBe('')
    act(() => root.unmount())
  })
})

describe('the cards in view stay put when a card above them changes', () => {
  // a column of three cards; the view (800 × 600 at 100%) shows from y = 500 down
  const col = (h1: number, h2 = 300): Map<string, { x: number; y: number; w: number; h: number }> =>
    new Map([
      ['above', { x: 0, y: 0, w: 720, h: h1 }],
      ['first', { x: 0, y: h1 + 20, w: 720, h: h2 }],
      ['next', { x: 0, y: h1 + 20 + h2 + 20, w: 720, h: 300 }],
    ])
  const view = { x: 0, y: -500, scale: 1 }
  const ids = ['above', 'first', 'next']

  test('a card above the view that grows pans the view by as much, so the cards in view do not move', async () => {
    const { anchorShift } = await import('../../src/canvas/layout.ts')
    expect(anchorShift(col(444), col(474), ids, view, 800, 600)).toEqual({ dx: 0, dy: 30 })
    expect(anchorShift(col(444), col(404), ids, { ...view, scale: 0.8, y: -400 }, 800, 600)).toEqual({ dx: 0, dy: -40 })
  })

  test('a card in view that grows, in whole or in part, moves only the cards after it; nothing in view, nothing to keep', async () => {
    const { anchorShift } = await import('../../src/canvas/layout.ts')
    expect(anchorShift(col(444, 300), col(444, 360), ids, view, 800, 600)).toBeNull()
    expect(anchorShift(col(444, 300), col(444, 360), ids, { x: 0, y: -300, scale: 1 }, 800, 600)).toBeNull()
    expect(anchorShift(col(444), col(474), ids, { x: 0, y: -5000, scale: 1 }, 800, 600)).toBeNull()
  })
})
