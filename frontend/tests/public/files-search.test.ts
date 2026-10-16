// @vitest-environment jsdom
// The Files search's text half has no time limit (src/files/FileSearch.tsx): while it reads, a row says how many
// files it has read, and the analyst's Stop keeps what it found, with its count marked as a floor (find.ts resultRows)
// and the number of files read taken from the stopped search's closing line.
import { act, createElement } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { grepStatus, useFileGrep } from '../../src/files/FileSearch.tsx'
import { api } from '../../src/lib/api.ts'
import { mount, unmountAll } from './mount.tsx'
import type { GrepDone, GrepProgress } from '../../src/lib/types.ts'

const progress = { progress: true as const, scanned: 12345, of: 1032208 }
const closing: GrepDone = { done: true, files: 1, hits: 3, scanned: 12401, of: 1032208, complete: false }

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
})
