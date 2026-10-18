// @vitest-environment jsdom
// Same-named files under many runs stay apart in the Files search, on the open file's tab and in the status strip:
// each result names its run folder cut in its middle (components/MidCut), and the row, the tab and the strip give the
// whole path on hover (bug hunt G2: 16 `agent-07.jsonl` results read `runs/sweep2-opu…`, and neither they, the tab
// nor the strip had a tooltip).
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { FileSearch } from '../../src/files/FileSearch.tsx'
import { OpenFileStatus, ReaderTabs } from '../../src/files/FilesTab.tsx'
import { api } from '../../src/lib/api.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const RUNS = ['trial3-kestrel-solo_tasks', 'trial3-kestrel-paired_tasks', 'trial3-kestrel-solo_tasks_bugs', 'trial1-heron-paired_tasks']
const PATHS = RUNS.map((run) => `logs/${run}/agents/worker-04.jsonl`)

/** The tooltip after the pointer rests on `el`. */
async function hover(el: Element): Promise<string | null | undefined> {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    vi.advanceTimersByTime(1000)
  })
  return document.querySelector('[role="tooltip"]')?.textContent
}

test('each file the search finds names its run folder, cut in its middle, and its tooltip gives the whole path', async () => {
  vi.useFakeTimers()
  vi.spyOn(api, 'findFiles').mockResolvedValue({ q: 'worker-04', files: PATHS.map((path) => ({ path })) as never, total: PATHS.length })
  vi.spyOn(api, 'grepFiles').mockImplementation(() => new Promise(() => undefined))
  const el = await mount(
    <FileSearch ws="w" inputRef={{ current: null }} onOpen={() => undefined}>
      {null}
    </FileSearch>,
  )
  const field = el.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'worker-04')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    vi.advanceTimersByTime(200)
    await Promise.resolve()
  })
  const rows = [...el.querySelectorAll('.files-found-row[data-anchor]')]
  expect(rows.map((r) => r.querySelector('.files-found-dir')?.textContent)).toEqual(RUNS)
  // the end that tells `…_tasks` from `…_tasks_bugs` stays whole
  expect(rows.map((r) => r.querySelector('.files-found-dir .midcut-end')?.textContent)).toEqual(['_tasks', '_tasks', '_bugs', '_tasks'])
  expect(await hover(rows[1]!)).toBe(PATHS[1])
})

test("the open file's tab and the status strip give its whole path on hover, and the strip shows it", async () => {
  vi.useFakeTimers()
  const el = await mount(<ReaderTabs tabs={[{ path: PATHS[0]! }]} current={PATHS[0]!} onPick={() => undefined} onClose={() => undefined} isDir={() => false} />)
  const tab = el.querySelector('.reader-tabs .reader-tab-pick')!
  expect(tab.textContent).toBe('worker-04.jsonl')
  expect(await hover(tab)).toBe(PATHS[0])
  unmountAll()

  const strip = await mount(<OpenFileStatus path={PATHS[2]!} mode="Transcript" />)
  expect(strip.textContent).toBe(`${PATHS[2]} · Transcript`)
  expect(await hover(strip.querySelector('.pane-status-file')!)).toBe(PATHS[2])
})
