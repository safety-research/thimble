// @vitest-environment jsdom
// The Files search's text half has no time limit (src/files/FileSearch.tsx): while it reads, a row says how many
// files it has read, and the analyst's Stop keeps what it found, with its count marked as a floor (find.ts resultRows).
import { act, createElement } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { grepStatus, useFileGrep } from '../../src/files/FileSearch.tsx'
import { api } from '../../src/lib/api.ts'
import { mount, unmountAll } from './mount.tsx'
import { resultRows } from '../../src/files/find.ts'
import type { GrepFile } from '../../src/lib/types.ts'

const progress = { progress: true as const, scanned: 12345, of: 1032208 }
const file: GrepFile = { path: 'a.jsonl', total: 3, complete: true, matches: [{ line: 4, text: 'the hit', hit: [4, 7] }] }

describe('the text search', () => {
  test('says how many files it has read while it runs, and where it was stopped', () => {
    expect(grepStatus({ loading: true, stopped: false, progress: null })).toBeNull()
    expect(grepStatus({ loading: true, stopped: false, progress: { ...progress, scanned: 0 } })).toBe('Searching 1,032,208 files')
    expect(grepStatus({ loading: true, stopped: false, progress })).toBe('Searched 12,345 of 1,032,208 files')
    expect(grepStatus({ loading: false, stopped: true, progress })).toBe('Stopped after 12,345 of 1,032,208 files')
    expect(grepStatus({ loading: false, stopped: false, progress })).toBeNull()
  })

  test('marks its count as a floor once stopped', () => {
    const head = (stopped: boolean) => resultRows(null, { files: [file], done: null, stopped }, false).find((r) => r.kind === 'head')
    expect(head(false)).toMatchObject({ note: '3 matches in 1 file' })
    expect(head(true)).toMatchObject({ note: '3 matches+ in 1 file' })
  })
})

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

describe('Stop', () => {
  type Seen = ReturnType<typeof useFileGrep>
  async function searching(text: string, onProgress?: (cb: (p: typeof progress) => void) => void) {
    const seen: { now: Seen | null } = { now: null }
    const signals: AbortSignal[] = []
    vi.spyOn(api, 'grepFiles').mockImplementation((_c, _t, _f, _d, signal, prog) => {
      signals.push(signal!)
      onProgress?.(prog!)
      return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted'))))
    })
    function Probe() {
      seen.now = useFileGrep('ws', text)
      return null
    }
    await mount(createElement(Probe))
    return { seen, signals }
  }

  test('ends the search and keeps how far it read', async () => {
    const { seen, signals } = await searching('needle', (cb) => setTimeout(() => cb(progress), 0))
    await act(async () => void (await new Promise((r) => setTimeout(r, 300))))
    expect(seen.now!.loading).toBe(true)
    expect(seen.now!.progress).toEqual(progress)
    await act(async () => seen.now!.stop())
    expect(signals[0].aborted).toBe(true)
    expect(seen.now!).toMatchObject({ loading: false, stopped: true, progress })
  })

  test('before the search has started leaves nothing waiting', async () => {
    const { seen, signals } = await searching('needle')
    await act(async () => seen.now!.stop())
    await act(async () => void (await new Promise((r) => setTimeout(r, 300))))
    expect(signals).toEqual([])
    expect(seen.now!).toMatchObject({ loading: false, stopped: true })
  })
})
