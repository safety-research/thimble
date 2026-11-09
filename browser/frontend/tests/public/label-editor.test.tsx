// @vitest-environment jsdom
// A new label in the label editor (src/files/LabelCard.tsx), which Files' Labels sidebar and the popover a view opens
// both draw: it labels the records of files or the report's sentences, never cards; its name and its prompt typed, Run
// creates the label over the files it applies to, with the two classes a new label starts with, and starts its run.
import { act } from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { LabelCard } from '../../src/files/LabelCard.tsx'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import { mount, settle, unmountAll } from './mount.tsx'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const NO_LABELS = { all: [], on: [], focus: null, byId: new Map(), presence: new Map(), toggle: () => undefined, save: async () => undefined, remove: async () => undefined } as unknown as FilesLabels

/** Type `text` into a field as React hears it. */
async function type(el: HTMLTextAreaElement | HTMLInputElement, text: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('a new label with a name and a prompt: Run creates it over the files it applies to, and starts its run', async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url)
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push({ url: u, body })
      if (u.endsWith('/concepts')) return json({ id: 'k9', ...body })
      if (u.endsWith('/apply')) return json({ id: 'run-1', state: 'running' })
    }
    // what else the editor reads (the models, the files its glob names) is not there
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
  })
  const runs: [string, unknown][] = []
  const closed = vi.fn()
  const el = await mount(<LabelCard ws="w" label={null} labels={NO_LABELS} appliesTo={['transcript.jsonl']} onClose={closed} onRun={(id, run) => runs.push([id, run])} />)
  await settle()
  await type(el.querySelector<HTMLInputElement>('[aria-label="Name"]')!, 'refund asks')
  await type(el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')!, 'Does the customer ask for a refund?')
  await act(async () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Run')!.click())
  await settle()
  expect(posts.map((p) => p.url)).toEqual(['/api/ws/w/concepts', '/api/ws/w/concepts/k9/apply'])
  expect(posts[0].body).toMatchObject({ name: 'refund asks', kind: 'prompt', description: 'Does the customer ask for a refund?', glob: 'transcript.jsonl' })
  expect((posts[0].body.classes as { name: string }[]).map((c) => c.name)).toEqual(['match', 'no match'])
  expect(runs).toEqual([['k9', { id: 'run-1', state: 'running' }]])
  expect(closed).toHaveBeenCalled()
})

test("a new label is over the files or the report's sentences, and never over cards", async () => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }))
  const el = await mount(<LabelCard ws="w" label={null} labels={NO_LABELS} appliesTo={['transcript.jsonl']} onClose={() => undefined} onRun={() => undefined} />)
  await settle()
  const over = [...el.querySelectorAll('[role="radiogroup"][aria-label="Over"] [role="radio"]')]
  expect(over.map((b) => b.textContent)).toEqual(['Files', 'Sentences'])
})
