// @vitest-environment jsdom
// The workspace's views list (src/lib/views.ts) is read once for every component that lists it, read again once after
// a `view` event, and a lookup of a view the list lacks reads it again.
import { afterEach, expect, test, vi } from 'vitest'
import { api } from '../../src/lib/api.ts'
import { bus } from '../../src/lib/bus.ts'
import type { View } from '../../src/lib/types.ts'
import { findView, useViewList } from '../../src/lib/views.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

const view = (slug: string) => ({ slug, name: slug, ok: true, origin: 'workspace', first_file: 'a.jsonl' }) as unknown as View

test('the shell and Files share one read of the views list, and a view event reads it once more', async () => {
  const views = vi.spyOn(api, 'views').mockResolvedValue([view('timeline')])
  const seen: string[] = []
  function Lister({ name }: { name: string }) {
    const list = useViewList('ws-share')
    seen.push(`${name}:${list?.map((v) => v.slug).join(',') ?? 'null'}`)
    return null
  }
  await mount(
    <>
      <Lister name="shell" />
      <Lister name="files" />
    </>,
  )
  await settle()
  expect(views).toHaveBeenCalledTimes(1)
  expect(seen).toContain('shell:timeline')
  expect(seen).toContain('files:timeline')
  vi.useFakeTimers()
  try {
    bus.emit('view', { slug: 'timeline', status: 'built' })
    bus.emit('view', { slug: 'timeline', status: 'built' })
    await vi.advanceTimersByTimeAsync(500)
  } finally {
    vi.useRealTimers()
  }
  expect(views).toHaveBeenCalledTimes(2)
})

test('a lookup of a view the list lacks reads the list again', async () => {
  const views = vi.spyOn(api, 'views').mockResolvedValueOnce([view('timeline')]).mockResolvedValueOnce([view('timeline'), view('inbox')])
  expect((await findView('ws-find', 'timeline'))?.slug).toBe('timeline')
  expect(views).toHaveBeenCalledTimes(1)
  expect((await findView('ws-find', 'timeline'))?.slug).toBe('timeline')
  expect(views).toHaveBeenCalledTimes(1)
  expect((await findView('ws-find', 'inbox'))?.slug).toBe('inbox')
  expect(views).toHaveBeenCalledTimes(2)
})
