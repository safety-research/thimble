// @vitest-environment jsdom
// A run folder's name too long for its row is cut in its middle, its end kept (components/MidCut), so the Files tree's
// `sweep1-fable-emergent_prs` and `sweep1-fable-emergent_prs_issues` stay apart, and the whole name shows in its
// tooltip (bug hunt B16: both read `sweep1-fable-emergent_…` with no tooltip). The label editor's file list cuts its
// paths the same way.
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { keptChars, midSplit } from '../../src/components/MidCut.tsx'
import { Tree, type FolderStore } from '../../src/files/Tree.tsx'
import type { FolderEntry } from '../../src/lib/types.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.useRealTimers()
})

const RUNS = ['sweep1-fable-emergent_prs', 'sweep1-fable-emergent_prs_issues', 'sweep3-sonnet-managed_prs', 'sweep3-sonnet-managed_prs_issues']

describe('a long name is cut in its middle, its end kept', () => {
  test('the end is the last word; a path keeps its folder\'s last word with a short file name; a short name is all end', () => {
    expect(midSplit('sweep1-fable-emergent_prs')).toEqual(['sweep1-fable-emergent', '_prs'])
    expect(midSplit('sweep1-fable-emergent_prs_issues')).toEqual(['sweep1-fable-emergent_prs', '_issues'])
    expect(midSplit('runs/sweep1-fable-emergent_prs_issues/board.jsonl')).toEqual(['runs/sweep1-fable-emergent_prs', '_issues/board.jsonl'])
    expect(midSplit('runs/sweep1-fable-emergent_prs/board.jsonl')).toEqual(['runs/sweep1-fable-emergent', '_prs/board.jsonl'])
    // an extension keeps the word before it
    expect(midSplit('agent-chat-long-session-name.jsonl')).toEqual(['agent-chat-long-session', '-name.jsonl'])
    expect(midSplit('requirements.txt')).toEqual(['', 'requirements.txt'])
  })

  test("the tree's run folders: each name's end stays whole beside the start that gives way, and its tooltip names it whole", async () => {
    vi.useFakeTimers()
    const folders: FolderEntry[] = RUNS.map((name) => ({ path: `runs/${name}`, name, is_run: true }))
    const store: FolderStore = new Map([
      ['', { state: 'ok', listing: { path: '', files: [], folders: [{ path: 'runs', name: 'runs', is_run: false }] } }],
      ['runs', { state: 'ok', listing: { path: 'runs', files: [], folders } }],
    ])
    const el = await mount(<Tree folders={{ store, ensure: () => undefined, reset: () => undefined, refreshChanged: async () => undefined }} error={null} activePath={null} onOpen={() => undefined} />)
    const names = [...el.querySelectorAll('.files-name')]
    const run = (name: string) => names.find((n) => n.textContent === name)!
    for (const name of RUNS) expect(run(name), name).toBeTruthy()
    expect(run('sweep1-fable-emergent_prs').querySelector('.midcut-end')?.textContent).toBe('_prs')
    expect(run('sweep1-fable-emergent_prs_issues').querySelector('.midcut-end')?.textContent).toBe('_issues')
    expect(run('sweep1-fable-emergent_prs_issues').querySelector('.midcut-start')?.textContent).toBe('sweep1-fable-emergent_prs')
    // the whole name in the one tooltip, on a rest of the pointer
    const target = run('sweep3-sonnet-managed_prs_issues') as HTMLElement
    await act(async () => {
      target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
      vi.advanceTimersByTime(1000)
    })
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('sweep3-sonnet-managed_prs_issues')
  })
})

describe('the start keeps the characters that fit with its `…`', () => {
  test('measured in the name\'s font, so the `…` meets the end with no gap; none cut when the whole start fits', () => {
    const width = (s: string) => s.length * 7
    expect(keptChars('sweep1-fable-emergent_prs', 25 * 7, width)).toBeNull()
    // room for 10 characters: 9 of the start and the `…`
    expect(keptChars('sweep1-fable-emergent_prs', 70, width)).toBe(9)
  })
})
