// @vitest-environment jsdom
// Viewers for a file type (src/files/typeViewers.ts, src/files/Reader.tsx, src/files/viewReady.ts): a file whose best
// built-in mode is Raw, and that no viewer claims, asks thimble once per type and page whether a viewer would help
// (POST /views/suggest), whose view proposal then shows on the card above the chat's composer, not beside Raw. A built
// viewer is never the file's mode until the analyst picks it (or a ref's fragment needs it); until it is opened its
// mode wears the accent outline (`is-fresh`). The first build of an accepted view proposal waits as ready, never
// opening by itself.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { pickKey, Reader } from '../../src/files/Reader.tsx'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import { markReady, onBuilt } from '../../src/files/viewReady.ts'
import { suggestOnce } from '../../src/files/typeViewers.ts'
import { api } from '../../src/lib/api.ts'
import type { SourcePage, View } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const NO_LABELS = { all: [], on: [], focus: null, byId: new Map(), presence: new Map(), labelled: new Map() } as unknown as FilesLabels

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('the first build of an accepted view proposal', () => {
  test('waits as ready, typing or not; a view the analyst asked for otherwise still opens', () => {
    expect(onBuilt({ status: 'built', asked: true, accepted: true, version: 'v1' }, false, false)).toBe('ready')
    expect(onBuilt({ status: 'built', asked: true, accepted: true }, false, true)).toBe('ready')
    expect(onBuilt({ status: 'built', asked: true }, false, false)).toBe('open')
    expect(onBuilt({ status: 'built', accepted: true }, true, false)).toBeNull()
  })
})

describe('asking for a viewer', () => {
  test('once per workspace and type on a page', () => {
    const ask = vi.spyOn(api, 'suggestView').mockResolvedValue({ slug: null })
    expect(suggestOnce('fv-once', 'talks/a.vtt')).toBe(true)
    expect(suggestOnce('fv-once', 'talks/b.VTT')).toBe(false)
    expect(suggestOnce('fv-once', 'talks/c.srt')).toBe(true)
    expect(suggestOnce('fv-other', 'talks/a.vtt')).toBe(true)
    expect(ask.mock.calls).toEqual([
      ['fv-once', 'talks/a.vtt'],
      ['fv-once', 'talks/c.srt'],
      ['fv-other', 'talks/a.vtt'],
    ])
  })
})

describe('the reader', () => {
  const VIEWER: View = { slug: 'cue-viewer', origin: 'workspace', name: 'Cue viewer', description: 'Each cue with its time.', claims: ['**/*.cue'], accepts: [], units: [], libs: [], built: '2026-10-14T10:00:00Z', ok: true, forms: [], file_type: true, unit: 'file' }

  async function open(ws: string, path: string, viewers: View[], picked?: string) {
    vi.stubGlobal('fetch', async () => new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    const lines = ['00:00:01 hello', '00:00:04 there', '00:00:09 again']
    const page: SourcePage = { path, kind: 'text', total_lines: lines.length, start: 1, records: lines.map((text, i) => ({ line: i + 1, record: { text }, blocks: [{ kind: 'text' as const, text }], meta: {} })) }
    vi.spyOn(api, 'source').mockResolvedValue(page)
    vi.spyOn(api, 'viewsForFile').mockResolvedValue(viewers)
    const ask = vi.spyOn(api, 'suggestView').mockResolvedValue({ slug: null })
    if (picked) localStorage.setItem(pickKey(ws, path), JSON.stringify(picked))
    const el = await mount(<Reader workspace={ws} path={path} kind="text" labels={NO_LABELS} lead={<span />} />)
    await settle()
    await settle()
    return { el, ask }
  }
  const modes = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.reader-modes .seg-opt')].map((b) => ({ label: b.textContent, active: b.classList.contains('active') || b.getAttribute('aria-checked') === 'true', fresh: b.classList.contains('is-fresh') }))

  test('a Raw-best file no viewer claims asks thimble about its type once, and shows no proposal beside Raw', async () => {
    const { el, ask } = await open('fv-ask', 'talks/one.cue', [])
    expect(ask.mock.calls).toEqual([['fv-ask', 'talks/one.cue']])
    expect(el.querySelector('.files-proposal, .files-proposal-opt')).toBeNull()
    unmountAll()
    ask.mockClear()
    await open('fv-ask', 'talks/two.cue', [])
    expect(ask).not.toHaveBeenCalled()
  })

  test('a built viewer, not picked, leaves the file in Raw, its mode outlined until opened; picked, the file opens in it', async () => {
    markReady('fv-built', VIEWER.slug)
    const { el, ask } = await open('fv-built', 'talks/one.cue', [VIEWER])
    expect(ask).not.toHaveBeenCalled()
    const m = modes(el)
    expect(m.find((x) => x.label === 'Raw')?.active).toBe(true)
    expect(m.find((x) => x.label === 'Cue viewer')).toMatchObject({ active: false, fresh: true })
    unmountAll()
    const picked = await open('fv-built', 'talks/one.cue', [VIEWER], 'v:cue-viewer')
    expect(modes(picked.el).find((x) => x.label === 'Cue viewer')?.active).toBe(true)
    // shown, it counts as opened: the outline goes
    expect(modes(picked.el).find((x) => x.label === 'Cue viewer')?.fresh).toBe(false)
  })
})
