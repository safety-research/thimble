// @vitest-environment jsdom
// When the server goes away or changes under an open tab. The stream (src/lib/sse.ts) says it is down on every failure,
// including a drop the browser retries itself, and says it reopened when it comes back; the page for a workspace the
// server does not hold (src/shell/UnknownWorkspace.tsx) names the tab's folder and links the ones the server holds; an
// empty folder says where thimble looks (src/files/Tree.tsx); and a server that serves another build than the tab
// loaded is told apart from one whose build is unknown (src/shell/NewVersion.tsx). EventSource is a stand-in.
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { emptyFolderNote } from '../../src/files/Tree.tsx'
import { openStream } from '../../src/lib/sse.ts'
import { isNewer, servedBuild } from '../../src/shell/NewVersion.tsx'
import { UnknownWorkspace } from '../../src/shell/UnknownWorkspace.tsx'

class FakeSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  static all: FakeSource[] = []
  readyState = FakeSource.CONNECTING
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeSource.all.push(this)
  }
  addEventListener() {}
  close() {
    this.readyState = FakeSource.CLOSED
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the stream', () => {
  test('says it is down on a drop the browser retries, and reopened when it comes back', () => {
    vi.stubGlobal('EventSource', FakeSource)
    const seen: string[] = []
    const release = openStream('/api/ws/w/events', {
      onEvent: () => {},
      onDown: () => seen.push('down'),
      onReopen: () => seen.push('reopen'),
    })
    const es = FakeSource.all.at(-1)!
    es.readyState = FakeSource.OPEN
    es.onopen!()
    expect(seen).toEqual([])
    es.readyState = FakeSource.CONNECTING // the server went away; the browser retries on its own
    es.onerror!()
    expect(seen).toEqual(['down'])
    es.readyState = FakeSource.OPEN
    es.onopen!()
    expect(seen).toEqual(['down', 'reopen'])
    es.readyState = FakeSource.CLOSED // an answer that was no stream: the client retries itself
    es.onerror!()
    expect(seen).toEqual(['down', 'reopen', 'down'])
    release()
  })
})

describe('a workspace the server does not hold', () => {
  test('names the tab\'s folder and links the ones the server holds', () => {
    const html = renderToStaticMarkup(<UnknownWorkspace ws="gone" held={['harbor', 'orchard']} />)
    expect(html).toMatch(/This tab is for the folder “gone”, which this thimble server does not have open\./)
    expect(html).toMatch(/<a href="\/\?ws=harbor">harbor<\/a>/)
    expect(html).toMatch(/<a href="\/\?ws=orchard">orchard<\/a>/)
    expect(html).toMatch(/run \/thimble in a Claude Code session in the folder you want/)
    const none = renderToStaticMarkup(<UnknownWorkspace ws="gone" held={[]} />)
    expect(none).toMatch(/it prints the address to open/)
    expect(none).not.toMatch(/<a /)
  })

  test('an empty folder says where thimble looks; a folder with files, or one still loading, says nothing', () => {
    const listing = (n: number) => ({ state: 'ok', listing: { path: '', files: [], folders: [], n_files: n } }) as unknown as Parameters<typeof emptyFolderNote>[0]
    expect(emptyFolderNote(listing(0))).toMatch(/^This folder has no files\. thimble shows the folder it was started in/)
    expect(emptyFolderNote(listing(3))).toBeNull()
    expect(emptyFolderNote({ state: 'loading' } as unknown as Parameters<typeof emptyFolderNote>[0])).toBeNull()
    expect(emptyFolderNote(undefined)).toBeNull()
  })
})

describe('a newer build', () => {
  test('is one the server names apart from the one the tab loaded; unknown on either side is not newer', async () => {
    expect(isNewer('100', '200')).toBe(true)
    expect(isNewer('100', '100')).toBe(false)
    expect(isNewer(null, '200')).toBe(false)
    expect(isNewer('100', null)).toBe(false)
    vi.stubGlobal('fetch', async (url: string) => ({ ok: true, json: async () => ({ ok: true, ui: url === '/api/health' ? '123' : null }) }))
    expect(await servedBuild()).toBe('123')
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ ok: true, ui: null }) }))
    expect(await servedBuild()).toBeNull()
    vi.stubGlobal('fetch', async () => {
      throw new Error('connection refused')
    })
    expect(await servedBuild()).toBeNull()
  })
})
