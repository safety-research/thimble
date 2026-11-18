// @vitest-environment jsdom
// The keys at a selection in an answer (src/chat/picked.tsx), as the terminal's bar shows them: words selected in an
// answer of main's chat show `c cite · e explain · a ask` beside them. c makes them a citation of the answer, which the
// chat draws as a mark with its label open, checking; e writes their explainer, the words tinted while it is written and
// its comment open on them once written; a opens the ask box on them, whose question starts a side thread about them.
// Escape drops the selection, a key typed into a field is the field's, and with Explainers off for the chat e is not
// shown. A side thread's answers draw the explainers asked for there. c and e act on the words where they were selected:
// in the answer, not in a line of the turn before it that holds them too, and at their second place in one sentence.
import { act, useState } from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { chatOfComment } from '../../src/chat/answerComments.ts'
import { foldRecords } from '../../src/chat/model.ts'
import { SelectionKeys } from '../../src/chat/picked.tsx'
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

/** The server: the checks, the comments on the answers, and each POST recorded, answered by `answer`. */
function serve(o: { checks?: object[]; comments?: () => object[]; answer?: (url: string, body: unknown) => unknown } = {}) {
  const posts: { url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    const u = String(url)
    let body: unknown = u.endsWith('/answer-comments') ? { comments: o.comments?.() ?? [], running: [] } : u.endsWith('/checks') ? (o.checks ?? CHECKS) : u.includes('/concepts') ? [] : {}
    if (init.method === 'POST') {
      const sent = JSON.parse(String(init.body ?? '{}'))
      posts.push({ url: u, body: sent })
      body = await o.answer?.(u, sent)
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
      <SelectionKeys ws="mini" />
      <CmdPointer ws="mini" />
    </section>
  )
}

/** A while for the page to read the selection (its frame) and the server's answers. */
const later = () => act(async () => void (await new Promise((r) => setTimeout(r, 40))))

/** The words selected in the answer's text, as a drag over them leaves them. */
async function select(el: HTMLElement, words = WORDS) {
  const node = [...el.querySelectorAll('.chat-text p')].flatMap((p) => [...p.childNodes]).find((n) => n.textContent?.includes(words))!
  const range = document.createRange()
  range.setStart(node, node.textContent!.indexOf(words))
  range.setEnd(node, node.textContent!.indexOf(words) + words.length)
  document.getSelection()!.removeAllRanges()
  document.getSelection()!.addRange(range)
  await act(async () => void document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
  await later()
}
const keys = () => [...document.querySelectorAll('.pick-keys .pick-key')].map((k) => k.textContent)
const press = (key: string) => act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))

test('words selected in an answer show c cite · e explain · a ask; c cites them, and the chat draws the citation with its label open, checking, the comments on the answer kept on their words', async () => {
  // a heads-up on the sentence the words stand in, and an explainer on the next one
  const heads = { ...COMMENT, id: 'ah1', check: 'heads-up', check_name: 'Heads up', color: 1, words: 'Uploads fail', text: 'Only one network.' }
  const next = { ...COMMENT, id: 'ae2', ref: `answer:${TURN}#s2`, start: 46, end: ANSWER.length, quote: 'The client gives up then.', words: 'gives up' }
  const posts = serve({ comments: () => [heads, next], answer: (u) => (u.endsWith('/marks/cite') ? { turn: TURN, n: 1 } : {}) })
  const el = await mount(<Chat />)
  await later()
  await select(el)
  expect(keys()).toEqual(['c cite', 'e explain', 'a ask'])
  await press('c')
  await later()
  const at = ANSWER.indexOf(WORDS)
  expect(posts).toEqual([{ url: '/api/ws/mini/marks/cite', body: { chat: 'main', turn: TURN, row: 1, start: at, end: at + WORDS.length, words: WORDS, sentence: 'Uploads fail after the [retry budget] runs out.' } }])
  expect(keys()).toEqual([])
  expect(document.getSelection()!.isCollapsed).toBe(true)
  // the turn's marks record: the citation, checking, on its words, its label open
  await act(async () => setRecords([...records, { type: 'marks', turn: TURN, items: [{ n: 1, words: WORDS, sentence: 'Uploads fail after the [retry budget] runs out.', status: 'checking', shown: WORDS, asked: true, row: 1, start: at, end: at + WORDS.length }] } as ChatRecord]))
  await later()
  expect(el.querySelector('.mark.is-checking .mark-words')?.textContent).toBe(WORDS)
  expect(document.querySelector('.mark-pop .mark-pop-status')?.textContent).toContain('checking')
  expect([...el.querySelectorAll('mark.answer-tint')].map((m) => m.textContent)).toEqual(['Uploads fail', 'gives up'])
})

test('e writes the explainer of the selected words: they are tinted while it is written, and its comment opens on them once written', async () => {
  let written: (v: unknown) => void = () => undefined
  let comments: object[] = []
  const posts = serve({ comments: () => comments, answer: (u) => (u.endsWith('/explain') ? new Promise((r) => (written = r)) : {}) })
  const el = await mount(<Chat />)
  await later()
  await select(el)
  await press('e')
  await later()
  const at = ANSWER.indexOf(WORDS)
  expect(posts.map((p) => [p.url, p.body])).toEqual([['/api/ws/mini/explain', { chat: 'main', turn: TURN, words: WORDS, row: 1, start: at, end: at + WORDS.length }]])
  expect([...el.querySelectorAll('mark.answer-tint-pending')].map((m) => m.textContent)).toEqual([WORDS])
  // written: the server keeps it as an Explainers comment, and the chat reads the comments again
  comments = [COMMENT]
  await act(async () => written({ id: 'ae1', ref: COMMENT.ref, turn: TURN, check: 'explainers' }))
  await act(async () => bus.emit('answerComments', {}))
  await later()
  expect(el.querySelector('mark.answer-tint-pending')).toBeNull()
  expect(el.querySelector('mark.answer-tint[data-answer-comment="ae1"]')?.textContent).toBe(WORDS)
  expect(document.querySelector('.answer-cm-pop .wu-cm-statement')?.textContent).toBe('retry budget: How many times the client tries again.')
})

test('a opens the ask box on the selected words, and its question starts a side thread about them, as a ⌘-drag does', async () => {
  const posts = serve({ answer: (u) => (u.endsWith('/chats') ? { id: 't7' } : {}) })
  // the answer's text shows on screen, where the box looks for what the selection touches
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [new DOMRect(10, 100, 390, 20)] as unknown as DOMRectList)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(10, 100, 390, 20))
  const opened: string[] = []
  const off = bus.on('openChat', ({ chatId }) => void opened.push(chatId))
  const el = await mount(<Chat />)
  await later()
  await select(el)
  await press('a')
  await settle()
  const field = document.querySelector<HTMLTextAreaElement>('.pointer-box textarea')!
  expect(field).not.toBeNull()
  expect(keys()).toEqual([])
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Why five tries?')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => void field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  await later()
  off()
  expect(posts.map((p) => p.url)).toEqual(['/api/ws/mini/chats'])
  expect(posts[0].body).toMatchObject({ anchor: 'chat:main#1', anchor_text: WORDS, text: 'Why five tries?' })
  expect(opened).toEqual(['t7'])
})

test('Escape drops the selection; a key typed in a field is the field’s; with Explainers off for the chat, e is not shown', async () => {
  const posts = serve({ checks: [{ ...CHECKS[0], shown: false }] })
  const el = await mount(<Chat />)
  await later()
  await select(el)
  expect(keys()).toEqual(['c cite', 'a ask'])
  await press('e')
  const field = document.body.appendChild(document.createElement('textarea'))
  field.focus()
  await press('c')
  expect(posts).toEqual([])
  field.blur()
  await press('Escape')
  await later()
  expect(keys()).toEqual([])
  expect(document.getSelection()!.isCollapsed).toBe(true)
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

test('e acts on the words where they were selected: the explainer stands on them in the answer, not in the line before it that holds them too, and at their second place in one sentence', async () => {
  let written: (v: unknown) => void = () => undefined
  let comments: object[] = []
  const posts = serve({ comments: () => comments, answer: (u) => (u.endsWith('/explain') ? new Promise((r) => (written = r)) : {}) })
  const el = await mount(<Chat />)
  await act(async () => setRecords(turnRecords))
  await later()
  await selectAt(el, 4, WORDS, 1)
  await press('e')
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

test('c cites the words where they were selected: their second place in one sentence of the answer, not their first, nor the line before it', async () => {
  const posts = serve({ answer: (u) => (u.endsWith('/marks/cite') ? { turn: TURN, n: 1 } : {}) })
  const el = await mount(<Chat />)
  await act(async () => setRecords(turnRecords))
  await later()
  await selectAt(el, 4, WORDS, 1)
  await press('c')
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
