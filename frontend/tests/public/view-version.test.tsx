// @vitest-environment jsdom
// The version a view pane shows (src/files/viewVersion.tsx): switching to another view never renders it with the
// version of the view before, which the server does not have for it; a version with no page for the browser yet gives
// way to the next one by itself.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'
import { usePinnedView } from '../../src/files/viewVersion.tsx'
import { unmountAll } from './mount.tsx'

afterEach(unmountAll)

test('a switch to another view renders it with its own version from the first render', async () => {
  const seen: string[] = []
  function Pane({ slug, version }: { slug: string; version: string }) {
    const { pinned } = usePinnedView('ws', slug, version)
    seen.push(`${slug}@${pinned}`)
    return null
  }
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  await act(async () => root.render(<Pane slug="timeline" version="aaa" />))
  await act(async () => root.render(<Pane slug="inbox" version="bbb" />))
  expect(seen.filter((s) => s.startsWith('inbox'))).not.toContain('inbox@aaa')
  expect(seen.at(-1)).toBe('inbox@bbb')
  await act(async () => root.render(<Pane slug="inbox" version="ccc" />))
  expect(seen.at(-1)).toBe('inbox@bbb')
  act(() => root.unmount())
})

test('a view whose page for the browser is being built loads the version that brings it by itself', async () => {
  // bug hunt round 9, J13: a view built in the terminal, opened in the browser while its page there was built, said
  // "building the page for the browser…" until a Reload, with only "Updated · Reload" beside it
  const seen: string[] = []
  const stale: boolean[] = []
  function Pane({ version, pageless }: { version: string; pageless: boolean }) {
    const { pinned, stale: s } = usePinnedView('ws', 'trajectories', version, pageless)
    seen.push(`${pinned}`)
    stale.push(s)
    return null
  }
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  await act(async () => root.render(<Pane version="term" pageless />))
  await act(async () => root.render(<Pane version="both" pageless={false} />))
  expect(seen.at(-1)).toBe('both')
  expect(stale.at(-1)).toBe(false)
  // a view with its page keeps the version it shows, with Updated and Reload
  await act(async () => root.render(<Pane version="revised" pageless={false} />))
  expect(seen.at(-1)).toBe('both')
  expect(stale.at(-1)).toBe(true)
  act(() => root.unmount())
})
