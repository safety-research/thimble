// @vitest-environment jsdom
// A ref that names a folder opens it in the File browser (src/files/FolderPane.tsx): its folders, then its files, each
// with its size or how many files it holds, and a row opens its file or folder.
import { act } from 'react'
import { afterEach, beforeAll, expect, test } from 'vitest'
import { FolderPane } from '../../src/files/FolderPane.tsx'
import type { FolderState } from '../../src/files/Tree.tsx'
import type { SourceInfo } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(() => unmountAll())

const file = (path: string, size_bytes: number) => ({ path, size_bytes, kind: 'text' }) as unknown as SourceInfo
const STATE: FolderState = {
  state: 'ok',
  listing: {
    path: 'images/day',
    folders: [
      { path: 'images/day/b', name: 'b', n_files: 1, is_run: false },
      { path: 'images/day/a', name: 'a', is_run: false },
    ],
    files: [file('images/day/shot-10.png', 2048), file('images/day/shot-2.png', 10)],
  },
}

test('a folder opened in the File browser lists its folders, then its files, and a row opens its folder or file', async () => {
  const opened: string[] = []
  const el = await mount(<FolderPane state={STATE} lead={null} onOpen={(p) => opened.push(p)} />)
  const rows = [...el.querySelectorAll<HTMLElement>('.folder-pane-row')]
  expect(rows.map((r) => r.textContent)).toEqual(['a', 'b1 file', 'shot-2.png10 B', 'shot-10.png2.0 KB'])
  await act(async () => {
    rows[0].click()
    rows[3].click()
  })
  expect(opened).toEqual(['images/day/a', 'images/day/shot-10.png'])
})
