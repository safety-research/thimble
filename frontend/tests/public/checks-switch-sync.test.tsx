// @vitest-environment jsdom
// One switch for a check in both Comments panes (src/report/Checks.tsx useChecks): the Report and the canvas each hold
// the checks, and a check turned on or off in one reaches the other through the stream's `checks` record (backend
// checks._announce), which makes every pane read the checks again. Live check plan-cards: Important details turned off in
// the Report's pane stayed on in the canvas's, with its comments, until a reload.
import { afterEach, expect, test, vi } from 'vitest'
import { useChecks, type Checks } from '../../src/report/Checks.tsx'
import { checksApi } from '../../src/lib/api.ts'
import { dispatch } from '../../src/lib/events.ts'
import type { Check } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const important = (shown: boolean): Check => ({ id: 'important-details', name: 'Important details', prompt: 'p', colour: 2, shown, builtin: true, covers: ['documents', 'cards'], runs: {} }) as unknown as Check

test("a check turned off in the Report's pane is off in the canvas's pane once the stream says it changed", async () => {
  let server = important(true)
  vi.spyOn(checksApi, 'list').mockImplementation(async () => [server])
  vi.spyOn(checksApi, 'update').mockImplementation(async (_ws, _id, patch) => {
    server = { ...server, shown: !!patch.shown }
    return server
  })
  const got: Record<string, Checks> = {}
  const Pane = ({ name }: { name: string }) => {
    got[name] = useChecks('ws')
    return null
  }
  await mount(
    <>
      <Pane name="report" />
      <Pane name="canvas" />
    </>,
  )
  await settle()
  expect(got.report.on.has('important-details') && got.canvas.on.has('important-details')).toBe(true)

  got.report.toggle('important-details', false)
  await settle()
  expect(got.report.on.has('important-details')).toBe(false)
  expect(got.canvas.on.has('important-details')).toBe(true) // the canvas has heard nothing yet

  dispatch({ type: 'checks', id: 'important-details' })
  await new Promise((r) => setTimeout(r, 200)) // the refetch's debounce
  await settle()
  expect(got.canvas.on.has('important-details')).toBe(false)
})
