// @vitest-environment jsdom
// A custom card whose page lays out wider than the card (src/canvas/DataViz.tsx SIZER): the frame's script says the page
// is wide, and takes the room of a scroll bar into the height where one takes room. The page itself does not scroll
// sideways (src/canvas/cardBridge.ts, tests/public/card-bridge.test.ts).
import { expect, test } from 'vitest'
import { SIZE_MESSAGE, withSizer } from '../../src/canvas/DataViz.tsx'

/** What the frame's script posts for a page `scrollWidth` wide in a frame `clientWidth` wide, whose body is 60 px tall,
 * in a frame of `innerHeight` whose scroll bar leaves `clientHeight`. */
function posted(scrollWidth: number, clientWidth: number, innerHeight: number, clientHeight: number): Record<string, unknown> {
  const script = withSizer('').replace(/^<script>|<\/script>$/g, '')
  const sent: Record<string, unknown>[] = []
  const document = { body: { offsetHeight: 60, getElementsByTagName: () => [] }, documentElement: { scrollWidth, clientWidth, clientHeight } }
  const run = new Function('document', 'window', 'parent', 'getComputedStyle', 'addEventListener', 'innerHeight', script)
  run(document, {}, { postMessage: (m: Record<string, unknown>) => sent.push(m) }, () => ({ marginTop: '0', marginBottom: '0' }), () => undefined, innerHeight)
  return sent[0]
}

test("the frame's script says a page wider than its frame is wide, and asks for the scroll bar's room", () => {
  expect(posted(700, 700, 60, 60)).toMatchObject({ type: SIZE_MESSAGE, height: 60, wide: false })
  expect(posted(1200, 700, 75, 60)).toMatchObject({ type: SIZE_MESSAGE, height: 75, wide: true })
})
