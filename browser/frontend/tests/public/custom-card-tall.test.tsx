// @vitest-environment jsdom
// A custom card's page taller than the canvas shows at rest (CARD_BODY_MAX, 800 px) shows its first screen with Show
// all, and says its whole height once: onTall, which the board sends to the server for the card's author (backend
// card_size), and the frame's `data-height`, which the card harness measures (canvas/bodyHeight). A page that lays out
// wider than its frame says its width and the frame's once (onWide), and neither says a size the page before it measured.
import { afterEach, expect, test } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { bodyHeight } from '../../src/canvas/bodyHeight.ts'
import { CARD_BODY_MAX, CustomFrame, SIZE_MESSAGE, withSizer } from '../../src/canvas/DataViz.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(unmountAll)

async function frameOf(el: HTMLElement): Promise<HTMLIFrameElement> {
  for (let i = 0; i < 40 && !el.querySelector('iframe'); i++) await settle()
  const frame = el.querySelector('iframe')
  expect(frame).not.toBeNull()
  return frame!
}

const sized = (frame: HTMLIFrameElement, height: number, wide?: { width: number; frame: number }) =>
  act(async () => {
    const size = wide ? { wide: true, ...wide } : { wide: false, width: 692, frame: 692 }
    window.dispatchEvent(new MessageEvent('message', { data: { type: SIZE_MESSAGE, height, ...size }, source: frame.contentWindow }))
  })

test('a page taller than the canvas shows at rest shows its first screen with Show all, and says its height once', async () => {
  const heard: number[] = []
  const el = await mount(<CustomFrame html="<p>runs</p>" title="Every run" onTall={(h) => heard.push(h)} />)
  const frame = await frameOf(el)
  await sized(frame, 640)
  expect(heard).toEqual([])
  expect(el.querySelector('.bcell-more')).toBeNull()
  await sized(frame, 1460)
  expect(frame.style.height).toBe(`${CARD_BODY_MAX}px`)
  expect(CARD_BODY_MAX).toBe(800)
  expect(el.querySelector('.canvas-card-frame')!.classList.contains('is-clipped')).toBe(true)
  expect(el.querySelector('.bcell-more')?.textContent).toBe('Show all')
  expect(el.querySelector<HTMLElement>('.canvas-card-frame')!.dataset.height).toBe('1460')
  await sized(frame, 1460)
  expect(heard).toEqual([1460])
})

test("the harness measures a custom card's page whole, not the part shown before Show all", () => {
  const card = document.createElement('article')
  card.innerHTML = "<div class='bcell-body'><div data-height='1460'><iframe></iframe></div></div>"
  document.body.appendChild(card)
  const rect = (height: number) => ({ height, width: 700, x: 0, y: 0, top: 0, left: 0, right: 700, bottom: height, toJSON: () => ({}) }) as DOMRect
  card.querySelector<HTMLElement>('.bcell-body')!.getBoundingClientRect = () => rect(830)
  card.querySelector<HTMLElement>('iframe')!.getBoundingClientRect = () => rect(800)
  expect(bodyHeight(card)).toBe(1490)
  expect(bodyHeight(document.createElement('article'))).toBe(0)
})

/** A CustomFrame drawn again with each html, as the board draws a card that was edited. */
async function redrawn(props: { onTall?: (h: number) => void; onWide?: (w: number, f: number) => void }) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  const draw = (html: string) => act(async () => root.render(<CustomFrame html={html} title="Every run" {...props} />))
  const done = () => {
    act(() => root.unmount())
    el.remove()
  }
  return { el, draw, done }
}

test("the frame's script measures the page's width and the frame's where it measures the height", () => {
  const script = withSizer('').replace(/^<script>|<\/script>$/g, '')
  const sent: Record<string, unknown>[] = []
  const document = { body: { offsetHeight: 60, getElementsByTagName: () => [] }, documentElement: { scrollWidth: 1180, clientWidth: 692, clientHeight: 60 } }
  const run = new Function('document', 'window', 'parent', 'getComputedStyle', 'addEventListener', 'innerHeight', script)
  run(document, {}, { postMessage: (m: Record<string, unknown>) => sent.push(m) }, () => ({ marginTop: '0', marginBottom: '0' }), () => undefined, 60)
  expect(sent[0]).toMatchObject({ type: SIZE_MESSAGE, wide: true, width: 1180, frame: 692 })
})

test("a page wider than its frame says its width and the frame's once for each html, and a page that fits says nothing", async () => {
  const heard: [number, number][] = []
  const { el, draw, done } = await redrawn({ onWide: (w, f) => heard.push([w, f]) })
  try {
    await draw('<table><tr><td>runs</td></tr></table>')
    const frame = await frameOf(el)
    await sized(frame, 300)
    expect(heard).toEqual([])
    await sized(frame, 300, { width: 1180, frame: 692 })
    await sized(frame, 300, { width: 1180, frame: 692 })
    expect(heard).toEqual([[1180, 692]])
    // a new html is said only once its own page has drawn wide
    await draw('<table><tr><td>2 of 56 runs failed</td></tr></table>')
    for (let i = 0; i < 5; i++) await settle()
    expect(heard).toEqual([[1180, 692]])
    await sized(frame, 300, { width: 960, frame: 692 })
    expect(heard).toEqual([[1180, 692], [960, 692]])
  } finally {
    done()
  }
})

test('a new html says no height of the page before it: only its own page, once drawn, says its height', async () => {
  const tall: number[] = []
  const { el, draw, done } = await redrawn({ onTall: (h) => tall.push(h) })
  try {
    await draw('<p>every run</p>')
    const frame = await frameOf(el)
    await sized(frame, 1460)
    expect(tall).toEqual([1460])
    // the card is edited to fit: until its page has drawn, nothing is said, and then nothing, since it fits
    await draw('<p>2 of 56 runs failed</p>')
    for (let i = 0; i < 5; i++) await settle()
    expect(tall).toEqual([1460])
    await sized(frame, 120)
    expect(tall).toEqual([1460])
    // a later html that draws tall again is said, at its own height
    await draw('<p>every run, twice</p>')
    await sized(frame, 1500)
    expect(tall).toEqual([1460, 1500])
  } finally {
    done()
  }
})
