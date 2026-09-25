// @vitest-environment jsdom
// The labels a card uses, drawn by the canvas's own CardFace under jsdom on invented labels: a row under the card's
// question, "Labels:" and then a tag per label, the label glyph and its name, in the label's colour when it has one (a
// label over files), and neither the accent chip of a link nor the neutral chip. A click opens the label's edit card in
// a popover (files/LabelCard LabelSheet): the fields of its edit card in Files, each class's count, Open in Files, which
// asks Files for the label's edit card, and Review records, which opens the label's per-record review on the canvas. An
// edit there turns the tag red on every card that uses the label, and the popover and the row offer Regenerate Card,
// which saves the edit and asks the server to run the card again; Discard drops it. A label the board's list does not
// hold yet opens its card on the canvas instead. A label that changed since the card ran turns its tag red, its hover
// saying what changed, and the card offers Regenerate Card too.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { CardFace } from '../../src/canvas/CardFace.tsx'
import { changedSince, staleLabels } from '../../src/canvas/concepts.ts'
import { CanvasContext, type CanvasCtx } from '../../src/canvas/context.ts'
import { setLabelDraft } from '../../src/canvas/labelDrafts.ts'
import { bus, type Events } from '../../src/lib/bus.ts'
import type { Cell, Concept } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

let seen: [keyof Events, unknown][] = []
let offs: (() => void)[] = []
let posted: string[] = []
let puts: { url: string; body: Record<string, unknown> }[] = []

beforeEach(() => {
  seen = []
  offs = (['openRef', 'showTab', 'editLabel'] as const).map((k) => bus.on(k, (e) => void seen.push([k, e])))
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  posted = []
  puts = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posted.push(String(url))
    if (init?.method === 'PUT') {
      puts.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify(saves), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (String(url).endsWith('/regenerate')) return new Response('{"id":"pl000001"}', { status: 200, headers: { 'content-type': 'application/json' } })
    if (String(url).endsWith('/settings')) return new Response('{"models":{"labels":{"model":"claude-haiku-4-5"}}}', { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  for (const off of offs) off()
  unmountAll()
  setLabelDraft('wiki', 'k1', null)
  vi.unstubAllGlobals()
})

/** An invented label over files (`record`) with its colour, or over cards (`cell`), which has none on the card. */
const concept = (id: string, name: string, unit: Concept['unit'], color: number, extra: Partial<Concept> = {}): Concept =>
  ({
    id, name, unit, description: '', kind: 'regex', spec: 'deleted|moved', labels: ['yes', 'no'], created_by: 'model', ts: '',
    classes: [{ name: 'yes', color, highlight: true }, { name: 'no', color: 0, highlight: false }], ...extra,
  }) as Concept

const saves = concept('k1', 'kind of save', 'record', 3, {
  marks: 'record', glob: 'posts.jsonl', counts: { yes: 12, no: 30 },
  last_run: { ts: '2026-06-18T13:54:00Z', paths: ['posts.jsonl'], total: 42, labeled: 42, failed: 0, status: 'done', matches: 12 },
})
const hedged = concept('k2', 'hedged card', 'cell', 2)

function ctx(concepts: Concept[]): CanvasCtx {
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

async function face(cell: Cell, concepts: Concept[]): Promise<HTMLElement> {
  const el = await mount(
    <CanvasContext.Provider value={ctx(concepts)}>
      <CardFace cell={cell} width={680} label={{ concept: null, error: null, reload: async () => undefined, set: () => undefined }} />
    </CanvasContext.Provider>,
  )
  await settle()
  return el
}

const plot = (labels: string[]) =>
  ({ id: 'pl000001', notebook: 'nb1', kind: 'plot', title: 'When did agents save pages?', takeaway: 'Mostly in March.', labels, outputs: [] }) as unknown as Cell

const tagsOf = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.bcell-labels .bcell-tag')]
const sheetButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.label-sheet .label-card-foot button')].map((b) => b.textContent)

/** Type `text` into a field as the analyst would, through React's onChange. */
async function type(field: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** The text of the tooltip a hover on `el` shows. */
async function hoverTip(el: HTMLElement): Promise<string | null | undefined> {
  vi.useFakeTimers()
  try {
    await act(async () => void el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })))
    await act(async () => void el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, pointerType: 'mouse' })))
    await act(async () => void vi.advanceTimersByTime(1000))
  } finally {
    vi.useRealTimers()
  }
  return document.querySelector('.tip')?.textContent
}

describe('the labels a card uses', () => {
  test('are a row under its question: "Labels:", then a tag per label with the label glyph, in its colour for a label over files', async () => {
    const el = await face(plot(['k1', 'k2']), [saves, hedged])
    const article = el.querySelector('article.canvas-card')!
    const order = [...article.children].map((c) => c.className)
    expect(order.indexOf('bcell-labels')).toBe(order.indexOf('bcell-head') + 1)
    expect(order.indexOf('bcell-labels')).toBeLessThan(order.indexOf('bcell-body'))
    expect(el.querySelector('.bcell-labels')!.firstElementChild!.textContent).toBe('Labels:')
    const tags = tagsOf(el)
    expect(tags.map((t) => t.textContent)).toEqual(['kind of save', 'hedged card'])
    for (const t of tags) {
      expect(t.querySelector('svg.bcell-tag-icon')).not.toBeNull()
      expect(t.classList.contains('chip'), 'a label is no link: neither chip').toBe(false)
    }
    expect(tags[0].style.getPropertyValue('--c')).toBe('var(--label-3)')
    expect(tags[0].classList.contains('is-plain')).toBe(false)
    // a label over cards has no colour of its own on the card
    expect(tags[1].style.getPropertyValue('--c')).toBe('')
    expect(tags[1].classList.contains('is-plain')).toBe(true)
  })

  test('a multi-class label over files has no colour of its own on the card', async () => {
    const purpose = concept('k3', 'edit purpose', 'record', 1, {
      marks: 'record',
      classes: [{ name: 'question', color: 1, highlight: true }, { name: 'notice', color: 2, highlight: true }, { name: 'other', color: 0, highlight: false }],
    })
    const [tag] = tagsOf(await face(plot(['k3']), [purpose]))
    expect(tag.style.getPropertyValue('--c')).toBe('')
    expect(tag.classList.contains('is-plain')).toBe(true)
  })

  test("a click opens the label's edit card in a popover, and Open in Files asks Files for its edit card", async () => {
    const el = await face(plot(['k1']), [saves])
    const [tag] = tagsOf(el)
    await act(async () => tag.click())
    const sheet = document.querySelector<HTMLElement>('.label-sheet')!
    expect(sheet, 'the popover shows the label').not.toBeNull()
    expect(tag.getAttribute('aria-expanded')).toBe('true')
    expect(seen, 'no jump to the label card').toEqual([])
    // its name as text, the last run's units and time, and the fields of the edit card in Files
    expect(sheet.querySelector('.label-sheet-name')?.textContent).toBe('kind of save')
    expect(sheet.querySelector('input[aria-label="Name"]'), 'the name stays: the card finds the label by it').toBeNull()
    expect(sheet.querySelector('.label-card-head')?.textContent).toContain('42 records')
    expect(sheet.querySelector<HTMLInputElement>('input[aria-label="Applies to"]')?.value).toBe('posts.jsonl')
    expect(sheet.querySelector<HTMLTextAreaElement>('textarea[aria-label="Pattern"]')?.value).toBe('deleted|moved')
    const checked = [...sheet.querySelectorAll('[role="radio"][aria-checked="true"]')].map((r) => r.textContent)
    expect(checked).toEqual(['Files', 'Record', 'Regex'])
    const classes = [...sheet.querySelectorAll('.label-card-class')].map((r) => [r.querySelector('input')?.value, r.querySelector('.label-sheet-count')?.textContent])
    expect(classes).toEqual([['yes', '12'], ['no', '30']])
    expect(sheet.querySelectorAll('[role="switch"]').length).toBe(2)
    // no edit yet: the foot links to the review and to Files, and offers no Regenerate Card
    expect(sheetButtons()).toEqual(['Review records', 'Open in Files'])
    const open = [...sheet.querySelectorAll('button')].find((b) => b.textContent === 'Open in Files')!
    await act(async () => open.click())
    expect(seen).toEqual([['showTab', { tab: 'files' }], ['editLabel', { id: 'k1' }]])
    expect(document.querySelector('.label-sheet'), 'the popover closes').toBeNull()
  })

  test('an edit turns the tag red on every card that uses the label, offers Regenerate Card, outlasts the popover, and Discard drops it', async () => {
    const el = await face(plot(['k1', 'k2']), [saves, hedged])
    const second = await face({ ...plot(['k1']), id: 'pl000002' } as Cell, [saves])
    const [tag, other] = tagsOf(el)
    await act(async () => tag.click())
    await type(document.querySelector<HTMLTextAreaElement>('.label-sheet textarea[aria-label="Pattern"]')!, 'deleted|moved|merged')
    expect(tag.classList.contains('is-stale')).toBe(true)
    expect(other.classList.contains('is-stale'), 'a label with no edits stays as it was').toBe(false)
    expect(tagsOf(second)[0].classList.contains('is-stale'), 'the same label on another card').toBe(true)
    expect(sheetButtons()).toEqual(['Discard', 'Regenerate Card'])
    expect(el.querySelector('.bcell-labels .bcell-regen')?.textContent).toBe('Regenerate Card')
    // closed, the popover keeps the edit: the tag stays red, says what was edited, and the edit is there on reopening
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('.label-sheet')).toBeNull()
    expect(tag.classList.contains('is-stale')).toBe(true)
    expect(await hoverTip(tag)).toBe('Edited, not run yet: its pattern')
    await act(async () => tag.click())
    expect(document.querySelector<HTMLTextAreaElement>('.label-sheet textarea[aria-label="Pattern"]')?.value).toBe('deleted|moved|merged')
    const discard = [...document.querySelectorAll<HTMLButtonElement>('.label-sheet button')].find((b) => b.textContent === 'Discard')!
    await act(async () => discard.click())
    expect(tag.classList.contains('is-stale')).toBe(false)
    expect(el.querySelector('.bcell-regen')).toBeNull()
    expect(document.querySelector<HTMLTextAreaElement>('.label-sheet textarea[aria-label="Pattern"]')?.value).toBe('deleted|moved')
    expect(puts, 'nothing was saved').toEqual([])
  })

  test('typing an edit back to what the label says is no edit, and a class with no name yet is none either', async () => {
    const el = await face(plot(['k1']), [saves])
    const [tag] = tagsOf(el)
    await act(async () => tag.click())
    const pattern = document.querySelector<HTMLTextAreaElement>('.label-sheet textarea[aria-label="Pattern"]')!
    await type(pattern, 'deleted')
    expect(tag.classList.contains('is-stale')).toBe(true)
    await type(pattern, 'deleted|moved')
    expect(tag.classList.contains('is-stale')).toBe(false)
    const add = [...document.querySelectorAll<HTMLButtonElement>('.label-sheet button')].find((b) => b.textContent === 'class')!
    await act(async () => add.click())
    expect(document.querySelectorAll('.label-sheet .label-card-class').length, 'the new class row stays').toBe(3)
    expect(tag.classList.contains('is-stale')).toBe(false)
    await type(document.querySelectorAll<HTMLInputElement>('.label-sheet .label-card-class input')[2], 'merge')
    expect(tag.classList.contains('is-stale')).toBe(true)
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(await hoverTip(tag), 'the hover shows once the popover is closed').toBe('Edited, not run yet: its values now yes, no, merge')
  })

  test('a model picked from the menu in the popover keeps the edits made before it', async () => {
    const el = await face(plot(['k1']), [saves])
    const [tag] = tagsOf(el)
    await act(async () => tag.click())
    await settle()
    const prompt = [...document.querySelectorAll<HTMLElement>('.label-sheet [role="radio"]')].find((r) => r.textContent === 'Prompt')!
    await act(async () => prompt.click())
    await act(async () => document.querySelector<HTMLButtonElement>('.label-sheet .label-card-model')!.click())
    const item = document.querySelector<HTMLButtonElement>('.menu .menu-item[data-item="claude-opus-5-5"]')!
    await act(async () => item.click())
    expect(document.querySelector('.label-sheet'), 'the popover stays open').not.toBeNull()
    expect(document.querySelector('.label-sheet .label-card-model')?.textContent).toContain('Opus 5.5')
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(await hoverTip(tag)).toBe('Edited, not run yet: its classifier now Prompt; its model')
  })

  test("Regenerate Card in the popover saves the label's edits, then asks the server to run the card again", async () => {
    const el = await face(plot(['k1']), [saves])
    const [tag] = tagsOf(el)
    await act(async () => tag.click())
    await type(document.querySelectorAll<HTMLInputElement>('.label-sheet .label-card-class input')[0], 'save')
    const regen = [...document.querySelectorAll<HTMLButtonElement>('.label-sheet button')].find((b) => b.textContent === 'Regenerate Card')!
    await act(async () => regen.click())
    await settle()
    expect(puts.map((x) => x.url)).toEqual(['/api/ws/wiki/concepts/k1'])
    expect(puts[0].body).toMatchObject({ marks: 'record', glob: 'posts.jsonl', kind: 'regex', spec: 'deleted|moved', classes: [{ name: 'save', color: 3, highlight: true }, { name: 'no', color: 0, highlight: false }] })
    expect(posted).toEqual(['/api/ws/wiki/cells/pl000001/regenerate'])
    expect(tag.classList.contains('is-stale'), 'the edits were saved, so none is left').toBe(false)
  })

  test('an edit that cannot run is not saved, and says why', async () => {
    const toasts: unknown[] = []
    offs.push(bus.on('toast', (t) => void toasts.push(t)))
    const el = await face(plot(['k1']), [saves])
    await act(async () => tagsOf(el)[0].click())
    await type(document.querySelector<HTMLTextAreaElement>('.label-sheet textarea[aria-label="Pattern"]')!, '')
    const regen = el.querySelector<HTMLButtonElement>('.bcell-labels .bcell-regen')!
    await act(async () => regen.click())
    await settle()
    expect(toasts).toEqual([{ text: 'kind of save: The classifier is empty.', kind: 'error' }])
    expect(puts).toEqual([])
    expect(posted).toEqual([])
  })

  test('Escape closes the popover, and a label the board does not hold yet opens its card on the canvas', async () => {
    const el = await face(plot(['k1', 'k9']), [saves])
    const [tag, unknown] = tagsOf(el)
    await act(async () => tag.click())
    expect(document.querySelector('.label-sheet')).not.toBeNull()
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('.label-sheet')).toBeNull()
    await act(async () => unknown.click())
    expect(document.querySelector('.label-sheet')).toBeNull()
    expect(seen).toEqual([['showTab', { tab: 'canvas' }], ['openRef', { ref: 'concept:k9' }]])
  })
})

/** k1 as it stands after a run, three corrections and a redefinition since revision 1 (backend concepts.note_change). */
const changed = {
  ...saves,
  rev: 5,
  changes: [
    { what: 'ran', first: 1, rev: 1, text: 'run over 42 records', ts: '' },
    { what: 'corrected', first: 2, rev: 4, text: '', ts: '' },
    { what: 'redefined', first: 5, rev: 5, text: 'redefined, its values now save, move, other', ts: '' },
  ],
} as Concept

describe('a label that changed since the card ran', () => {
  test('says what changed after the revision the card read, a run of corrections as how many since', () => {
    expect(changedSince(changed, 5)).toBe('')
    expect(changedSince(changed, 1)).toBe('3 values corrected; redefined, its values now save, move, other')
    expect(changedSince(changed, 3)).toBe('1 value corrected; redefined, its values now save, move, other')
    expect(changedSince({ ...changed, changes: changed.changes!.slice(2) }, 1)).toBe('earlier changes; redefined, its values now save, move, other')
    const concepts = new Map([['k1', changed]])
    expect([...staleLabels({ label_revs: { k1: 1 } }, concepts)]).toEqual([['k1', '3 values corrected; redefined, its values now save, move, other']])
    // a card that read the label as it is, a card from before revisions were kept and a label that is gone are current
    expect(staleLabels({ label_revs: { k1: 5 } }, concepts).size).toBe(0)
    expect(staleLabels({}, concepts).size).toBe(0)
    expect(staleLabels({ label_revs: { k9: 0 } }, concepts).size).toBe(0)
  })

  test('turns its tag red with what changed on hover, and Regenerate Card asks the server to run the card again', async () => {
    const el = await face({ ...plot(['k1', 'k2']), label_revs: { k1: 1, k2: 0 } }, [changed, hedged])
    const [tag, other] = tagsOf(el)
    expect(tag.classList.contains('is-stale')).toBe(true)
    expect(other.classList.contains('is-stale'), 'a label that did not change stays as it was').toBe(false)
    expect(await hoverTip(tag)).toBe('Changed since this card ran: 3 values corrected; redefined, its values now save, move, other')
    // the popover of a stale label offers it too, beside its links
    await act(async () => tag.click())
    expect(sheetButtons()).toEqual(['Review records', 'Open in Files', 'Regenerate Card'])
    const regen = el.querySelector<HTMLButtonElement>('.bcell-labels .bcell-regen')!
    expect(regen.textContent).toBe('Regenerate Card')
    await act(async () => regen.click())
    await settle()
    expect(puts, 'no edit to save').toEqual([])
    expect(posted).toEqual(['/api/ws/wiki/cells/pl000001/regenerate'])
  })

  test('a card that read the label as it is shows no red tag and no Regenerate', async () => {
    const el = await face({ ...plot(['k1']), label_revs: { k1: 5 } }, [changed])
    expect(tagsOf(el)[0].classList.contains('is-stale')).toBe(false)
    expect(el.querySelector('.bcell-regen')).toBeNull()
  })

  test("Review records in the label's popover opens its review on the canvas", async () => {
    const el = await face(plot(['k1']), [saves])
    await act(async () => tagsOf(el)[0].click())
    const review = [...document.querySelectorAll<HTMLButtonElement>('.label-sheet button')].find((b) => b.textContent === 'Review records')!
    await act(async () => review.click())
    expect(seen).toEqual([['showTab', { tab: 'canvas' }], ['openRef', { ref: 'concept:k1' }]])
    expect(document.querySelector('.label-sheet'), 'the popover closes').toBeNull()
  })
})
