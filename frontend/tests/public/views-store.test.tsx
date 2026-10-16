// @vitest-environment jsdom
// The workspace's views list (src/lib/views.ts) is read once for every component that lists it, read again once after
// a `view` event, also when the event comes while a read is under way, and a lookup of a view the list lacks reads it
// again. The views of one file are read once for the callers that ask in the same task.
import { afterEach, expect, test, vi } from 'vitest'
import { api } from '../../src/lib/api.ts'
import { bus } from '../../src/lib/bus.ts'
import type { View } from '../../src/lib/types.ts'
import { refreshViews, useViewList } from '../../src/lib/views.ts'
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

test('a view built while the list is being read shows once that read ends', async () => {
  let answer: (v: View[]) => void = () => {}
  const views = vi
    .spyOn(api, 'views')
    .mockReturnValueOnce(new Promise<View[]>((r) => (answer = r)))
    .mockResolvedValue([view('timeline'), view('inbox')])
  const shown: string[] = []
  function Lister() {
    shown.push(useViewList('ws-slow')?.map((v) => v.slug).join(',') ?? 'null')
    return null
  }
  await mount(<Lister />)
  expect(views).toHaveBeenCalledTimes(1)
  const again = refreshViews('ws-slow')
  const alsoAgain = refreshViews('ws-slow')
  expect(views).toHaveBeenCalledTimes(1)
  answer([view('timeline')])
  expect((await again).map((v) => v.slug)).toEqual(['timeline', 'inbox'])
  expect(await alsoAgain).toBe(await again)
  await settle()
  expect(views).toHaveBeenCalledTimes(2)
  expect(shown.at(-1)).toBe('timeline,inbox')
})
