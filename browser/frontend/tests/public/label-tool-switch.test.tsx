// @vitest-environment jsdom
// The Label tool switch, on or off, at the head of the Labels sidebar (src/shell/LabelsSidebar.tsx LabelTool): whether
// Claude makes labels in this workspace, the workspace's `labels` setting. A turn of the switch, or a click on its
// words, applies at once (PUT /ws/{c}/settings, false to turn it off and null to put back the default, on), and shows
// the new state while it saves and after.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { LABEL_TOOL, LabelsSidebar } from '../../src/shell/LabelsSidebar.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const LABEL = { id: 'k1', name: 'stage', kind: 'regex', unit: 'record', shown: true, classes: [{ name: 'ingest', color: 1 }], counts: { ingest: 3 }, n_labeled: 3 }

let stored: { labels?: boolean }
let puts: unknown[]

beforeEach(() => {
  stored = {}
  puts = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/settings') && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { labels?: boolean | null }
      puts.push(body)
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
  // a label over files keeps its own switch
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
