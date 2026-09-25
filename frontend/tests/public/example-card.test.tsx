// @vitest-environment jsdom
// An example card, drawn by the canvas's own CardFace under jsdom on invented records. The address over each quoted
// record is the accent chip with the address in full, the file's extension kept and the passage's block and characters
// left out, and a click opens the ref as written in the File browser, at the passage (or at the record when none is
// quoted) rather than in a view that claims the file. A record quoted without a passage draws whole, with nothing
// highlighted. The labels a card uses are card-labels.test.tsx's.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { CardFace } from '../../src/canvas/CardFace.tsx'
import { CanvasContext, type CanvasCtx } from '../../src/canvas/context.ts'
import { bus } from '../../src/lib/bus.ts'
import type { Cell, Concept } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const POST = 'Please post the next state here. The old page was deleted in the cleanup, so use this one.'
const RESOLVED: Record<string, unknown> = {
  // a passage of one post
  'posts.jsonl#L12.b0:c33-72': { ref: 'posts.jsonl#L12.b0:c33-72', kind: 'span', path: 'posts.jsonl', line: 12, block: 0, start: 33, end: 72, blocks: [{ kind: 'text', text: POST }], excerpt: POST },
  // a whole post, no passage quoted
  'posts.jsonl#L40': { ref: 'posts.jsonl#L40', kind: 'record', path: 'posts.jsonl', line: 40, blocks: [{ kind: 'text', text: 'Thanks, I will poll this page every minute.' }], excerpt: 'Thanks, I will poll this page every minute.' },
}

let opened: { ref: string; browser?: boolean }[] = []
let off: () => void = () => undefined

beforeEach(() => {
  opened = []
  off = bus.on('openRef', (e) => void opened.push(e))
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    const hit = url.pathname.endsWith('/ref') ? RESOLVED[url.searchParams.get('ref') ?? ''] : undefined
    return hit
      ? new Response(JSON.stringify(hit), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  off()
  unmountAll()
  vi.unstubAllGlobals()
})

function ctx(concepts: Concept[] = []): CanvasCtx {
  return {
    ws: 'wiki',
    filters: null,
    keep: null,
    concepts: new Map(concepts.map((k) => [k.id, k])),
    threadOf: () => ({ chatId: null, name: '', writable: false }),
    unread: new Set(),
    refresh: () => undefined,
    openThread: () => undefined,
  }
}

async function face(cell: Cell, concepts: Concept[] = []): Promise<HTMLElement> {
  const el = await mount(
    <CanvasContext.Provider value={ctx(concepts)}>
      <CardFace cell={cell} width={680} label={{ concept: null, error: null, reload: async () => undefined, set: () => undefined }} />
    </CanvasContext.Provider>,
  )
  await settle()
  await settle()
  return el
}

describe('an example card', () => {
  const card = {
    id: 'ex000001', notebook: 'nb1', kind: 'example', title: 'How did the hub answer the deletion?', takeaway: 'It moved to a new page.',
    payload: { refs: ['posts.jsonl#L12.b0:c33-72', 'posts.jsonl#L40'] },
  } as unknown as Cell

  test('each address is the accent chip in full text, and its click opens the ref as written', async () => {
    const el = await face(card)
    const chips = [...el.querySelectorAll<HTMLButtonElement>('.bcell-address')]
    expect(chips.map((c) => c.textContent)).toEqual(['posts.jsonl L12', 'posts.jsonl L40'])
    for (const c of chips) {
      expect(c.classList.contains('chip')).toBe(true)
      expect(c.classList.contains('chip-tone-accent')).toBe(true)
      expect(c.querySelector('svg.chip-ico')).not.toBeNull()
    }
    await act(async () => chips[0].click())
    await act(async () => chips[1].click())
    // in the File browser, where the passage is highlighted, whatever view claims the file
    expect(opened).toEqual([{ ref: 'posts.jsonl#L12.b0:c33-72', browser: true }, { ref: 'posts.jsonl#L40', browser: true }])
  })

  test('a quoted passage is highlighted, and a record quoted without one draws whole with nothing highlighted', async () => {
    const el = await face(card)
    const [first, second] = [...el.querySelectorAll('.bcell-quote-rec')]
    expect(first.querySelector('.hl')?.textContent).toBe('The old page was deleted in the cleanup')
    expect(second.querySelector('.hl')).toBeNull()
    expect(second.textContent).toContain('Thanks, I will poll this page every minute.')
  })
})
