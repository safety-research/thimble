// @vitest-environment jsdom
// The Files search's text half has no time limit (src/files/FileSearch.tsx): while it reads, a row says how many
// files it has read, and the analyst's Stop keeps what it found, with its count marked as a floor (find.ts resultRows)
// and the number of files read taken from the stopped search's closing line.
import { act, createElement } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { grepStatus, useFileGrep } from '../../src/files/FileSearch.tsx'
import { api } from '../../src/lib/api.ts'
import { mount, unmountAll } from './mount.tsx'
import { resultRows } from '../../src/files/find.ts'
import type { GrepDone, GrepFile, GrepProgress } from '../../src/lib/types.ts'

const progress = { progress: true as const, scanned: 12345, of: 1032208 }
const closing: GrepDone = { done: true, files: 1, hits: 3, scanned: 12401, of: 1032208, complete: false }
const file: GrepFile = { path: 'a.jsonl', total: 3, complete: true, matches: [{ line: 4, text: 'the hit', hit: [4, 7] }] }

describe('the text search', () => {
  test('says how many files it has read while it runs, and how many it read once stopped', () => {
    const at = (loading: boolean, stopped: boolean, p: GrepProgress | null, done: GrepDone | null = null) => grepStatus({ loading, stopped, progress: p, done })
    expect(at(true, false, null)).toBeNull()
    expect(at(true, false, { ...progress, scanned: 0 })).toBe('Searching 1,032,208 files')
    expect(at(true, false, progress)).toBe('Searched 12,345 of 1,032,208 files')
    expect(at(true, true, progress)).toBe('Stopping')
    expect(at(false, true, progress, closing)).toBe('Stopped after 12,401 of 1,032,208 files')
    expect(at(false, true, progress)).toBe('Stopped')
    expect(at(false, false, progress)).toBeNull()
  })

  test('marks its count as a floor once stopped, and says how far it read in one place', () => {
    const head = (stopped: boolean, done: GrepDone | null) => resultRows(null, { files: [file], done, stopped }, false).find((r) => r.kind === 'head')
    expect(head(false, null)).toMatchObject({ note: '3 matches in 1 file' })
    expect(head(true, null)).toMatchObject({ note: '3 matches+ in 1 file' })
    expect(head(true, closing)).toMatchObject({ note: '3 matches+ in 1 file' })
    expect(head(false, closing)).toMatchObject({ note: '3 matches+ in 1 file · searched 12,401 of 1,032,208 files' })
  })
})

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

describe('Stop', () => {
  type Seen = ReturnType<typeof useFileGrep>
  type Done = (d: GrepDone) => void
  async function searching(text: string, opened?: (cb: { prog: (p: GrepProgress) => void; search: (id: number) => void; done: Done }) => void) {
    const seen: { now: Seen | null } = { now: null }
    const signals: AbortSignal[] = []
    vi.spyOn(api, 'grepFiles').mockImplementation((_c, _t, _f, done, signal, prog, search) => {
      signals.push(signal!)
      opened?.({ prog: prog!, search: search!, done })
      return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted'))))
    })
    function Probe() {
      seen.now = useFileGrep('ws', text)
      return null
    }
    await mount(createElement(Probe))
    return { seen, signals }
  }
  const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))

  test('asks the server to stop and says how many files the stopped search read', async () => {
    let finish: Done = () => undefined
    const stopped = vi.spyOn(api, 'stopGrep').mockImplementation(async () => {
      setTimeout(() => finish(closing), 0)
      return { stopped: true }
    })
    const { seen, signals } = await searching('needle', ({ prog, search, done }) => {
      finish = done
      setTimeout(() => (search(41), prog(progress)), 0)
    })
    await wait(300)
    expect(seen.now!.loading).toBe(true)
    expect(seen.now!.progress).toEqual(progress)
    await act(async () => seen.now!.stop())
    expect(stopped).toHaveBeenCalledWith('ws', 41)
    await wait(20)
    expect(signals[0].aborted).toBe(false)
    expect(seen.now!).toMatchObject({ loading: false, stopped: true, done: closing })
    expect(grepStatus(seen.now!)).toBe('Stopped after 12,401 of 1,032,208 files')
  })

  test('drops the stream when the server cannot be asked', async () => {
    vi.spyOn(api, 'stopGrep').mockRejectedValue(new Error('403'))
    const { seen, signals } = await searching('needle', ({ prog, search }) => setTimeout(() => (search(7), prog(progress)), 0))
    await wait(300)
    await act(async () => seen.now!.stop())
    await wait(20)
    expect(signals[0].aborted).toBe(true)
    expect(seen.now!).toMatchObject({ loading: false, stopped: true, done: null })
    expect(grepStatus(seen.now!)).toBe('Stopped')
  })

  test('that the search outran leaves it finished', async () => {
    let finish: Done = () => undefined
    vi.spyOn(api, 'stopGrep').mockImplementation(async () => {
      setTimeout(() => finish({ ...closing, scanned: closing.of, complete: true }), 0)
      return { stopped: false }
    })
    const { seen } = await searching('needle', ({ search, done }) => {
      finish = done
      setTimeout(() => search(3), 0)
    })
    await wait(300)
    await act(async () => seen.now!.stop())
    await wait(20)
    expect(seen.now!).toMatchObject({ loading: false, stopped: false })
    expect(grepStatus(seen.now!)).toBeNull()
  })

  test('before the search has started leaves nothing waiting', async () => {
    const stopped = vi.spyOn(api, 'stopGrep')
    const { seen, signals } = await searching('needle')
    await act(async () => seen.now!.stop())
    await wait(300)
    expect(signals).toEqual([])
    expect(stopped).not.toHaveBeenCalled()
    expect(seen.now!).toMatchObject({ loading: false, stopped: true })
  })
})
