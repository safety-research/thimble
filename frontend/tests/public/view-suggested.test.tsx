// @vitest-environment jsdom
// A viewer the File browser suggests for a file type (backend views.suggest) is not yet a view the analyst chose: the
// views bar lists neither it nor its build until it is accepted (files/ViewsBar useViews). The server is a fake fetch.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useViews } from '../../src/files/ViewsBar.tsx'
import type { Proposal } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const proposal = (slug: string, status: Proposal['status']): Proposal => ({ slug, name: slug, status, why: '', claims: ['**/*.cast'], arrangement: '', proposed_by: 'files', ts: '2026-09-25T10:00:00+00:00' })

beforeEach(() => {
  vi.stubGlobal('fetch', async (url: string) => {
    const body = String(url).includes('/proposals') ? [proposal('replay', 'suggested'), proposal('timeline', 'building')] : []
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

function Probe() {
  const { proposals } = useViews('cast-ws')
  return <span id="names">{proposals.map((p) => p.slug).join(',')}</span>
}

test('a suggested viewer is left out of the views bar until it is accepted', async () => {
  const el = await mount(<Probe />)
  await settle()
  await settle()
  expect(el.querySelector('#names')!.textContent).toBe('timeline')
})
