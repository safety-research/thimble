// @vitest-environment jsdom
// A label's colours are the analyst's to change, from the Labels pane or from a view: a value takes a palette colour
// and a value of the label that had it takes the old one (files/labels.ts withClassColour); a view's page hears every
// label over files and the palette (pageLabelList, pagePalette) and names a label by its id; and its label controls
// (thimble.setLabel, setLabelColour, newLabel through ViewerFrame) are saved as the pane saves them, PUT
// /concepts/{id}, with no run. The server is a fake fetch.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PALETTE, pageLabelList, pageLabels, pagePalette, withClassColour } from '../../src/files/labels.ts'
import { ViewSurface } from '../../src/files/ViewSurface.tsx'
import type { Concept, LabelClass } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const concept = (id: string, name: string, shown: boolean, classes: LabelClass[], extra: Partial<Concept> = {}): Concept =>
  ({ id, name, unit: 'record', kind: 'regex', labels: classes.map((c) => c.name), classes, shown, marks: 'record', ...extra }) as unknown as Concept

const ASKS = concept('k1', 'asks', true, [{ name: 'asks', color: 3, highlight: true }, { name: 'other', color: 0, highlight: false }],
  { counts: { asks: 4, other: 8 }, last_run: { ts: '2026-03-02T10:00:00+00:00', paths: ['board.jsonl'], total: 12, matched_total: 12, labeled: 12, failed: 0, status: 'done', matches: 4 } })
const TONE = concept('k2', 'tone', false, [{ name: 'calm', color: 5, highlight: true }, { name: 'curt', color: 6, highlight: true }])
const CARDS = { ...concept('k3', 'good cards', false, [{ name: 'good', color: 7, highlight: true }, { name: 'no', color: 0, highlight: false }]), unit: 'cell' } as Concept
const resolve = (t: string) => `#${t.slice(2)}`

describe('a label value takes a palette colour', () => {
  test('the value takes the colour, and a value of the label that had it takes the old one', () => {
    const classes = TONE.classes!
    expect(withClassColour(classes, 'calm', 9)).toEqual([{ name: 'calm', color: 9, highlight: true }, { name: 'curt', color: 6, highlight: true }])
    expect(withClassColour(classes, 'calm', 6)).toEqual([{ name: 'calm', color: 6, highlight: true }, { name: 'curt', color: 5, highlight: true }])
    // the grey is every negative's, so it is never swapped
    expect(withClassColour(ASKS.classes!, 'asks', 0)).toEqual([{ name: 'asks', color: 0, highlight: true }, { name: 'other', color: 0, highlight: false }])
  })

  test('a value the label lacks, or a colour outside the palette, changes nothing', () => {
    expect(withClassColour(TONE.classes!, 'loud', 2)).toBeNull()
    expect(withClassColour(TONE.classes!, 'calm', 13)).toBeNull()
    expect(PALETTE).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0])
  })
})

describe('what a view page hears of the labels', () => {
  test('the labels that are on carry their ids, so the page can name them back', () => {
    const byId = new Map([ASKS, TONE].map((k) => [k.id, k]))
    expect(pageLabels([ASKS], null, byId, resolve).on.map((l) => l.id)).toEqual(['k1'])
  })

  test('every label over files, with those of the view first, each on or off with its colours and count; and the palette', () => {
    const list = pageLabelList([ASKS, TONE, CARDS], resolve, new Set(['k2']))
    expect(list.map((l) => [l.id, l.on])).toEqual([['k2', false], ['k1', true]])
    expect(list[1]).toEqual({ id: 'k1', name: 'asks', on: true, colour: '#label-3', count: 4,
      values: [{ name: 'asks', colour: '#label-3', highlight: true }, { name: 'other', colour: '#label-none', highlight: false }] })
    expect(list[0].count).toBeNull()
    expect(pagePalette(resolve)).toEqual([...Array.from({ length: 12 }, (_, i) => `#label-${i + 1}`), '#label-none'])
  })
})

describe("a view's label controls", () => {
  let calls: { url: string; method: string; body: unknown }[] = []
  beforeEach(() => {
    calls = []
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url: u, method, body })
      const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } })
      if (u.includes('/concepts/') && method === 'PUT') {
        const k = [ASKS, TONE].find((x) => u.endsWith(`/concepts/${x.id}`))!
        return json({ ...k, ...body })
      }
      if (u.includes('/concepts')) return json([ASKS, TONE])
      if (u.includes('/labels/presence')) return json([])
      if (u.includes('/filters')) return json({})
      if (u.includes('/sources')) return json({ path: '.', files: [{ path: 'board.jsonl', kind: 'jsonl', size_bytes: 10 }], folders: [], n_files: 1 })
      if (u.includes('/frame')) return new Response('<html><head></head><body></body></html>', { status: 200 })
      return json({})
    })
  })
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** The view in a pane of its own, its frame, and a function that sends the frame's messages as its page would. */
  async function view() {
    const el = await mount(<ViewSurface ws="w" view={{ slug: 'threads', name: 'Threads', claims: ['board.jsonl'], first_file: 'board.jsonl' }} active />)
    await settle()
    await settle()
    const frame = el.querySelector<HTMLIFrameElement>('iframe.view-pane-frame')!
    expect(frame).not.toBeNull()
    const heard: Record<string, unknown>[] = []
    vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(((m: Record<string, unknown>) => void heard.push(m)) as typeof window.postMessage)
    const send = async (data: object) => {
      await act(async () => window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow })))
      await settle()
    }
    return { el, heard, send }
  }
  const puts = (id: string) => calls.filter((c) => c.method === 'PUT' && c.url.endsWith(`/concepts/${id}`)).map((c) => c.body)

  test('the page hears every label and the palette, and a colour it picks is saved as the label card saves one, with no run', async () => {
    const { heard, send } = await view()
    await send({ type: 'thimble:ready' })
    const labels = heard.filter((m) => m.type === 'thimble:labels').at(-1)!
    const all = labels.all as { id: string; on: boolean }[]
    expect(all.map((l) => [l.id, l.on])).toEqual([['k1', true], ['k2', false]])
    const palette = labels.palette as string[]
    expect(palette).toHaveLength(13)
    await send({ type: 'thimble:labelColour', id: 'k2', value: 'calm', colour: palette[5] })
    expect(puts('k2')).toEqual([{ classes: [{ name: 'calm', color: 6, highlight: true }, { name: 'curt', color: 5, highlight: true }] }])
    expect(calls.some((c) => c.url.includes('/apply'))).toBe(false)
  })

  test('a label turned on from the page is turned on in Files; an unknown label or colour is ignored', async () => {
    const { send } = await view()
    await send({ type: 'thimble:label', id: 'k2', on: true })
    expect(puts('k2')).toEqual([{ shown: true }])
    await send({ type: 'thimble:label', id: 'k1', on: true })
    // a label already on stays as it is
    expect(puts('k1')).toEqual([])
    await send({ type: 'thimble:label', id: 'nope', on: true })
    await send({ type: 'thimble:labelColour', id: 'k1', value: 'asks', colour: '#123456' })
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
  })

  test('New label… from the page opens the prompt in the Labels sidebar', async () => {
    const { el, send } = await view()
    expect(el.querySelector('[role="dialog"][aria-label="New label"]')).toBeNull()
    await send({ type: 'thimble:newLabel' })
    expect(el.querySelector('[role="dialog"][aria-label="New label"]')).not.toBeNull()
  })

  test("the Labels pane beside the view changes a label's colour from the same palette", async () => {
    const { el } = await view()
    const open = el.querySelector<HTMLButtonElement>('button[aria-label="Change the colours of tone"]')!
    expect(open).not.toBeNull()
    await act(async () => open.click())
    const pop = document.querySelector('.label-palette')!
    expect(pop.querySelectorAll('.label-palette-colour')).toHaveLength(PALETTE.length)
    // a label with two coloured values picks which one takes the colour
    await act(async () => pop.querySelectorAll<HTMLButtonElement>('.label-palette-value')[1].click())
    await act(async () => pop.querySelector<HTMLButtonElement>('.label-palette-colour[aria-label="Colour 2"]')!.click())
    expect(puts('k2')).toEqual([{ classes: [{ name: 'calm', color: 5, highlight: true }, { name: 'curt', color: 2, highlight: true }] }])
  })
})
