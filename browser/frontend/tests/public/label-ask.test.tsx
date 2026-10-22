// @vitest-environment jsdom
// The ask before a big prompt label's run (src/chat/LabelAsk.tsx): above the chat's composer and in the label's detail,
// what the run reads, with which model, the estimate of its calls, and the three choices, each sent to the server.
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { askChoices, LabelAsks } from '../../src/chat/LabelAsk.tsx'
import { labelApi } from '../../src/lib/api.ts'
import { bus } from '../../src/lib/bus.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const ASK = { id: 'a1', concept: 'k1', name: 'refusals', units: 14591, sample: 300, calls: 292, model: 'claude-opus-5-5', model_words: 'Opus 5.5', text: 'Read 14,591 records of revisions.jsonl with Opus 5.5', meta: 'about 292 model calls' }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('a sample is offered only when it is fewer than all', () => {
  expect(askChoices(ASK).map((c) => c.words)).toEqual(['Run all', 'Run on a sample of 300', 'Cancel'])
  expect(askChoices({ units: 200, sample: 300 }).map((c) => c.choice)).toEqual(['all', 'cancel'])
})

test('the ask shows the count, the model and the estimate, and a choice goes to the server', async () => {
  const sent: { url: string; body: unknown }[] = []
  let waiting = [ASK]
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      sent.push({ url, body: JSON.parse(String(init.body)) })
      waiting = []
      return json({ ok: true })
    }
    return json(waiting)
  })
  const el = await mount(<LabelAsks ws="w1" />)
  await act(async () => new Promise((r) => setTimeout(r, 0)))
  expect(el.textContent).toContain('Label refusals')
  expect(el.textContent).toContain('Read 14,591 records of revisions.jsonl with Opus 5.5?')
  expect(el.textContent).toContain('about 292 model calls')
  const sample = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Run on a sample of 300')!
  await act(async () => sample.click())
  expect(sent).toHaveLength(1)
  expect(sent[0].url).toMatch(/\/label-asks\/a1$/)
  expect(sent[0].body).toEqual({ choice: 'sample' })
  await act(async () => bus.emit('concepts', { concept: 'k1', what: 'answered', rows: false }))
  await act(async () => new Promise((r) => setTimeout(r, 0)))
  expect(el.querySelector('.label-ask')).toBeNull()
})

test("a Run the server answers with an ask starts no run and says the label waits", async () => {
  vi.stubGlobal('fetch', async () => json({ asked: ASK }, 202))
  const toasts: string[] = []
  const off = bus.on('toast', (t) => toasts.push(t.text))
  expect(await labelApi.apply('w1', 'k1', {})).toBeNull()
  expect(toasts).toEqual(['The label refusals waits for your choice: Read 14,591 records of revisions.jsonl with Opus 5.5?'])
  off()
})
