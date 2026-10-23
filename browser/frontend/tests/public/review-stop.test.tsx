// @vitest-environment jsdom
// The mark of a running view review (src/files/ViewPane.tsx ReviewMark): a click on it opens its hover card and never
// stops the review; Stop in the card asks first, and only Stop under the question sends the stop.
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ReviewMark } from '../../src/files/ViewPane.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

function stubFetch(): string[] {
  const sent: string[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    sent.push(`${init?.method ?? 'GET'} ${url}`)
    return new Response(JSON.stringify(url.includes('/proposals') ? [] : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return sent
}

const writes = (sent: string[]) => sent.filter((x) => !x.startsWith('GET'))
const popButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.bcell-check-pop button')].filter((b) => b.textContent?.trim() === text)
const click = async (b: HTMLElement) => {
  await act(async () => b.click())
  await settle()
}

describe("a running view review's mark", () => {
  test('a click on the mark opens its card and does not stop the review', async () => {
    const sent = stubFetch()
    const el = await mount(<ReviewMark ws="mini" slug="posts" review={{ state: 'running' }} />)
    await click(el.querySelector<HTMLButtonElement>('button.bcell-check-mark')!)
    expect(writes(sent)).toEqual([])
    expect(document.querySelector('.bcell-check-pop')).not.toBeNull()
    expect(popButton('Stop')).toHaveLength(1)
  })

  test('Stop asks first, Cancel keeps it running, and Stop under the question stops it', async () => {
    const sent = stubFetch()
    const el = await mount(<ReviewMark ws="mini" slug="posts" review={{ state: 'running', round: 1 }} />)
    await click(el.querySelector<HTMLButtonElement>('button.bcell-check-mark')!)
    await click(popButton('Stop')[0])
    expect(writes(sent)).toEqual([])
    expect(document.querySelector('.view-review-stop')?.textContent).toContain('Stop the review?')
    await click(popButton('Cancel')[0])
    expect(document.querySelector('.view-review-stop')).toBeNull()
    expect(writes(sent)).toEqual([])
    await click(popButton('Stop')[0])
    await click(popButton('Stop')[0])
    expect(writes(sent)).toEqual(['DELETE /api/ws/mini/views/posts/review'])
  })

  test('a stopped review still runs again on one click of its mark', async () => {
    const sent = stubFetch()
    const el = await mount(<ReviewMark ws="mini" slug="posts" review={{ state: 'stopped' }} />)
    await click(el.querySelector<HTMLButtonElement>('button.bcell-check-mark')!)
    expect(writes(sent)).toHaveLength(1)
    expect(writes(sent)[0]).toMatch(/^POST \/api\/ws\/mini\/views\/posts\/review/)
  })
})
