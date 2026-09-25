// @vitest-environment jsdom
// The overview ruler and scrollbar beside the reader (src/files/Ruler.tsx) and where the reader stands in the file
// (src/files/Reader.tsx shownIn, scrollTopFor): the lanes' marks over the whole file, the thumb's place and height and
// its inverse, the records on screen inside the thumb, a drag or a press on the track asking the reader for a place, a
// click and a hover on a mark, and the order of the labels that are on. The file, its records and its labels are
// invented.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { scrollTopFor, shownIn } from '../../src/files/Reader.tsx'
import { binLines, laneAt, laneBoxes, nearestTick, needsDetail, ReaderRuler, rulerColumns, rulerWidths, thumbPlace, THUMB_MIN_PX, viewTopAt, type LensTick, type RulerColumn, type RulerTick, type Shown } from '../../src/files/Ruler.tsx'
import { turnedOnOrder } from '../../src/files/labels.ts'
import type { Concept, LabelRuler } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const rect = (top: number, height: number, left = 0, width = 600) => ({ top, bottom: top + height, height, left, right: left + width, width, x: left, y: top, toJSON: () => ({}) }) as DOMRect

/** A reader body 400px tall at the top of the page, holding records `height` px tall at `top` px from the top of its
 * content, scrolled by its own scrollTop. */
function body(records: { line: number; top: number; height: number }[]): HTMLElement {
  const el = document.createElement('div')
  let scrollTop = 0
  Object.defineProperty(el, 'clientHeight', { value: 400 })
  Object.defineProperty(el, 'scrollTop', { get: () => scrollTop, set: (v: number) => (scrollTop = v) })
  el.getBoundingClientRect = () => rect(0, 400)
  for (const r of records) {
    const card = document.createElement('div')
    card.className = 'reader-card reader-record'
    card.dataset.line = String(r.line)
    card.getBoundingClientRect = () => rect(r.top - scrollTop, r.height)
    el.appendChild(card)
  }
  document.body.appendChild(el)
  return el
}

describe('where the reader stands in the file', () => {
  test('the records on screen, and the view from the first one to the last, a record counting the hidden lines after it', () => {
    // 3420 runs 400px above the top, 3421 is labelled and long, a view hides 3423..3499 after 3422
    const el = body([
      { line: 3419, top: -900, height: 500 },
      { line: 3420, top: -400, height: 500 },
      { line: 3421, top: 100, height: 250 },
      { line: 3422, top: 350, height: 200 },
      { line: 3500, top: 550, height: 100 },
    ])
    const got = shownIn(el, 12480)!
    expect(got.seen).toEqual([
      { line: 3420, top: -1, bottom: 0.25 },
      { line: 3421, top: 0.25, bottom: 0.875 },
      { line: 3422, top: 0.875, bottom: 1.375 },
    ])
    // from 4/5 into line 3420 to a quarter into 3422's span of 78 lines (3422..3499)
    expect(got.top * 12480).toBeCloseTo(3419 + 0.8, 6)
    expect((got.top + got.height) * 12480).toBeCloseTo(3421 + 0.25 * 78, 6)
    expect(shownIn(body([]), 100)).toBeNull()
  })

  test('scrollTopFor is shownIn read backwards, over hidden lines and past the records drawn', () => {
    // a view hides 204..259, so 203 stands for 57 lines
    const el = body([
      { line: 200, top: 0, height: 300 },
      { line: 201, top: 300, height: 120 },
      { line: 202, top: 420, height: 80 },
      { line: 203, top: 500, height: 500 },
      { line: 260, top: 1000, height: 200 },
      { line: 261, top: 1200, height: 200 },
    ])
    for (const a of [199, 199.5, 200.25, 201, 202.9, 210, 240.5, 259.99, 260.5]) {
      el.scrollTop = scrollTopFor(el, a)!
      expect(shownIn(el, 1000)!.top * 1000, `a = ${a}`).toBeCloseTo(a, 6)
    }
    // before the first record drawn and past the last, the records' mean height per line stands in for the lines
    const perLine = 1400 / (261 - 200 + 1)
    expect(scrollTopFor(el, 198)).toBe(0)
    expect(scrollTopFor(el, 265)).toBeCloseTo(1400 + 4 * perLine, 6)
    expect(scrollTopFor(body([]), 5)).toBeNull()
  })

  test('a bin of the ruler holds the lines the server puts in it', () => {
    for (const [total, bins] of [
      [12480, 2000],
      [37, 2000],
      [1000, 400],
      [2001, 2000],
    ]) {
      for (let line = 1; line <= total; line++) {
        const b = Math.min(bins - 1, Math.floor(((line - 1) * bins) / total))
        const [lo, hi] = binLines(b, bins, total)
        expect(line >= lo && line <= hi, `line ${line} of ${total} in bin ${b} (${lo}-${hi})`).toBe(true)
      }
    }
  })
})

describe('the thumb', () => {
  test('is as tall as the share of the file on screen, at least THUMB_MIN_PX, and reaches both ends of the track', () => {
    expect(thumbPlace({ top: 0.5, height: 0.0002 }, 800, THUMB_MIN_PX).height).toBe(THUMB_MIN_PX)
    expect(thumbPlace({ top: 0.2, height: 0.25 }, 800, THUMB_MIN_PX)).toEqual({ top: (0.2 / 0.75) * 600, height: 200 })
    expect(thumbPlace({ top: 0, height: 0.001 }, 800, THUMB_MIN_PX).top).toBe(0)
    expect(thumbPlace({ top: 0.999, height: 0.001 }, 800, THUMB_MIN_PX).top).toBeCloseTo(800 - THUMB_MIN_PX, 9)
    expect(thumbPlace({ top: 0, height: 1 }, 800, THUMB_MIN_PX)).toEqual({ top: 0, height: 800 })
  })

  test('viewTopAt is the inverse of thumbPlace', () => {
    for (const view of [
      { top: 0.4, height: 0.0002 },
      { top: 0.1, height: 0.3 },
      { top: 0.7, height: 0.3 },
    ]) {
      const at = thumbPlace(view, 800, THUMB_MIN_PX)
      expect(viewTopAt(at.top, at.height, 800, view.height)).toBeCloseTo(view.top, 9)
    }
    expect(viewTopAt(-20, 96, 800, 0.001)).toBe(0)
    expect(viewTopAt(900, 96, 800, 0.001)).toBeCloseTo(0.999, 9)
  })
})

describe('the lanes', () => {
  const kind = { id: 'k', name: 'kind of save', unit: 'record', labels: ['question post', 'notice page', 'other'], classes: [
    { name: 'question post', color: 2, highlight: true },
    { name: 'notice page', color: 3, highlight: true },
    { name: 'other', color: 0, highlight: false },
  ] } as unknown as Concept
  const race = { id: 'r', name: 'races ahead', unit: 'record', labels: ['yes', 'no'], classes: [
    { name: 'yes', color: 5, highlight: true },
    { name: 'no', color: 0, highlight: false },
  ] } as unknown as Concept
  const ruler: LabelRuler = { path: 'a.jsonl', total: 12480, bins: 2000, labels: [
    { concept_id: 'k', bins: { 'question post': [0, 976], 'notice page': [976], other: [3] } },
    { concept_id: 'r', bins: { yes: [1999] } },
  ] }

  test('a mark per bin that holds a highlighted value, over its lines, the lanes in the order of the labels that are on', () => {
    const cols = rulerColumns([race, kind], ruler)
    expect(cols.map((c) => c.id)).toEqual(['r', 'k'])
    expect(cols[0].ticks).toEqual([{ from: binLines(1999, 2000, 12480)[0], to: 12480, colour: 'var(--label-5)', value: 'yes' }])
    expect(cols[0].valued).toBe(false)
    expect(cols[1].valued).toBe(true)
    expect(cols[1].ticks.map((t) => [t.value, t.from, t.to])).toEqual([
      ['question post', 1, 7],
      ['question post', ...binLines(976, 2000, 12480)],
      ['notice page', ...binLines(976, 2000, 12480)],
    ])
    expect(rulerColumns([kind], null)).toEqual([])
  })

  test("lane N is label N: a label on with no rows on the file keeps an empty lane, a label over files one mark over the whole file", () => {
    const quiet = { ...race, id: 'q', name: 'quiet' } as Concept
    const repo = { id: 'f', name: 'repo kind', unit: 'agent', marks: 'file', labels: ['fork', 'other'], classes: [{ name: 'fork', color: 6, highlight: true }, { name: 'other', color: 0, highlight: false }] } as unknown as Concept
    const cols = rulerColumns([quiet, repo, kind], ruler, (id) => (id === 'f' ? { fork: 1 } : undefined))
    expect(cols.map((c) => [c.id, c.ticks.length])).toEqual([['q', 0], ['f', 1], ['k', 3]])
    expect(cols[1].ticks).toEqual([{ from: 1, to: 12480, colour: 'var(--label-6)', value: 'fork' }])
    expect(rulerColumns([repo], ruler, () => ({ other: 3 }))[0].ticks).toEqual([])
  })

  test('the mark nearest a place within reach, the one drawn last of two as near', () => {
    const t = (from: number, to: number, value: string): RulerTick => ({ from, to, colour: 'c', value })
    const ticks = [t(1, 8, 'a'), t(100, 107, 'a'), t(100, 107, 'b'), t(500, 500, 'a')]
    expect(nearestTick(ticks, 4, 2)?.from).toBe(1)
    expect(nearestTick(ticks, 103, 2)?.value).toBe('b')
    expect(nearestTick(ticks, 97, 2)?.from).toBe(100)
    expect(nearestTick(ticks, 300, 20)).toBeNull()
    expect(nearestTick(ticks, 502, 3)?.from).toBe(500)
  })

  test('the labels that are on keep the order they were turned on, a label it does not know coming after', () => {
    const k = (id: string) => ({ id })
    expect(turnedOnOrder([k('a'), k('b'), k('c'), k('d')], ['c', 'a']).map((x) => x.id)).toEqual(['c', 'a', 'b', 'd'])
    expect(turnedOnOrder([k('a')], ['z', 'a']).map((x) => x.id)).toEqual(['a'])
  })
})

describe('the ruler beside a long file', () => {
  const TRACK = 800
  beforeEach(() => {
    // the track's height comes from its box, read by a ResizeObserver
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private cb: () => void) {}
        observe() {
          this.cb()
        }
        disconnect() {}
      },
    )
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('reader-ruler-bar') ? TRACK : 0
    })
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
  })

  // two lanes over a file of 12,480 lines, the reader at line 7122 showing about two records; the find's two matches
  // three lines apart are one place on an 800px rail, so the ruler has its two rails
  const total = 12480
  const lanes: RulerColumn[] = [
    { id: 'k', name: 'kind of save', valued: true, total, ticks: [{ from: 7120, to: 7127, colour: 'orange', value: 'notice page' }, { from: 100, to: 107, colour: 'green', value: 'question post' }] },
    { id: 'find', name: '“clock.wait”', total, ticks: [{ from: 7122, to: 7122, colour: 'var(--accent)' }, { from: 7125, to: 7125, colour: 'var(--accent)' }] },
  ]
  const view: Shown = { top: 7121.3 / total, height: 1.8 / total, seen: [{ line: 7122, top: -0.3, bottom: 0.6 }, { line: 7123, top: 0.6, bottom: 1.2 }] }
  const lens = new Map<string, LensTick[]>([
    ['k', [{ line: 7122, top: -0.3, bottom: 0.6, colour: 'orange' }]],
    ['find', [{ line: 7122, top: 0.2, bottom: 0.2, colour: 'var(--accent)', hit: true }]],
  ])

  async function ruler(props: Partial<Parameters<typeof ReaderRuler>[0]> = {}) {
    const calls = { seek: [] as [number, boolean][], jump: [] as number[], mark: [] as [string, RulerTick][], line: [] as number[], wheel: [] as number[] }
    const el = await mount(
      <ReaderRuler
        columns={lanes}
        view={view}
        lens={lens}
        onJump={(f) => calls.jump.push(f)}
        onMark={(c, t) => calls.mark.push([c, t])}
        onLine={(l) => calls.line.push(l)}
        onSeek={(f, held) => calls.seek.push([f, held])}
        onWheel={(px) => calls.wheel.push(px)}
        {...props}
      />,
    )
    const q = (s: string) => el.querySelector<HTMLElement>(s)!
    const thumbTop = () => Number(/translateY\(([-\d.]+)px\)/.exec(q('.reader-ruler-thumb').style.transform)?.[1])
    q('.reader-ruler-bar').getBoundingClientRect = () => rect(0, TRACK, 40, 40)
    q('.reader-ruler-lanes').getBoundingClientRect = () => rect(0, TRACK, 0, rulerWidths(2).lanes)
    q('.reader-ruler-zoom').getBoundingClientRect = () => rect(thumbTop() + 3, THUMB_MIN_PX - 6, 43, 34)
    return { el, q, calls, thumbTop }
  }
  const fire = (target: Element, type: string, init: MouseEventInit) => act(() => void target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, ...init })))

  test('the thumb stands where thumbPlace puts it, THUMB_MIN_PX tall, holding a mark per record on screen where it stands', async () => {
    const { q, thumbTop } = await ruler()
    expect(thumbTop()).toBeCloseTo(thumbPlace(view, TRACK, THUMB_MIN_PX).top, 6)
    expect(q('.reader-ruler-thumb').style.height).toBe(`${THUMB_MIN_PX}px`)
    const marks = [...q('.reader-ruler-zl[data-col="k"]').querySelectorAll<HTMLElement>('i')]
    expect(marks.map((m) => [m.dataset.line, m.style.top])).toEqual([['7122', '-30%']])
    const hit = q('.reader-ruler-zl[data-col="find"] i')
    expect(hit.className).toBe('hit')
    expect(hit.style.top).toBe('20%')
    // a line of the paper between the two records on screen
    expect([...q('.reader-ruler-seps').querySelectorAll<HTMLElement>('i')].map((i) => i.style.top)).toEqual(['60%'])
    // the band over the lanes stands where the view does in the file
    expect(Number(/translateY\(([-\d.]+)px\)/.exec(q('.reader-ruler-band').style.transform)?.[1])).toBeCloseTo(view.top * TRACK, 6)
  })

  test('a drag of the thumb asks for the place under it while held and again on release; a press on the track centres the thumb there', async () => {
    const { q, calls, thumbTop } = await ruler()
    const bar = q('.reader-ruler-bar')
    const start = thumbTop()
    fire(bar, 'pointerdown', { clientY: start + 40 })
    fire(bar, 'pointermove', { clientY: start + 140 })
    expect(thumbTop()).toBeCloseTo(start + 100, 6)
    expect(calls.seek.at(-1)![1]).toBe(true)
    expect(calls.seek.at(-1)![0]).toBeCloseTo(viewTopAt(start + 100, THUMB_MIN_PX, TRACK, view.height), 9)
    fire(bar, 'pointerup', { clientY: start + 140 })
    expect(calls.seek.at(-1)).toEqual([calls.seek.at(-2)![0], false])
    // the thumb stays where it was let go until the reader moves there
    expect(thumbTop()).toBeCloseTo(start + 100, 6)
    fire(bar, 'pointerdown', { clientY: 700 })
    fire(bar, 'pointerup', { clientY: 700 })
    expect(calls.seek.at(-2)![0]).toBeCloseTo(viewTopAt(700 - THUMB_MIN_PX / 2, THUMB_MIN_PX, TRACK, view.height), 9)
    expect(calls.seek.at(-1)![1]).toBe(false)
  })

  test('a click on the thumb that does not move goes to the record whose mark it is on', async () => {
    const { q, calls, thumbTop } = await ruler()
    const bar = q('.reader-ruler-bar')
    // the orange record fills the top 60% of the zoom: a point a fifth of the way down its lane
    const y = thumbTop() + 3 + 0.2 * (THUMB_MIN_PX - 6)
    fire(bar, 'pointerdown', { clientY: y, clientX: 45 })
    fire(bar, 'pointerup', { clientY: y, clientX: 45 })
    expect(calls.line).toEqual([7122])
    expect(calls.seek).toEqual([])
  })

  test('a click on a mark of the overview goes to it, elsewhere to the place; hovering a mark names its record and value', async () => {
    const lineOf = vi.fn(async () => 7124)
    const { q, calls } = await ruler({ lineOf })
    const over = q('.reader-ruler-lanes')
    const y = (l: number) => (l / total) * TRACK
    fire(over, 'click', { clientX: 2, clientY: y(7123) })
    expect(calls.mark.map(([c, t]) => [c, t.from])).toEqual([['k', 7120]])
    fire(over, 'click', { clientX: 2, clientY: 400 })
    expect(calls.jump).toEqual([0.5])
    // the find's lane is the second: its marks stand for one line each, named at once
    fire(over, 'pointermove', { clientX: 8, clientY: y(7122) })
    expect(document.querySelector('.reader-ruler-tip')?.textContent).toBe('Line 7,122 · “clock.wait”')
    fire(over, 'pointermove', { clientX: 2, clientY: y(7123) })
    expect(document.querySelector('.reader-ruler-tip')?.textContent).toBe('Lines 7,120–7,127 · kind of save: notice page')
    await act(async () => void (await new Promise((r) => setTimeout(r, 200))))
    await settle()
    expect(lineOf).toHaveBeenCalledWith('k', lanes[0].ticks[0])
    expect(document.querySelector('.reader-ruler-tip')?.textContent).toBe('Line 7,124 · kind of save: notice page')
    fire(over, 'pointerout', { clientX: 2, clientY: y(7123), relatedTarget: document.body })
    expect(document.querySelector('.reader-ruler-tip')).toBeNull()
  })

  test('a wheel over the ruler scrolls the reader', async () => {
    const { el, calls } = await ruler()
    act(() => void el.querySelector('.reader-ruler')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 })))
    expect(calls.wheel).toEqual([120])
  })
})

describe('one rail or two', () => {
  const col = (total: number, ticks: [number, number, string?][]): RulerColumn => ({ id: 'k', name: 'k', total, ticks: ticks.map(([from, to, colour = 'orange']) => ({ from, to, colour })) })

  test('a rail that draws every mark apart from its neighbours is enough; two marks it would merge need the second rail', () => {
    // 400 lines on 800px: 2px a line, every mark at its size
    expect(needsDetail([col(400, [[10, 10], [12, 12], [300, 320]])], 800)).toBe(false)
    // 443 lines on 684px: a one-line mark is drawn 2px, still apart from the next one 5 lines on
    expect(needsDetail([col(443, [[10, 10], [15, 15]])], 684)).toBe(false)
    // 12,480 lines on 800px: two marks 10 lines apart are drawn on top of each other
    expect(needsDetail([col(12480, [[100, 100], [110, 110]])], 800)).toBe(true)
    // but far apart they stay apart at any length
    expect(needsDetail([col(12480, [[100, 107], [7120, 7127]])], 800)).toBe(false)
  })

  test('touching marks of one colour are one run; of two colours they may touch but not cover each other', () => {
    // a record of consecutive one-line bins at 0.5px a line is one run
    expect(needsDetail([col(1600, Array.from({ length: 40 }, (_, i): [number, number] => [500 + i, 500 + i]))], 800)).toBe(false)
    // two values on neighbouring lines at 0.5px a line: the first drawn 2px covers the second
    expect(needsDetail([col(1600, [[500, 500, 'orange'], [501, 501, 'blue']])], 800)).toBe(true)
    // at 4px a line they touch and both show
    expect(needsDetail([col(200, [[50, 50, 'orange'], [51, 51, 'blue']])], 800)).toBe(false)
  })

  test('lanes with no marks, or one, and a track not yet measured, need one rail', () => {
    expect(needsDetail([col(100000, [])], 800)).toBe(false)
    expect(needsDetail([col(100000, [[5, 5]])], 800)).toBe(false)
    expect(needsDetail([col(12480, [[100, 100], [110, 110]])], 0)).toBe(false)
  })
})

describe('the lanes on the pixel grid', () => {
  test('every lane is the same whole number of device pixels wide, at a whole pitch, at any density', () => {
    for (const dpr of [1, 1.25, 1.5, 2, 2.2, 3]) {
      const boxes = laneBoxes(4, { lane: 5, gap: 1, inset: 0 }, dpr)
      expect(new Set(boxes.map((b) => b[1])).size).toBe(1)
      for (const [x, w] of boxes) expect(Number.isInteger(x) && Number.isInteger(w)).toBe(true)
      const pitch = boxes[1][0] - boxes[0][0]
      boxes.forEach(([x], i) => expect(x).toBe(boxes[0][0] + i * pitch))
      // a lane never touches the next
      expect(pitch).toBeGreaterThan(boxes[0][1])
    }
    expect(laneBoxes(2, { lane: 7, gap: 2, inset: 3 }, 2)).toEqual([[6, 14], [24, 14]])
  })

  test('the lane under the pointer', () => {
    const g = { lane: 7, gap: 2, inset: 3 }
    expect([0, 4, 9, 12, 13, 30].map((x) => laneAt(x, g, 2))).toEqual([0, 0, 0, 1, 1, 1])
  })
})

describe('the ruler beside a short file', () => {
  const TRACK = 800
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private cb: () => void) {}
        observe() {
          this.cb()
        }
        disconnect() {}
      },
    )
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('reader-ruler-bar') ? TRACK : 0
    })
  })
  const total = 400
  const lanes: RulerColumn[] = [{ id: 'k', name: 'kind of save', valued: true, total, ticks: [{ from: 100, to: 104, colour: 'orange', value: 'notice page' }, { from: 300, to: 300, colour: 'green', value: 'post' }] }]
  const view: Shown = { top: 0, height: 0.1, seen: [] }
  const fire = (target: Element, type: string, init: MouseEventInit) => act(() => void target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, ...init })))

  test('one rail: the lanes are in the track under a thumb that frames the span on screen, and a press on a mark goes to it', async () => {
    const calls = { mark: [] as [string, number][], seek: [] as number[] }
    const el = await mount(<ReaderRuler columns={lanes} view={view} lens={new Map()} onJump={() => {}} onMark={(c, t) => calls.mark.push([c, t.from])} onLine={() => {}} onSeek={(f) => calls.seek.push(f)} onWheel={() => {}} />)
    expect(el.querySelector('.reader-ruler-lanes')).toBeNull()
    expect(el.querySelector('.reader-ruler-zoom')).toBeNull()
    const bar = el.querySelector<HTMLElement>('.reader-ruler-bar')!
    expect(bar.dataset.rails).toBe('1')
    expect(bar.querySelector('.reader-ruler-marks')).not.toBeNull()
    expect(bar.querySelector('.reader-ruler-thumb')!.className).toContain('finder')
    bar.getBoundingClientRect = () => rect(0, TRACK, 0, rulerWidths(1).bar)
    // the orange mark stands at lines 100–104, 198–208px down
    fire(bar, 'pointerdown', { clientX: 5, clientY: 204 })
    expect(calls.mark).toEqual([['k', 100]])
    expect(calls.seek).toEqual([])
    // off the marks a press moves the thumb
    fire(bar, 'pointerdown', { clientX: 5, clientY: 500 })
    fire(bar, 'pointerup', { clientX: 5, clientY: 500 })
    expect(calls.seek.length).toBeGreaterThan(0)
  })
})
