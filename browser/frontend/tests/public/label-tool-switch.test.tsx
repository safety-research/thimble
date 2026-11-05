// @vitest-environment jsdom
// The Label tool switch, on or off, at the head of the Labels sidebar (src/shell/LabelsSidebar.tsx LabelTool): whether
// Claude makes labels in this workspace, the workspace's `labels` setting. A turn of the switch, or a click on its
// words, applies at once (PUT /ws/{c}/settings, false to turn it off and null to put back the default, on), shows the
// new state while it saves and after, and a save that fails says so and shows what the server holds. It stands on the
// labels' list only: not on a label's detail, and not on the comments.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { bus } from '../../src/lib/bus.ts'
import { LABEL_TOOL, LabelsSidebar } from '../../src/shell/LabelsSidebar.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const LABEL = { id: 'k1', name: 'stage', kind: 'regex', unit: 'line', shown: true, classes: [{ name: 'ingest', color: 1 }], counts: { ingest: 3 }, n_labeled: 3 }

let stored: { labels?: boolean }
let puts: unknown[]
let refuse: boolean

beforeEach(() => {
  stored = {}
  puts = []
  refuse = false
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/settings') && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { labels?: boolean | null }
      puts.push(body)
      if (refuse) return json({ detail: 'the settings file cannot be written' }, 500)
      if (body.labels === null) delete stored.labels
      else if (body.labels === false) stored.labels = false
      return json({ models: {}, ...stored })
    }
    if (u.includes('/settings')) return json({ models: {}, ...stored })
    if (u.includes('/rows')) return json({ rows: [], total: 0 })
    if (u.includes('/concepts')) return json([LABEL])
    if (u.endsWith('/checks')) return json([])
    return json({})
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const head = (el: HTMLElement) => el.querySelector<HTMLElement>('.lside-head')!
const tool = (el: HTMLElement) => head(el).querySelector<HTMLElement>('.lside-tool')
const switchOf = (el: HTMLElement) => tool(el)!.querySelector<HTMLButtonElement>('button[role="switch"]')!

test("the labels' head holds the Label tool, on or off, beside the heading, and a turn applies at once", async () => {
  const el = await mount(<LabelsSidebar ws="w1" section="labels" onClose={() => undefined} />)
  await settle()
  expect(el.querySelector('.lside-heading')?.textContent).toBe('Labels 1')
  expect(LABEL_TOOL).toBe('Label tool')
  expect(tool(el)?.textContent).toBe(LABEL_TOOL)
  expect(switchOf(el).getAttribute('aria-checked')).toBe('true')
  // the switch's words name it
  expect(tool(el)?.tagName).toBe('LABEL')
  // each label keeps its own switch
  expect(el.querySelector('[data-label="k1"] button[role="switch"]')).not.toBeNull()

  await act(async () => switchOf(el).click())
  expect(switchOf(el).getAttribute('aria-checked')).toBe('false')
  await settle()
  expect(puts).toEqual([{ labels: false }])
  expect(stored.labels).toBe(false)
  expect(switchOf(el).getAttribute('aria-checked')).toBe('false')

  // a click on its words turns it too; on puts the default back
  await act(async () => tool(el)!.click())
  await settle()
  expect(puts).toEqual([{ labels: false }, { labels: null }])
  expect(stored.labels).toBeUndefined()
  expect(switchOf(el).getAttribute('aria-checked')).toBe('true')
})

test('a workspace whose labels are off shows the switch off, and a save that fails says so and shows what the server holds', async () => {
  stored = { labels: false }
  const toasts: string[] = []
  const off = bus.on('toast', (t) => toasts.push(t.text))
  try {
    const el = await mount(<LabelsSidebar ws="w2" section="labels" onClose={() => undefined} />)
    await settle()
    expect(switchOf(el).getAttribute('aria-checked')).toBe('false')
    refuse = true
    await act(async () => switchOf(el).click())
    await settle()
    expect(puts).toEqual([{ labels: null }])
    expect(toasts).toEqual(['Could not turn the label tool on. the settings file cannot be written'])
    expect(switchOf(el).getAttribute('aria-checked')).toBe('false')
  } finally {
    off()
  }
})

test("it stands on the labels' list only: not on a label's detail, not on the comments", async () => {
  const el = await mount(<LabelsSidebar ws="w3" section="labels" onClose={() => undefined} />)
  await settle()
  expect(tool(el)).not.toBeNull()
  await act(async () => el.querySelector<HTMLButtonElement>('[data-label="k1"] .lside-name')!.click())
  await settle()
  expect(el.querySelector('.lside-detail')).not.toBeNull()
  expect(tool(el)).toBeNull()
  unmountAll()
  const comments = await mount(<LabelsSidebar ws="w3" section="comments" onClose={() => undefined} />)
  await settle()
  expect(comments.querySelector('.lside-tool')).toBeNull()
})
