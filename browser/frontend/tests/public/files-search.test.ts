// @vitest-environment jsdom
// The Files search's text half has no time limit (src/files/FileSearch.tsx): while it reads, it says how many files it
// has read, and the analyst's Stop asks the server to stop, keeps what it found and says how many files the stopped
// search read, from its closing line.
import { act, createElement } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { grepStatus, useFileGrep } from '../../src/files/FileSearch.tsx'
import { api } from '../../src/lib/api.ts'
import type { GrepDone, GrepProgress } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

const progress = { progress: true as const, scanned: 12345, of: 1032208 }
const closing: GrepDone = { done: true, files: 1, hits: 3, scanned: 12401, of: 1032208, complete: false }
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))

test('a text search says how far it has read, and Stop asks the server to stop and says how many files it read', async () => {
  let finish: (d: GrepDone) => void = () => undefined
  const stopped = vi.spyOn(api, 'stopGrep').mockImplementation(async () => {
    setTimeout(() => finish(closing), 0)
    return { stopped: true }
  })
  // the server names the search, then says how far it has read
  vi.spyOn(api, 'grepFiles').mockImplementation((_c, _t, _f, done, signal, prog, search) => {
    finish = done
    setTimeout(() => (search!(41), prog!(progress as GrepProgress)), 0)
    return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted'))))
  })
  const seen: { now: ReturnType<typeof useFileGrep> | null } = { now: null }
  function Probe() {
    seen.now = useFileGrep('ws', 'needle')
    return null
  }
  await mount(createElement(Probe))
  await wait(300)
  expect(grepStatus(seen.now!)).toMatch(/12,345 of 1,032,208 files/)
  await act(async () => seen.now!.stop())
  expect(stopped).toHaveBeenCalledWith('ws', 41)
  await wait(20)
  expect(seen.now!).toMatchObject({ loading: false, stopped: true, done: closing })
  expect(grepStatus(seen.now!)).toMatch(/^Stopped .*12,401 of 1,032,208 files/)
})
