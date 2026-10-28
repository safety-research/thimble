// @vitest-environment jsdom
// A custom card's page taller than the canvas shows at rest (CARD_BODY_MAX, 800 px) shows its first screen with Show
// all, and says its whole height once: onTall, which the board sends to the server for the card's author (backend
// card_size), and the frame's `data-height`, which the card harness measures (canvas/bodyHeight).
import { afterEach, expect, test } from 'vitest'
import { act } from 'react'
import { bodyHeight } from '../../src/canvas/bodyHeight.ts'
import { CARD_BODY_MAX, CustomFrame, SIZE_MESSAGE } from '../../src/canvas/DataViz.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(unmountAll)

async function frameOf(el: HTMLElement): Promise<HTMLIFrameElement> {
  for (let i = 0; i < 40 && !el.querySelector('iframe'); i++) await settle()
  const frame = el.querySelector('iframe')
  expect(frame).not.toBeNull()
  return frame!
}

const sized = (frame: HTMLIFrameElement, height: number) =>
  act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: SIZE_MESSAGE, height, wide: false }, source: frame.contentWindow }))
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
