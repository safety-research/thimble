// @vitest-environment jsdom
// The version a view pane shows (src/files/viewVersion.tsx): switching to another view never renders it with the
// version of the view before, which the server does not have for it.
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
