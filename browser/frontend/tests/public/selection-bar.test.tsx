// @vitest-environment jsdom
// The toolbar at a selection in an answer (src/chat/picked.tsx): words selected in an answer of main's chat show a
// toolbar with Explain and Cite, in that order, and no Ask; words selected anywhere else show none. Explain writes
// their explainer: the words are tinted while it is written, and its card opens beside them at once, a spinner where
// its text will stand, which the written text takes in the same card. Closed before that, the card does not open
// again by itself, and the words then open it as any explainer's do; words an explainer stands on open it at once. A
// failure says why in the card, or in a toast once the card is closed. Cite makes them a
// citation of the answer, which the chat draws as a mark with its label open, checking. The letters c, e and a do
// nothing at the selection, and asking stays with the ⌘ pointer: a ⌘-click on the answer opens the ask box, whose
// question starts a side thread about it. Escape drops the selection, and with Explainers off for the chat Explain is
// not shown. The toolbar stands just above the words, centered on where they end, else under them, inside the window.
// After a click with the pointer it keeps its place, unseen and with no buttons, until the pointer moves, presses or
// turns the wheel; a move with no movement keeps it, and a click from the keyboard takes it away at once.
// A side thread's answers draw the explainers asked for there. Explain and Cite act on the words where they were
// selected: in the answer, not in a line of the turn before it that holds them too, and at their second place in one
// sentence.
import { act, useState } from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { chatOfComment } from '../../src/chat/answerComments.ts'
import { foldRecords } from '../../src/chat/model.ts'
import { barPlace, SelectionBar } from '../../src/chat/picked.tsx'
import { Rows } from '../../src/chat/Rows.tsx'
import { bus } from '../../src/lib/bus.ts'
import type { ChatRecord } from '../../src/lib/types.ts'
import { CmdPointer } from '../../src/pointer/CmdPointer.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

const TURN = '4c1d2e3f'
const ANSWER = 'Uploads fail after the retry budget runs out. The client gives up then.'
const WORDS = 'retry budget'
const records: ChatRecord[] = [{ type: 'user', text: 'Why do uploads fail?' }, { type: 'text', delta: ANSWER }, { type: 'done', result: null, turn: TURN }]
const CHECKS = [{ id: 'explainers', name: 'Explainers', prompt: 'The background a reader lacks.', colour: 3, builtin: true, shown: true, covers: ['documents', 'answers'] }]
const COMMENT = {
  id: 'ae1', check: 'explainers', check_name: 'Explainers', color: 3, turn: TURN, row: '0', ref: `answer:${TURN}#s1`, start: 0,
  end: 45, quote: 'Uploads fail after the retry budget runs out.', words: WORDS, text: 'retry budget: How many times the client tries again.',
  details: '', status: 'open', chat: 'main',
}

beforeAll(() => {
  // jsdom lays nothing out: a range has no boxes
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect()
})

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The server: the checks, the comments on the answers, and each POST recorded, answered by `answer` (a Response as
 * it is, such as a refusal). */
function serve(o: { checks?: object[]; comments?: () => object[]; answer?: (url: string, body: unknown) => unknown } = {}) {
  const posts: { url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    const u = String(url)
    let body: unknown = u.endsWith('/answer-comments') ? { comments: o.comments?.() ?? [], running: [] } : u.endsWith('/checks') ? (o.checks ?? CHECKS) : u.includes('/concepts') ? [] : {}
    if (init.method === 'POST') {
      const sent = JSON.parse(String(init.body ?? '{}'))
      posts.push({ url: u, body: sent })
      body = await o.answer?.(u, sent)
      if (body instanceof Response) return body
    }
    return new Response(JSON.stringify(body ?? {}), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  return posts
}

let setRecords: (r: ChatRecord[]) => void = () => undefined
function Chat() {
  const [recs, set] = useState(records)
  setRecords = set
  return (
    <section data-panel="chat" data-chat-current="main">
      <div className="chat-list">
        <Rows rows={foldRecords(recs)} ws="mini" chat="main" />
      </div>
      <SelectionBar ws="mini" />
      <CmdPointer ws="mini" />
    </section>
  )
}

/** A while for the page to read the selection (its frame) and the server's answers. */
const later = () => act(async () => void (await new Promise((r) => setTimeout(r, 40))))

/** The words selected in the first text under `root` that holds them, as a drag over them leaves them. */
async function select(root: Element, words = WORDS) {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walk.nextNode()
  while (node && !node.textContent?.includes(words)) node = walk.nextNode()
  const range = document.createRange()
  range.setStart(node!, node!.textContent!.indexOf(words))
  range.setEnd(node!, node!.textContent!.indexOf(words) + words.length)
  document.getSelection()!.removeAllRanges()
  document.getSelection()!.addRange(range)
  await act(async () => void document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
  await later()
}
/** The toolbar's buttons by their words, in order. */
const buttons = () => [...document.querySelectorAll('.pick-bar button')].map((b) => b.textContent)
/** A click on the toolbar's button `label`, as the mouse gives it: its press and release, then the click, each counting
 * one click. */
const click = (label: string) =>
  act(async () => {
    const b = [...document.querySelectorAll<HTMLButtonElement>('.pick-bar button')].find((x) => x.textContent === label)!
    for (const type of ['mousedown', 'mouseup', 'click']) b.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail: 1 }))
  })
const press = (key: string) => act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))

test('words selected in an answer show a toolbar with Explain and Cite, in that order, and no Ask; words selected anywhere else show none', async () => {
  serve()
  const el = await mount(<Chat />)
  await later()
  // the analyst's question, and a paragraph outside the chat
  await select(el, 'uploads fail')
  expect(buttons()).toEqual([])
  const outside = document.body.appendChild(document.createElement('p'))
  outside.textContent = 'Notes on the retry budget.'
  await select(outside)
  expect(buttons()).toEqual([])
  await select(el.querySelector('.chat-text')!)
  expect(document.querySelector('.pick-bar')?.getAttribute('role')).toBe('toolbar')
  expect(buttons()).toEqual(['Explain', 'Cite'])
  expect(document.querySelectorAll('.pick-bar button .icon')).toHaveLength(2)
})

test('Cite cites the selected words, and the chat draws the citation with its label open, checking, the comments on the answer kept on their words', async () => {
  // a heads-up on the sentence the words stand in, and an explainer on the next one
  const heads = { ...COMMENT, id: 'ah1', check: 'heads-up', check_name: 'Heads up', color: 1, words: 'Uploads fail', text: 'Only one network.' }
  const next = { ...COMMENT, id: 'ae2', ref: `answer:${TURN}#s2`, start: 46, end: ANSWER.length, quote: 'The client gives up then.', words: 'gives up' }
  const posts = serve({ comments: () => [heads, next], answer: (u) => (u.endsWith('/marks/cite') ? { turn: TURN, n: 1 } : {}) })
  const el = await mount(<Chat />)
  await later()
  await select(el)
  await click('Cite')
  await later()
  const at = ANSWER.indexOf(WORDS)
  expect(posts).toEqual([{ url: '/api/ws/mini/marks/cite', body: { chat: 'main', turn: TURN, row: 1, start: at, end: at + WORDS.length, words: WORDS, sentence: 'Uploads fail after the [retry budget] runs out.' } }])
  expect(buttons()).toEqual([])
  expect(document.getSelection()!.isCollapsed).toBe(true)
  // the turn's marks record: the citation, checking, on its words, its label open
  await act(async () => setRecords([...records, { type: 'marks', turn: TURN, items: [{ n: 1, words: WORDS, sentence: 'Uploads fail after the [retry budget] runs out.', status: 'checking', shown: WORDS, asked: true, row: 1, start: at, end: at + WORDS.length }] } as ChatRecord]))
  await later()
  expect(el.querySelector('.mark.is-checking .mark-words')?.textContent).toBe(WORDS)
  expect(document.querySelector('.mark-pop .mark-pop-status')?.textContent).toContain('checking')
  expect([...el.querySelectorAll('mark.answer-tint')].map((m) => m.textContent)).toEqual(['Uploads fail', 'gives up'])
})

/** The words' tint and the chat as the window lays them out: each tint on the line at 300 px, the answer's column, and
 * the chat's list; the comment's card stands beside the words, its top 2 px above their line (RefChip placeBeside). */
function layOut() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.matches('mark.answer-tint')) return new DOMRect(120, 300, 80, 20)
    if (this.matches('.chat-text')) return new DOMRect(10, 100, 390, 400)
    if (this.matches('.chat-list')) return new DOMRect(0, 0, 400, 700)
    return new DOMRect()
  })
}
const card = () => document.querySelector<HTMLElement>('.answer-cm-pop')
const statement = () => card()?.querySelector('.wu-cm-statement')
/** A press of `key` where the page hears it, with the focus in no field. */
const pressOnPage = (key: string) => act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
/** The server's refusal, as explain.py gives one. */
const refusal = (status: number, detail: string) => new Response(JSON.stringify({ detail }), { status, headers: { 'content-type': 'application/json' } })
const OFF = 'Explainers is off for the chat. Turn it on under Comments in the top bar, with Chat in its Show in.'

test("Explain opens the explainer's card beside the words at once, a spinner where its text will stand; once written, the text takes the spinner's place in the same card", async () => {
  let written: (v: unknown) => void = () => undefined
  let comments: object[] = []
  const posts = serve({ comments: () => comments, answer: (u) => (u.endsWith('/explain') ? new Promise((r) => (written = r)) : {}) })
  layOut()
  const el = await mount(<Chat />)
  await later()
  await select(el)
  await click('Explain')
  await later()
  const at = ANSWER.indexOf(WORDS)
  expect(posts.map((p) => [p.url, p.body])).toEqual([['/api/ws/mini/explain', { chat: 'main', turn: TURN, words: WORDS, row: 1, start: at, end: at + WORDS.length }]])
  expect(buttons()).toEqual([])
  expect([...el.querySelectorAll('mark.answer-tint-pending')].map((m) => m.textContent)).toEqual([WORDS])
  // the Explainers card beside the words: its head, the words, and a spinner but no words of state; nothing to resolve
  const pop = card()!
  expect(pop.querySelector('.wu-cm-name')?.textContent).toBe('Explainers')
  expect(statement()?.textContent).toBe('retry budget: ')
  expect(statement()?.querySelector('.spinner')?.getAttribute('aria-label')).toBe('writing')
  expect(pop.querySelector('.wu-cm-resolve')).toBeNull()
  const place = [pop.style.left, pop.style.top]
  expect(place[1]).toBe('298px')
  // written: the server keeps it as an Explainers comment, and the chat reads the comments again
  comments = [COMMENT]
  await act(async () => written({ id: 'ae1', ref: COMMENT.ref, turn: TURN, check: 'explainers' }))
  await act(async () => bus.emit('answerComments', {}))
  await later()
  expect(el.querySelector('mark.answer-tint-pending')).toBeNull()
  expect(el.querySelector('mark.answer-tint-open[data-answer-comment="ae1"]')?.textContent).toBe(WORDS)
  expect(document.querySelectorAll('.answer-cm-pop')).toHaveLength(1)
  expect(card()).toBe(pop)
  expect([pop.style.left, pop.style.top]).toEqual(place)
  expect(statement()?.textContent).toBe('retry budget: How many times the client tries again.')
  expect(pop.querySelector('.spinner')).toBeNull()
  expect(pop.querySelector('.wu-cm-resolve')).not.toBeNull()
})

test('closed before its explainer is written, the card does not open again by itself: the words then show its tint, which opens it; Explain on words an explainer stands on, or one being written, opens that one at once, with no call', async () => {
  let written: (v: unknown) => void = () => undefined
  let comments: object[] = []
  const posts = serve({ comments: () => comments, answer: (u) => (u.endsWith('/explain') ? new Promise((r) => (written = r)) : {}) })
  const el = await mount(<Chat />)
  await later()
  await select(el)
  await click('Explain')
  await later()
  expect(statement()?.querySelector('.spinner')).not.toBeNull()
  await pressOnPage('Escape')
  expect(card()).toBeNull()
  // the words keep their tint while it is written, and Explain on them opens its card again
  expect([...el.querySelectorAll('mark.answer-tint-pending')].map((m) => m.textContent)).toEqual([WORDS])
  await select(el)
  await click('Explain')
  await later()
  expect(posts).toHaveLength(1)
  expect(statement()?.querySelector('.spinner')).not.toBeNull()
  await pressOnPage('Escape')
  comments = [COMMENT]
  await act(async () => written({ id: 'ae1', ref: COMMENT.ref, turn: TURN, check: 'explainers' }))
  await act(async () => bus.emit('answerComments', {}))
  await later()
  expect(card()).toBeNull()
  expect(el.querySelector('mark.answer-tint-pending')).toBeNull()
  const tint = el.querySelector<HTMLElement>('mark.answer-tint[data-answer-comment="ae1"]')!
  expect([tint.textContent, tint.classList.contains('answer-tint-open')]).toEqual([WORDS, false])
  await act(async () => void tint.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(statement()?.textContent).toBe(COMMENT.text)
  await pressOnPage('Escape')
  // the same words again: the explainer on them opens at once
  await select(el)
  await click('Explain')
  await later()
  expect(posts).toHaveLength(1)
  expect(statement()?.textContent).toBe(COMMENT.text)
  expect(document.querySelector('.spinner')).toBeNull()
})

test('a failure says why in the card, in place of the spinner, and is no toast; once the card is closed, a toast says it', async () => {
  const replies: ((v: unknown) => void)[] = []
  serve({ answer: (u) => (u.endsWith('/explain') ? new Promise((r) => replies.push(r)) : {}) })
  const toasts: string[] = []
  const off = bus.on('toast', (t) => void toasts.push(t.text))
  const el = await mount(<Chat />)
  await later()
  await select(el, 'client gives up')
  await click('Explain')
  await later()
  await act(async () => replies[0](refusal(409, OFF)))
  await later()
  expect(statement()?.textContent).toBe(`client gives up: Could not explain: ${OFF}`)
  expect(statement()?.querySelector('.answer-cm-failed')?.textContent).toBe(`Could not explain: ${OFF}`)
  expect(statement()?.querySelector('.spinner')).toBeNull()
  expect(toasts).toEqual([])
  // closed, the card takes the words' tint with it
  await pressOnPage('Escape')
  expect(card()).toBeNull()
  expect(el.querySelector('mark.answer-tint-pending')).toBeNull()
  // closed while it is written: the failure is a toast
  await select(el, 'client gives up')
  await click('Explain')
  await later()
  await pressOnPage('Escape')
  await act(async () => replies[1](refusal(409, OFF)))
  await later()
  off()
  expect(card()).toBeNull()
  expect(el.querySelector('mark.answer-tint-pending')).toBeNull()
  expect(toasts).toEqual([`Could not explain: ${OFF}`])
})

test('c, e and a do nothing at the selection; a ⌘-click on the answer opens the ask box, and its question starts a side thread about it', async () => {
  const posts = serve({ answer: (u) => (u.endsWith('/chats') ? { id: 't7' } : {}) })
  // the answer's text shows on screen, where the box shows beside it
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [new DOMRect(10, 100, 390, 20)] as unknown as DOMRectList)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(10, 100, 390, 20))
  const opened: string[] = []
  const off = bus.on('openChat', ({ chatId }) => void opened.push(chatId))
  const el = await mount(<Chat />)
  await later()
  await select(el)
  for (const key of ['c', 'e', 'a']) await press(key)
  await settle()
  expect(posts).toEqual([])
  expect(document.querySelector('.pointer-box')).toBeNull()
  expect(el.querySelector('mark.answer-tint-pending')).toBeNull()
  expect(buttons()).toEqual(['Explain', 'Cite'])
  expect(document.getSelection()!.toString()).toBe(WORDS)
  // the ask key is Ctrl off a Mac, as jsdom is
  const words = el.querySelector('.chat-text[data-anchor="chat:main#1"] p')!
  await act(async () => {
    for (const type of ['mousedown', 'mouseup', 'click']) words.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ctrlKey: true }))
  })
  await later()
  const field = document.querySelector<HTMLTextAreaElement>('.pointer-box textarea')!
  expect(field).not.toBeNull()
  expect(buttons()).toEqual([])
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Why five tries?')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => void field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  await later()
  off()
  expect(posts.map((p) => p.url)).toEqual(['/api/ws/mini/chats'])
  expect(posts[0].body).toMatchObject({ anchor: 'chat:main#1', text: 'Why five tries?' })
  expect(opened).toEqual(['t7'])
})

test('Escape drops the selection and the toolbar; with Explainers off for the chat, Explain is not shown', async () => {
  const posts = serve({ checks: [{ ...CHECKS[0], shown: false }] })
  const el = await mount(<Chat />)
  await later()
  await select(el)
  expect(buttons()).toEqual(['Cite'])
  await press('Escape')
  await later()
  expect(buttons()).toEqual([])
  expect(document.getSelection()!.isCollapsed).toBe(true)
  expect(posts).toEqual([])
})

test('the toolbar stands just above the words, centered on where they end; under them when there is no room above; inside the window', async () => {
  const line = (top: number, right: number) => ({ top, right, bottom: top + 20 })
  const view = { width: 1440, height: 900 }
  expect(barPlace(line(300, 260), line(300, 260), 150, 32, view)).toEqual({ left: 185, top: 262 })
  // words over two lines: above the first, centered on the end of the last
  expect(barPlace(line(300, 600), line(320, 120), 150, 32, view)).toEqual({ left: 45, top: 262 })
  // no room above: under the last line
  expect(barPlace(line(30, 260), line(30, 260), 150, 32, view)).toEqual({ left: 185, top: 56 })
  // near the window's right and left edges
  expect(barPlace(line(300, 1430), line(300, 1430), 150, 32, view).left).toBe(1282)
  expect(barPlace(line(300, 20), line(300, 20), 150, 32, view).left).toBe(8)
  // on the page, from the lines of the selection (jsdom gives the toolbar no size)
  serve()
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(() => [new DOMRect(100, 300, 90, 20)] as unknown as DOMRectList)
  const el = await mount(<Chat />)
  await later()
  await select(el)
  const bar = document.querySelector<HTMLElement>('.pick-bar')!
  expect([bar.style.left, bar.style.top]).toEqual(['190px', '294px'])
})

test('after a click with the pointer the toolbar keeps its place, unseen and with no buttons, until the pointer moves, presses or turns the wheel; a click from the keyboard takes it away at once', async () => {
  serve({ answer: (u) => (u.endsWith('/marks/cite') ? { turn: TURN, n: 1 } : {}) })
  // the toolbar, 150 by 32, over the line above the words
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(() => [new DOMRect(100, 300, 90, 20)] as unknown as DOMRectList)
  const size = (px: number) =>
    function (this: HTMLElement) {
      return this.classList.contains('pick-bar') ? px : 0
    }
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(size(150))
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(size(32))
  const el = await mount(<Chat />)
  await later()
  const bar = () => document.querySelector<HTMLElement>('.pick-bar')
  const place = () => [bar()?.style.left, bar()?.style.top, bar()?.style.width, bar()?.style.height, bar()?.getAttribute('aria-hidden')]
  const covered = ['115px', '262px', '150px', '32px', 'true']
  const send = (e: Event) => act(async () => void bar()!.dispatchEvent(e))
  await select(el)
  expect(place()).toEqual(['115px', '262px', '', '', null])
  await click('Explain')
  await later()
  expect(buttons()).toEqual([])
  expect(place()).toEqual(covered)
  // a move with no movement, which the pointer did not make, keeps it; a move with movement takes it away
  await send(new PointerEvent('pointermove', { bubbles: true }))
  expect(place()).toEqual(covered)
  await send(new PointerEvent('pointermove', { bubbles: true, movementX: 2, movementY: -1 }))
  expect(bar()).toBeNull()
  // as do a press and the wheel
  for (const e of [new PointerEvent('pointerdown', { bubbles: true }), new WheelEvent('wheel', { bubbles: true, deltaY: 120 })]) {
    await select(el)
    await click('Cite')
    await later()
    expect(place()).toEqual(covered)
    await send(e)
    expect(bar()).toBeNull()
  }
  // Enter or Space on a focused button clicks it with no count of clicks
  await select(el)
  await act(async () => [...bar()!.querySelectorAll('button')].find((b) => b.textContent === 'Cite')!.click())
  await later()
  expect(bar()).toBeNull()
})

// a turn whose line before its tool call holds the words, and whose answer holds them twice in one sentence
const PLAN = 'I will check the retry budget first.'
const TWICE = 'Uploads fail after the retry budget runs out, and the retry budget is five tries.'
const turnRecords: ChatRecord[] = [
  { type: 'user', text: 'Why do uploads fail?' },
  { type: 'text', delta: PLAN },
  { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'client/upload.py' } },
  { type: 'tool_result', id: 'tu1', summary: 'read 40 lines' },
  { type: 'text', delta: TWICE },
  { type: 'done', result: null, turn: TURN },
]

/** The words selected at their `nth` place (from 0) in the text row `row`, as a drag over them leaves them. */
async function selectAt(el: HTMLElement, row: number, words: string, nth: number) {
  const box = el.querySelector(`.chat-text[data-anchor="chat:main#${row}"]`)!
  const nodes: Text[] = []
  const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) nodes.push(n as Text)
  const all = nodes.map((n) => n.data).join('')
  let at = -1
  for (let k = 0; k <= nth; k++) at = all.indexOf(words, at + 1)
  // the node a place falls in: a start at a node's end begins the next node
  const point = (i: number, end: boolean): [Text, number] => {
    for (const n of nodes) {
      if (i < n.data.length || (end && i === n.data.length)) return [n, i]
      i -= n.data.length
    }
    throw new Error('no such place')
  }
  const range = document.createRange()
  range.setStart(...point(at, false))
  range.setEnd(...point(at + words.length, true))
  document.getSelection()!.removeAllRanges()
  document.getSelection()!.addRange(range)
  await act(async () => void document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
  await later()
}

test('Explain acts on the words where they were selected: the explainer stands on them in the answer, not in the line before it that holds them too, and at their second place in one sentence', async () => {
  let written: (v: unknown) => void = () => undefined
  let comments: object[] = []
  const posts = serve({ comments: () => comments, answer: (u) => (u.endsWith('/explain') ? new Promise((r) => (written = r)) : {}) })
  const el = await mount(<Chat />)
  await act(async () => setRecords(turnRecords))
  await later()
  await selectAt(el, 4, WORDS, 1)
  await click('Explain')
  await later()
  const at = TWICE.lastIndexOf(WORDS)
  expect(posts.map((p) => p.body)).toEqual([{ chat: 'main', turn: TURN, words: WORDS, row: 4, start: at, end: at + WORDS.length }])
  // tinted where they were selected while the explainer is written
  const pending = [...el.querySelectorAll<HTMLElement>('mark.answer-tint-pending')]
  expect(pending.map((m) => [m.closest<HTMLElement>('.chat-text')?.dataset.anchor, m.previousSibling?.textContent])).toEqual([['chat:main#4', 'Uploads fail after the retry budget runs out, and the ']])
  comments = [{ ...COMMENT, ref: `answer:${TURN}#s2`, row: '1', start: 0, end: TWICE.length, quote: TWICE, nth: 1 }]
  await act(async () => written({ id: 'ae1', ref: `answer:${TURN}#s2`, turn: TURN, check: 'explainers' }))
  await act(async () => bus.emit('answerComments', {}))
  await later()
  const tint = el.querySelector<HTMLElement>('mark.answer-tint[data-answer-comment="ae1"]')!
  expect([tint.closest<HTMLElement>('.chat-text')?.dataset.anchor, tint.textContent, tint.previousSibling?.textContent]).toEqual(['chat:main#4', WORDS, 'Uploads fail after the retry budget runs out, and the '])
})

test('Cite cites the words where they were selected: their second place in one sentence of the answer, not their first, nor the line before it', async () => {
  const posts = serve({ answer: (u) => (u.endsWith('/marks/cite') ? { turn: TURN, n: 1 } : {}) })
  const el = await mount(<Chat />)
  await act(async () => setRecords(turnRecords))
  await later()
  await selectAt(el, 4, WORDS, 1)
  await click('Cite')
  await later()
  const at = TWICE.lastIndexOf(WORDS)
  expect(posts.map((p) => p.body)).toEqual([{ chat: 'main', turn: TURN, row: 4, start: at, end: at + WORDS.length, words: WORDS, sentence: 'Uploads fail after the retry budget runs out, and the [retry budget] is five tries.' }])
})

test("a side thread's answer draws the explainer asked for there, as main's chat draws one, and Go to it opens that thread", async () => {
  const THREAD_TURN = '0a1b2c3d'
  serve({ comments: () => [{ ...COMMENT, id: 'at1', turn: THREAD_TURN, ref: `answer:${THREAD_TURN}#s1`, chat: 't7' }] })
  const thread: ChatRecord[] = [{ type: 'user', text: 'And then?' }, { type: 'text', delta: ANSWER }, { type: 'done', result: null, turn: THREAD_TURN }]
  const el = await mount(<Rows rows={foldRecords(thread)} ws="mini" chat="t7" />)
  await later()
  expect(el.querySelector('mark.answer-tint[data-answer-comment="at1"]')?.textContent).toBe(WORDS)
  expect(chatOfComment('at1')).toBe('t7')
})
