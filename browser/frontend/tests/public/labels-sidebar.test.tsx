// @vitest-environment jsdom
// A label in the Labels sidebar (src/shell/LabelsSidebar.tsx). What a label reads decides where its values are, so its
// row and its detail have no Show in. Its switch turns it on or off in Files, so a label over files keeps it, and Turn
// off in its detail; a label over report sentences has neither, is never dimmed as off, and keeps the rest.
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { LabelsSidebar } from '../../src/shell/LabelsSidebar.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
/** A model label, off in Files, with two of its units for each value. */
const label = (id: string, name: string, unit: string, values: string[]) => ({
  id, name, unit, kind: 'prompt', description: `Which ${name}?`, spec: '', labels: values, glob: unit === 'record' ? 'runs/*.jsonl' : '', shown: false,
  classes: values.map((v, i) => ({ name: v, color: i + 1, highlight: true })), counts: Object.fromEntries(values.map((v) => [v, 2])), n_labeled: 2 * values.length,
})
// over records and over report sentences
const LABELS = [label('k1', 'stage', 'record', ['ingest', 'other']), label('k3', 'hedged', 'span', ['hedged', 'other'])]

let puts: { url: string; body: unknown }[]

beforeEach(() => {
  puts = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (init?.method === 'PUT') {
      puts.push({ url: u, body: JSON.parse(String(init.body)) })
      return json({})
    }
    if (u.includes('/settings')) return json({ models: {} })
    if (u.includes('/rows')) return json({ rows: [], total: 0 })
    if (u.includes('/concepts')) return json(LABELS)
    if (u.endsWith('/checks')) return json([])
    return json({})
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const row = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`.lside-row[data-label="${id}"]`)!
const switchIn = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('button[role="switch"]')
const words = (el: HTMLElement, sel: string) => [...el.querySelectorAll(sel)].map((b) => b.textContent)

test('no label has Show in; only the label over files has a switch, and only it shows as off', async () => {
  const el = await mount(<LabelsSidebar ws="w1" section="labels" onClose={() => undefined} />)
  await settle()
  expect(words(el, '.lside-row .lside-name')).toEqual(['stage', 'hedged'])
  for (const id of ['k1', 'k3']) {
    expect(row(el, id).querySelector('.lside-showin')).toBeNull()
    expect(row(el, id).textContent).not.toContain('Show in')
    // the values stay
    expect(row(el, id).querySelectorAll('.lside-value')).toHaveLength(2)
  }
  expect(switchIn(row(el, 'k1'))).not.toBeNull()
  expect(switchIn(row(el, 'k3'))).toBeNull()
  // each is off in Files, which only the label over files shows
  expect(row(el, 'k1').classList.contains('is-off')).toBe(true)
  expect(row(el, 'k3').classList.contains('is-off')).toBe(false)

  // the switch of the label over files turns it on in Files, as before
  await act(async () => switchIn(row(el, 'k1'))!.click())
  await settle()
  expect(puts).toEqual([{ url: '/api/ws/w1/concepts/k1', body: { shown: true } }])
})

test("a label's detail has no Show in, and only a label over files has its switch and Turn on or off", async () => {
  const el = await mount(<LabelsSidebar ws="w1" section="labels" onClose={() => undefined} />)
  await settle()
  const open = async (id: string) => {
    await act(async () => row(el, id).querySelector<HTMLButtonElement>('.lside-name')!.click())
    await settle()
    return el.querySelector<HTMLElement>(`.lside-detail[data-label="${id}"]`)!
  }
  const back = () => act(async () => el.querySelector<HTMLButtonElement>('.lside-back')!.click())

  const files = await open('k1')
  expect(words(files, '.lside-label')).not.toContain('Show in')
  expect(files.querySelector('.lside-showin')).toBeNull()
  expect(switchIn(files)).not.toBeNull()
  expect(words(files, '.lside-foot button')).toEqual(['Run again', 'Color Files by it', 'Turn on', 'Delete'])
  await back()

  for (const id of ['k3']) {
    const d = await open(id)
    expect(words(d, '.lside-label')).not.toContain('Show in')
    expect(d.querySelector('.lside-showin')).toBeNull()
    expect(switchIn(d)).toBeNull()
    expect(words(d, '.lside-foot button')).toEqual(['Run again', 'Delete'])
    // Edit, the definition and the values stay
    expect(words(d, '.lside-reads button')).toEqual(['Edit'])
    expect(d.querySelector<HTMLTextAreaElement>('textarea.lside-ask')?.value).toBe('Which hedged?')
    expect(d.querySelector('.lside-reads .mono')?.textContent).toBe('the report')
    expect(d.querySelectorAll('.lside-value')).toHaveLength(2)
    await back()
  }
  expect(puts).toEqual([])
})
