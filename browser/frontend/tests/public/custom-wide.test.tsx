// @vitest-environment jsdom
// A custom card whose page lays out wider than the card (src/canvas/DataViz.tsx CustomFrame, SIZER): the page scrolls
// sideways inside its frame rather than being cut at the card's edge unseen. The frame's script says the page is wide,
// and takes the room of the scroll bar into the height, where the bar takes room; the frame then shows the fade at its
// right edge that says there is more.
import { afterEach, expect, test } from 'vitest'
import { act } from 'react'
import { CustomFrame, SIZE_MESSAGE, withSizer } from '../../src/canvas/DataViz.tsx'
import { mount, unmountAll } from './mount.tsx'

afterEach(unmountAll)

/** What the frame's script posts for a page `scrollWidth` wide in a frame `clientWidth` wide, whose body is 60 px tall,
 * in a frame of `innerHeight` whose scroll bar leaves `clientHeight`. */
function posted(scrollWidth: number, clientWidth: number, innerHeight: number, clientHeight: number): Record<string, unknown> {
  const script = withSizer('').replace(/^<script>|<\/script>$/g, '')
  const sent: Record<string, unknown>[] = []
  const document = { body: { offsetHeight: 60 }, documentElement: { scrollWidth, clientWidth, clientHeight } }
  const run = new Function('document', 'window', 'parent', 'getComputedStyle', 'addEventListener', 'innerHeight', script)
  run(document, {}, { postMessage: (m: Record<string, unknown>) => sent.push(m) }, () => ({ marginTop: '0', marginBottom: '0' }), () => undefined, innerHeight)
  return sent[0]
}

test("the frame's script says a page wider than its frame is wide, and asks for the scroll bar's room", () => {
  expect(posted(700, 700, 60, 60)).toMatchObject({ type: SIZE_MESSAGE, height: 60, wide: false })
  expect(posted(1200, 700, 75, 60)).toMatchObject({ type: SIZE_MESSAGE, height: 75, wide: true })
})

test('a wide page gives the frame the fade at its right edge', async () => {
  const el = await mount(<CustomFrame html="<div style='width:1200px'>steps</div>" title="Steps" />)
  const frame = await new Promise<HTMLIFrameElement | null>((resolve) => {
    const t0 = Date.now()
    const look = () => (el.querySelector('iframe') || Date.now() - t0 > 2000 ? resolve(el.querySelector('iframe')) : setTimeout(look, 20))
    look()
  })
  expect(frame).not.toBeNull()
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: SIZE_MESSAGE, height: 75, wide: true }, source: frame!.contentWindow }))
  })
  expect(el.querySelector('.canvas-card-frame')!.classList.contains('is-wide')).toBe(true)
  expect(frame!.style.height).toBe('75px')
})
