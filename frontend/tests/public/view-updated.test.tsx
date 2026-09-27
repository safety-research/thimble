// @vitest-environment jsdom
// A newer version of a view while the analyst browses it (files/viewVersion.tsx, backend views.VERSIONS_SUBDIR): the
// pane keeps the page of the version it opened and says Updated with Reload in its head; Reload asks the page what the
// analyst is looking at and loads the newer version, which gets it back; the analyst's own Undo loads at once. While
// the newer version builds, the view stays in the bar, its name shimmering, and open at its version. A newer version no
// pane shows waits as updated, with the views bar's dot, until opened. The server is a fake fetch.
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ViewPane } from '../../src/files/ViewPane.tsx'
import { holdShown, isShown, markOpened, onBuilt, useOpenAskedViews, useUpdatedViews } from '../../src/files/viewReady.ts'
import { useViews, ViewsBar, type BuiltView } from '../../src/files/ViewsBar.tsx'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import { dispatch } from '../../src/lib/events.ts'
import { mount, settle, unmountAll } from './mount.tsx'

let calls: { url: string; method: string }[] = []
beforeEach(() => {
  calls = []
  window.localStorage.clear()
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' })
    if (String(url).includes('/frame')) return new Response('<html><head></head><body></body></html>', { status: 200 })
    return new Response(JSON.stringify(String(url).includes('/proposals') ? [] : {}), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const labels: FilesLabels = { all: [], on: [], focus: null, setFocus: () => undefined, byId: new Map(), presence: new Map(), toggle: () => undefined, setClasses: () => undefined, setColour: () => undefined, save: async () => ({}) as never }
const frames = () => calls.filter((c) => c.url.includes('/views/threads/frame')).map((c) => new URL(c.url, 'http://t').searchParams.get('v'))

async function paneAt(first: BuiltView) {
  let setView: (v: BuiltView) => void = () => undefined
  function Holder() {
    const [view, set] = useState(first)
    setView = set
    return <ViewPane ws="w" view={view} path="board.jsonl" kind="board" labels={labels} />
  }
  const el = await mount(<Holder />)
  await settle()
  return { el, next: async (v: BuiltView) => (await act(async () => setView(v)), await settle()) }
}

describe('a newer version of a view the analyst has open', () => {
  test('keeps the page they are on and says Updated with Reload, which loads the newer version', async () => {
    const { el, next } = await paneAt({ slug: 'threads', name: 'Threads', version: 'aaaaaaaaaaaa' })
    expect(frames()).toEqual(['aaaaaaaaaaaa'])
    expect(el.querySelector('.view-updated')).toBeNull()
    const frame = el.querySelector('iframe')
    await next({ slug: 'threads', name: 'Threads', version: 'bbbbbbbbbbbb' })
    expect(frames(), 'no reload under the analyst').toEqual(['aaaaaaaaaaaa'])
    expect(el.querySelector('iframe')).toBe(frame)
    const notice = el.querySelector('.view-pane-head .view-updated')!
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toBe('UpdatedReload')
    await act(async () => notice.querySelector<HTMLButtonElement>('button')!.click())
    await settle()
    expect(frames()).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb'])
    expect(el.querySelector('.view-updated')).toBeNull()
  })

  test("the analyst's own Undo loads the version it brings back at once", async () => {
    const { el, next } = await paneAt({ slug: 'threads', name: 'Threads', version: 'bbbbbbbbbbbb', review: { state: 'done', revised: ['picture 1: the ticks overlap'] } })
    await act(async () => el.querySelector<HTMLButtonElement>('.view-pane-review .bcell-check-mark')!.focus())
    const undo = [...document.querySelectorAll<HTMLButtonElement>('.bcell-check-pop button')].find((b) => b.textContent === 'Undo')!
    await act(async () => undo.click())
    await next({ slug: 'threads', name: 'Threads', version: 'aaaaaaaaaaaa', review: { state: 'done', revised: [], undo: true } })
    expect(frames()).toEqual(['bbbbbbbbbbbb', 'aaaaaaaaaaaa'])
    expect(el.querySelector('.view-updated')).toBeNull()
  })

  test('the pane holds its view as shown while it is mounted', async () => {
    const { el } = await paneAt({ slug: 'threads', name: 'Threads', version: 'aaaaaaaaaaaa' })
    expect(isShown('w', 'threads')).toBe(true)
    expect(el.querySelector('iframe')).not.toBeNull()
    unmountAll()
    expect(isShown('w', 'threads')).toBe(false)
  })
})

describe('a view the orientation, a change or a dev ticket improves while the analyst has it open', () => {
  test('stays in the bar and open on its version while the new one builds, then says Updated', async () => {
    type Row = { status: string; revision?: boolean; version: string }
    let row: Row = { status: 'built', version: 'aaaaaaaaaaaa' }
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const u = String(url)
      calls.push({ url: u, method: init?.method ?? 'GET' })
      if (u.includes('/frame')) return new Response('<html><head></head><body></body></html>', { status: 200 })
      const proposal = { slug: 'threads', name: 'Threads', why: '', claims: ['board.jsonl'], arrangement: '', proposed_by: 'orient', ts: 't', status: row.status, ...(row.revision ? { revision: true } : {}) }
      const view = { slug: 'threads', name: 'Threads', origin: 'workspace', ok: true, claims: ['board.jsonl'], version: row.version, first_file: 'board.jsonl' }
      const body = u.endsWith('/views/proposals') ? [proposal] : u.endsWith('/views') ? [view] : {}
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    function Files() {
      const { views, proposals } = useViews('improve')
      const shown = views.find((v) => v.slug === 'threads')
      return (
        <>
          <ViewsBar ws="improve" value="v:threads" onChange={() => undefined} views={views} proposals={proposals} />
          {shown ? <ViewPane ws="improve" view={shown} path="board.jsonl" kind="board" labels={labels} /> : <span className="browser">File browser</span>}
        </>
      )
    }
    const el = await mount(<Files />)
    await settle()
    const frame = el.querySelector('iframe')
    expect(frame).not.toBeNull()
    const step = async (next: Row) => {
      row = next
      dispatch({ type: 'view', slug: 'threads', status: next.status, ...(next.status === 'built' ? { version: next.version } : {}) } as never)
      await act(async () => new Promise((r) => setTimeout(r, 250)))
      await settle()
    }
    const option = () => el.querySelector('.files-views .seg-opt[data-anchor="view:threads"]')
    for (const status of ['queued', 'building']) {
      await step({ status, revision: true, version: 'aaaaaaaaaaaa' })
      expect(el.querySelector('.browser'), `${status}: the pane stays on the view`).toBeNull()
      expect(el.querySelector('iframe'), `${status}: the page is not reloaded`).toBe(frame)
      expect(option()?.classList.contains('is-updating'), `${status}: its name shimmers in the bar`).toBe(true)
      expect(el.querySelector('.files-proposal'), 'not a proposal with a spinner').toBeNull()
      expect(el.querySelector('.view-updated')).toBeNull()
    }
    await step({ status: 'built', version: 'bbbbbbbbbbbb' })
    expect(el.querySelector('iframe')).toBe(frame)
    expect(option()?.classList.contains('is-updating')).toBe(false)
    expect(frames()).toEqual(['aaaaaaaaaaaa'])
    await act(async () => el.querySelector<HTMLButtonElement>('.view-pane-head .view-updated button')!.click())
    await settle()
    expect(frames()).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb'])
  })

  test('a change that fails leaves the pane as it was, with nothing to reload', async () => {
    const { el, next } = await paneAt({ slug: 'threads', name: 'Threads', version: 'aaaaaaaaaaaa', updating: true })
    const frame = el.querySelector('iframe')
    await next({ slug: 'threads', name: 'Threads', version: 'aaaaaaaaaaaa' })
    expect(el.querySelector('iframe')).toBe(frame)
    expect(el.querySelector('.view-updated')).toBeNull()
    expect(frames()).toEqual(['aaaaaaaaaaaa'])
  })
})

describe('a newer version of a view no pane shows', () => {
  test('is marked updated, not for the history, for a view a pane shows or for one the analyst asked for', () => {
    expect(onBuilt({ status: 'built', version: 'b' }, false, false)).toBe('updated')
    expect(onBuilt({ status: 'built', version: 'b' }, false, false, true)).toBeNull()
    expect(onBuilt({ status: 'built', version: 'b' }, true, false)).toBeNull()
    expect(onBuilt({ status: 'built' }, false, false)).toBeNull()
    expect(onBuilt({ status: 'built', version: 'b', asked: true }, false, false)).toBe('open')
  })

  test('shows the dot on its tab until it is opened', async () => {
    let updated: readonly string[] = []
    function Probe() {
      useOpenAskedViews('ws-up', new Map())
      updated = useUpdatedViews('ws-up')
      return null
    }
    await mount(<Probe />)
    const letGo = holdShown('ws-up', 'open-one')
    dispatch({ type: 'view', slug: 'open-one', status: 'built', version: 'bbbbbbbbbbbb' } as never)
    dispatch({ type: 'view', slug: 'threads', status: 'built', version: 'bbbbbbbbbbbb' } as never)
    await settle()
    expect(updated).toEqual(['threads'])
    letGo()
    const el = await mount(<ViewsBar ws="ws-up" value="browser" onChange={() => undefined} proposals={[]} views={[{ slug: 'threads', name: 'Threads' }, { slug: 'open-one', name: 'Open one' }]} />)
    const dots = [...el.querySelectorAll('.files-views .seg-opt[data-anchor^="view:"]')].map((o) => [o.getAttribute('data-anchor'), !!o.querySelector('.dot')])
    expect(dots).toEqual([['view:threads', true], ['view:open-one', false]])
    markOpened('ws-up', 'threads')
    await settle()
    expect(updated).toEqual([])
  })
})
