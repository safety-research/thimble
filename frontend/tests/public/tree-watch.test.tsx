// @vitest-environment jsdom
// The Files tree lists a folder again when it changed on disk (src/files/Tree.tsx): it asks for the stamps of the
// folders it shows and fetches only those whose stamp is not their listing's, keeping the old rows meanwhile.
import { act, useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { shownFolders, useFolderStore, useFolderWatch, type FolderStoreHandle } from '../../src/files/Tree.tsx'
import { scaleApi } from '../../src/lib/api.ts'
import type { FolderListing } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const listing = (path: string, files: string[], stamp: string): FolderListing => ({
  path,
  files: files.map((f) => ({ path: f, kind: 'text', size_bytes: 1, title: f }) as FolderListing['files'][number]),
  folders: [],
  stamp,
})

describe('the tree lists a folder again', () => {
  test('only when its stamp on disk changed, and keeps its rows until the new listing arrives', async () => {
    const disk: Record<string, FolderListing> = { '': listing('', ['README.md'], '1'), runs: listing('runs', ['runs/a.jsonl'], '7') }
    const folder = vi.spyOn(scaleApi, 'folder').mockImplementation(async (_c, p) => disk[p])
    const stamps = vi.spyOn(scaleApi, 'stamps').mockImplementation(async (_c, ps) => ({ stamps: Object.fromEntries(ps.map((p) => [p, disk[p]?.stamp ?? null])) }))
    let handle: FolderStoreHandle | null = null
    function Probe() {
      handle = useFolderStore('ws')
      return null
    }
    await mount(<Probe />)
    await act(async () => {
      handle!.ensure('')
      handle!.ensure('runs')
    })
    await settle()
    expect(folder).toHaveBeenCalledTimes(2)
    await act(() => handle!.refreshChanged(['', 'runs']))
    expect(folder).toHaveBeenCalledTimes(2)
    disk[''] = listing('', ['NOTES.md', 'README.md'], '2')
    await act(() => handle!.refreshChanged(['', 'runs']))
    await settle()
    expect(stamps).toHaveBeenLastCalledWith('ws', ['', 'runs'])
    expect(folder).toHaveBeenCalledTimes(3)
    expect(folder).toHaveBeenLastCalledWith('ws', '')
    const root = handle!.store.get('')
    expect(root?.state === 'ok' && root.listing.files.map((f) => f.path)).toEqual(['NOTES.md', 'README.md'])
  })

  test('for the folders it shows, on a timer and at once when a folder opens', async () => {
    vi.useFakeTimers()
    expect(shownFolders(new Set(['runs', 'runs/r1', 'docs/old']))).toEqual(['', 'runs', 'runs/r1'])
    const seen: string[][] = []
    const check = async (paths: readonly string[]) => {
      seen.push([...paths])
    }
    let open: (paths: string[]) => void = () => undefined
    function Probe() {
      const [paths, setPaths] = useState([''])
      open = setPaths
      useFolderWatch(check, paths, () => true, 1000)
      return null
    }
    await mount(<Probe />)
    expect(seen).toEqual([['']])
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(seen).toEqual([[''], ['']])
    await act(async () => open(['', 'runs']))
    expect(seen.at(-1)).toEqual(['', 'runs'])
    expect(seen.length).toBe(3)
  })
})
