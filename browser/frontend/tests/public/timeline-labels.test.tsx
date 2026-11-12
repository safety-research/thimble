// @vitest-environment jsdom
// Files' Timeline mode (src/files/views/timeline.tsx) gives its page the label controls a view's page has (ViewPane):
// checking a label that is off in the page's Color by menu turns it on, through the page's label call during the
// analyst's click in the frame. Without them thimble refused the call, and the click did nothing.
import { afterEach, expect, test, vi } from 'vitest'
import timeline from '../../src/files/views/timeline'
import type { FilesLabels } from '../../src/files/useLabels'
import { api } from '../../src/lib/api'
import type { Concept } from '../../src/lib/types'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

test("the Timeline's Color by turns on a label that is off", async () => {
  vi.spyOn(api, 'timelinePage').mockResolvedValue('<!doctype html><html><head></head><body></body></html>')
  vi.spyOn(api, 'filters').mockResolvedValue({} as never)
  const label = { id: 'k1', name: 'step kind', unit: 'record', kind: 'code', spec: '', labels: ['read', 'edit'], shown: false } as unknown as Concept
  const toggle = vi.fn()
  const labels = { all: [label], on: [], focus: null, setFocus: vi.fn(), byId: new Map([['k1', label]]), presence: new Map(), toggle, setColour: vi.fn() } as unknown as FilesLabels
  const Timeline = timeline.component
  const el = await mount(<Timeline workspace="mini" path="run.jsonl" kind="events" page={null as never} loadMore={() => undefined} labels={labels} />)
  await settle()
  await settle()
  const frame = el.querySelector('iframe')!
  const page = frame.contentWindow!
  const heard: { type: string; [k: string]: unknown }[] = []
  page.addEventListener('message', (e: MessageEvent) => heard.push(e.data))
  const fromPage = (data: object) => window.dispatchEvent(new MessageEvent('message', { data, source: page }))
  // the page is ready and hears the key its label calls carry; then the analyst checks the label in its menu
  fromPage({ type: 'thimble:ready' })
  await settle()
  const key = heard.find((m) => m.type === 'thimble:key')?.key
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } })
  frame.focus()
  fromPage({ type: 'thimble:labelCall', id: 7, key, op: 'on', args: { id: 'k1', on: true } })
  await vi.waitFor(() => expect(heard.find((m) => m.type === 'thimble:labelDone')).toEqual({ type: 'thimble:labelDone', id: 7 }))
  expect(toggle).toHaveBeenCalledWith('k1')
})
