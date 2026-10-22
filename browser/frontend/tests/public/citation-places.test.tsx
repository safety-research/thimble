// @vitest-environment jsdom
// Citations of files: a file cited by a path written from a subfolder opens the file the server read, and a file
// citation whose place is gone shows why in place on a click, never a server path.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { ChatMarkdown, ChipContext } from '../../src/chat/markdown.tsx'
import { bus } from '../../src/lib/bus.ts'
import { plainDetail, refFailure } from '../../src/lib/refPlaces.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const click = async (el: HTMLElement) => {
  await act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await settle()
  await settle()
}

test('a click on a citation written from a subfolder opens the file as the folder holds it', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', async () => json({ ref: 'shift/notes.jsonl#L2', kind: 'record', path: 'shift/notes.jsonl', line: 2, moved_from: 'notes.jsonl#L2', excerpt: 'beta' }))
  const opened: string[] = []
  const off = bus.on('openRef', (e) => void opened.push(e.ref))
  const el = await mount(
    <ChipContext.Provider value={{ workspace: 'w1', broken: new Set() }}>
      <ChatMarkdown text="Beta [signed off](notes.jsonl#L2)." />
    </ChipContext.Provider>,
  )
  await settle()
  const chip = el.querySelector<HTMLElement>('.refchip-value')!
  expect(chip.classList.contains('refchip-quiet')).toBe(false)
  await click(chip)
  off()
  expect(opened).toEqual(['shift/notes.jsonl#L2'])
})

test('a click on a file citation whose place is gone shows why in place and opens nothing', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', async () => json({ detail: "no such file: 'gone.jsonl'" }, 404))
  const opened: string[] = []
  const off = bus.on('openRef', (e) => void opened.push(e.ref))
  const el = await mount(
    <ChipContext.Provider value={{ workspace: 'w2', broken: new Set() }}>
      <ChatMarkdown text="It [failed](gone.jsonl#L3)." />
    </ChipContext.Provider>,
  )
  await settle()
  const chip = el.querySelector<HTMLElement>('.refchip-value')!
  expect(chip.classList.contains('refchip-quiet')).toBe(true)
  await click(chip)
  off()
  expect(opened).toEqual([])
  expect(document.body.textContent).toContain("Not linked — the cited place is gone (no such file: 'gone.jsonl')")
})

test("a failure's reason never shows a system error or a path on the server's disk", () => {
  expect(refFailure(new Error("404 no such file: 'gone.jsonl'"))).toBe("the cited place is gone (no such file: 'gone.jsonl')")
  expect(refFailure(new Error("404 [Errno 2] No such file or directory: '/srv/data/gone.jsonl'"))).toBe('the cited place is gone')
  expect(plainDetail("no file x in '/home/someone/data'")).toBeNull()
})
