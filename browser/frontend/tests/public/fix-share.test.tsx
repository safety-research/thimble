// @vitest-environment jsdom
// Share on a fix (src/fixes/ShareFix.tsx, src/fixes/share.ts): the click opens a tab at once, asks the server for the
// share page (POST /api/fixes/{id}/share, backend app/fix_share.py) and shows the page in that tab; the line under it
// says what the privacy check took out, with the page and GitHub's new-issue page to open again. A failure closes the
// tab and says why. Nothing is sent from thimble. All data here is made up.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ShareFix } from '../../src/fixes/ShareFix.tsx'
import { sharedLine } from '../../src/fixes/share.ts'
import { mount, unmountAll } from './mount.tsx'

const URL_ = 'https://github.com/safety-research/thimble/issues/new?title=The%20minimap%20covers%20cards&body=What%20was%20wrong'
const SHARED = { id: 3, title: 'The minimap covers cards', took: 'took 1 file name out of the text', url: URL_, shortened: false, text: 'claude', page: '/api/fixes/3/share/page', note: '' }

let calls: { url: string; init?: RequestInit }[] = []
let answer: () => Response
let tab: { location: { href: string }; document: { title: string; body: { textContent: string } }; close: () => void; closed: boolean }

beforeEach(() => {
  calls = []
  answer = () => new Response(JSON.stringify(SHARED), { status: 200, headers: { 'content-type': 'application/json' } })
  tab = { location: { href: 'about:blank' }, document: { title: '', body: { textContent: '' } }, closed: false, close: () => void (tab.closed = true) }
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return answer()
  })
  vi.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window)
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('Share opens a tab at the click, then shows the share page there, and says what the privacy check took out', async () => {
  const el = await mount(<ShareFix id={3} ws="w1" />)
  const share = el.querySelector<HTMLButtonElement>('[data-tel="fix-share"]')!
  expect(share.textContent).toBe('Share')
  await act(async () => share.click())
  expect(window.open).toHaveBeenCalledWith('about:blank', '_blank')
  const post = calls.find((c) => c.url.endsWith('/fixes/3/share'))!
  expect(post.url).toBe('/api/fixes/3/share')
  expect(post.init?.method).toBe('POST')
  expect(JSON.parse(String(post.init?.body))).toEqual({ ws: 'w1' })
  expect(tab.location.href).toBe('/api/fixes/3/share/page')
  const line = el.querySelector('[data-testid="fix-share-line"]')!
  expect(line.textContent).toContain('Privacy check: took 1 file name out of the text. The share page opened in a new tab.')
  const links = [...line.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target')])
  expect(links).toEqual([['Share page', '/api/fixes/3/share/page', '_blank'], ['Open a GitHub issue directly', URL_, '_blank']])
})

test('a share the server refuses closes the tab and says why', async () => {
  answer = () => new Response(JSON.stringify({ detail: 'fix 3 is working: there is nothing to share yet' }), { status: 409, headers: { 'content-type': 'application/json' } })
  const el = await mount(<ShareFix id={3} ws={null} />)
  await act(async () => el.querySelector<HTMLButtonElement>('[data-tel="fix-share"]')!.click())
  expect(tab.closed).toBe(true)
  expect(el.querySelector('[role="alert"]')!.textContent).toBe('Fix 3 was not shared: fix 3 is working: there is nothing to share yet')
  expect(el.querySelector('[data-testid="fix-share-line"]')).toBeNull()
})

test("the line says when the link holds only part of the text, and when Claude wrote none", () => {
  expect(sharedLine({ took: 'found nothing of yours to take out', note: '', shortened: true }, false)).toBe(
    'Privacy check: found nothing of yours to take out. Open the share page below. The text is longer than a GitHub link holds, so the link has the first part of it.',
  )
  expect(sharedLine({ took: 'took 2 paths out of the text', note: 'Claude did not write the text (timeout)', shortened: false }, true)).toBe(
    'Privacy check: took 2 paths out of the text. The share page opened in a new tab. Claude did not write the text (timeout); the page has your words and what the fix does.',
  )
})
