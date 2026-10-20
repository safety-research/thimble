// @vitest-environment jsdom
// The Timeline mode of Files: a file whose first page names the key of its records' time offers it beside its other
// modes, and opens in it only where no other mode fits (an event log whose records nest objects), never over the
// Transcript or the Table; it draws the file whole in a frame of the view kit, which the reader feeds: every record with
// a time and its values of the keys Color by offers, Color by opening on the key Files' other modes open on, and a record
// read whole when it opens (src/files/views/timeline.tsx, src/files/views/registry.ts, src/files/Reader.tsx,
// src/files/ViewerFrame.tsx).
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { pickKey, Reader } from '../../src/files/Reader.tsx'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import { pickView, scoreViews } from '../../src/files/views/registry.ts'
import { TIMELINE_SCORE, timelineAnswer } from '../../src/files/views/timeline.tsx'
import { api } from '../../src/lib/api.ts'
import type { SourceEvents, SourcePage, TimeHint } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const NO_LABELS = { all: [], on: [], focus: null, byId: new Map(), presence: new Map(), labelled: new Map() } as unknown as FilesLabels
const TIME: TimeHint = { key: 'ts' }

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const nested = [1, 2, 3].map((i) => ({ ts: `2026-09-14T08:0${i}:00Z`, agent: `a${i}`, detail: { host: `h${i}` } }))
const flat = [1, 2, 3].map((i) => ({ ts: `2026-09-14T08:0${i}:00Z`, agent: `a${i}`, event: 'deploy' }))
const score = (s: ReturnType<typeof scoreViews>, type: string) => s.find((x) => x.def.type === type)!.score

describe('which files offer the Timeline mode', () => {
  test('records with a time offer it, and open in it only where no other mode fits', () => {
    // an event log whose records nest objects: the Table is offered under Raw, and the Timeline is the mode
    const log = scoreViews('agents/events.jsonl', 'text', nested, null, TIME)
    expect(score(log, 'timeline')).toBe(TIMELINE_SCORE)
    expect(pickView(log).type).toBe('timeline')
    // flat records open in the Table, a transcript in the Transcript, a timed CSV file in the Table: the Timeline beside
    expect(pickView(scoreViews('agents/flat.jsonl', 'text', flat, null, TIME)).type).toBe('table')
    expect(pickView(scoreViews('run/trajectory.json', 'text', [], { format: 'json', score: 0.5 }, { key: 'timestamp' })).type).toBe('transcript')
    const csv = scoreViews('clicks.csv', 'text', [{ text: 'time,user' }], null, { key: 'time' })
    expect(pickView(csv).type).toBe('table')
    expect(score(csv, 'timeline')).toBeGreaterThan(0)
  })
  test('without a time key, or for a database, it is not offered, and every other mode scores as before', () => {
    expect(score(scoreViews('agents/events.jsonl', 'text', nested, null, null), 'timeline')).toBe(0)
    expect(pickView(scoreViews('agents/events.jsonl', 'text', nested, null)).type).toBe('raw')
    expect(score(scoreViews('forge.db', 'forge', [], null, TIME), 'timeline')).toBe(0)
    const before = scoreViews('agents/flat.jsonl', 'text', flat, null).filter((s) => s.def.type !== 'timeline')
    const after = scoreViews('agents/flat.jsonl', 'text', flat, null, TIME).filter((s) => s.def.type !== 'timeline')
    expect(after.map((s) => [s.def.type, s.score])).toEqual(before.map((s) => [s.def.type, s.score]))
  })
})

const EVENTS: SourceEvents = {
  path: 'agents/events.jsonl',
  time: 'ts',
  total: 3,
  untimed: 1,
  partial: false,
  keys: [
    { key: 'page', values: Array.from({ length: 40 }, (_, i) => ({ value: `p${i}`, n: 1 })), more: { values: 0, n: 0 }, none: 0 },
    { key: 'agent', values: [{ value: 'a1', n: 2 }, { value: 'a2', n: 1 }], more: { values: 0, n: 0 }, none: 0 },
    { key: 'event', values: [{ value: 'deploy', n: 2 }, { value: 'alert', n: 1 }], more: { values: 0, n: 0 }, none: 0 },
  ],
  events: [
    { ref: 'agents/events.jsonl#L3', line: 3, t: 1789372860, text: 'first', v: ['p1', 'a1', 'deploy'] },
    { ref: 'agents/events.jsonl#L1', line: 1, t: 1789372920, text: 'second', v: ['p2', 'a2', 'alert'] },
  ],
}

describe('what the reader sends the page', () => {
  test('the keys Color by offers and each record’s values of them, Color by on the key Files opens on, Rows on the next', () => {
    const got = timelineAnswer(EVENTS)
    // a key whose values name nearly each record on its own is not offered, as in Color by
    expect(got.keys.map((k) => k.key)).toEqual(['agent', 'event'])
    expect(got.events.map((e) => e.v)).toEqual([
      ['a1', 'deploy'],
      ['a2', 'alert'],
    ])
    expect(got.initial).toEqual({ color: 'agent', rows: 'event' })
    expect(timelineAnswer({ ...EVENTS, keys: [], events: EVENTS.events.map((e) => ({ ...e, v: [] })) }).initial).toEqual({ color: '', rows: '' })
  })
})

describe('the Timeline mode in the reader', () => {
  const P = 'agents/events.jsonl'
  async function open(picked?: string) {
    vi.stubGlobal('fetch', async () => new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    const records = nested.map((r, i) => ({ line: i + 1, record: r, blocks: [{ kind: 'raw' as const, text: JSON.stringify(r) }], meta: {} }))
    const page: SourcePage = { path: P, kind: 'text', total_lines: 3, start: 1, records, time: TIME }
    vi.spyOn(api, 'source').mockResolvedValue(page)
    const pageDoc = vi.spyOn(api, 'timelinePage').mockResolvedValue('<!doctype html><p>timeline</p>')
    const events = vi.spyOn(api, 'sourceEvents').mockResolvedValue(EVENTS)
    const resolve = vi.spyOn(api, 'resolveRef').mockResolvedValue({ ref: `${P}#L3`, kind: 'record', excerpt: '', record: { ts: 'x', agent: 'a1' } })
    if (picked) localStorage.setItem(pickKey('w', P), JSON.stringify(picked))
    const el = await mount(<Reader workspace="w" path={P} kind="text" labels={NO_LABELS} lead={<span />} />)
    await settle()
    await settle()
    return { el, pageDoc, events, resolve }
  }
  const modes = (el: HTMLElement) => [...el.querySelectorAll('.reader-modes [role="radio"], .reader-modes button')].map((b) => b.textContent)

  test('an event log opens in it: the frame fills the reader, with no strip, no Color by row and no find of the reader', async () => {
    const { el, pageDoc } = await open()
    expect(modes(el)).toEqual(['Table', 'Timeline', 'Raw'])
    expect(pageDoc).toHaveBeenCalledWith('w')
    const frame = el.querySelector<HTMLIFrameElement>('.reader-viewer iframe.viewer-frame')
    expect(frame).not.toBeNull()
    expect(frame!.getAttribute('srcdoc')).toContain('timeline')
    expect(el.querySelector('.reader-colorbar')).toBeNull()
    expect(el.querySelector('.reader-find-open')).toBeNull()
    expect(el.querySelector('.reader-body')).toBeNull()
  })

  test('the page’s fetches are answered by the reader: the records with a time, and a record read whole', async () => {
    const { el, events, resolve } = await open()
    const frame = el.querySelector<HTMLIFrameElement>('iframe.viewer-frame')!
    const win = frame.contentWindow!
    const sent: any[] = []
    vi.spyOn(win, 'postMessage').mockImplementation((msg: unknown) => void sent.push(msg))
    const ask = async (id: number, query: unknown) =>
      act(async () => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'thimble:fetch', id, query }, source: win }))
        await new Promise((r) => setTimeout(r, 0))
      })
    await ask(1, { op: 'events' })
    expect(events).toHaveBeenCalledWith('w', P)
    const answer = sent.find((m) => m.type === 'thimble:result' && m.id === 1)
    expect(answer.data.initial).toEqual({ color: 'agent', rows: 'event' })
    expect(answer.data.events.map((e: { ref: string }) => e.ref)).toEqual([`${P}#L3`, `${P}#L1`])
    await ask(2, { op: 'record', ref: `${P}#L3` })
    expect(resolve).toHaveBeenCalledWith('w', `${P}#L3`)
    expect(sent.find((m) => m.type === 'thimble:result' && m.id === 2).data).toEqual({ record: { ts: 'x', agent: 'a1' } })
  })

  test('the Table picked for the file opens it in the Table, with the Timeline in the switcher', async () => {
    const { el, pageDoc } = await open('table')
    expect(modes(el)).toEqual(['Table', 'Timeline', 'Raw'])
    expect(el.querySelector('iframe.viewer-frame')).toBeNull()
    expect(el.querySelector('.reader-table')).not.toBeNull()
    expect(pageDoc).not.toHaveBeenCalled()
  })
})
