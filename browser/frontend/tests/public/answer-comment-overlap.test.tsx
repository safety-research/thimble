// @vitest-environment jsdom
// Words that carry more than one mark in main's chat (src/chat/markdown.tsx MdMark, chat/answerComments.ts
// nextMark, marks/Mark.tsx CiteWords): an explainer or a heads-up on a citation's words, or two comments on the same
// words. A click on them opens the innermost comment, as the terminal opens an explainer or a heads-up before the
// citation it stands on; each click on them again opens the next mark out, the citation last, then the innermost
// again. The citation's other words, and a comment's words outside the citation, open theirs at once. Enter and Space
// on a tint do what a click on it does, and nothing more. One mark is open at a time.
import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { nextMark, type AnswerComment } from '../../src/chat/answerComments.ts'
import { foldRecords } from '../../src/chat/model.ts'
import { Rows } from '../../src/chat/Rows.tsx'
import type { ChatRecord } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const TURN = '9f1c2a3b'
const QUOTE = 'After 19 June there are [0 new messages](#) to other agents.'
const CITED = `The board holds 412 posts. ${QUOTE}\n\nThe rest is quiet.`
const comment = (over: Partial<AnswerComment>): AnswerComment => ({
  id: 'g1', check: 'explainers', check_name: 'Explainers', color: 6, turn: TURN, row: '0',
  ref: `answer:${TURN}#s2`, start: 27, end: 89, quote: QUOTE, words: 'new messages',
  text: 'new messages: posts one agent sent to another.', status: 'open', ...over,
})
const heads = (over: Partial<AnswerComment>) =>
  comment({ id: 'h1', check: 'heads-up', check_name: 'Heads up', color: 2, text: 'Two agents post by mail.', ...over })

/** Main's chat with the answer `text` and the comments `list` on it. */
async function chat(list: AnswerComment[], text = CITED): Promise<HTMLElement> {
  vi.stubGlobal('fetch', async (url: unknown) => {
    const body = String(url).endsWith('/answer-comments') ? { comments: list, running: [] } : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const records: ChatRecord[] = [
    { type: 'user', text: 'What happened after 19 June?' },
    { type: 'text', delta: text },
    { type: 'done', result: null, turn: TURN },
  ]
  const el = await mount(<Rows rows={foldRecords(records)} ws="mini" chat="main" />)
  await settle()
  await settle()
  return el
}

/** What is open: the comment beside its passage, by its id, or the citation's label; both, joined, would be a fault. */
function open(): string | null {
  const comment = document.querySelector<HTMLElement>('.answer-cm-pop')?.dataset.answerCommentPop ?? null
  const citation = document.querySelector('.mark-pop') ? 'citation' : null
  return comment && citation ? `${comment}+${citation}` : (comment ?? citation)
}

/** A press as the pointer makes it, on `el`: pointerdown, mousedown, pointerup, mouseup, then the click. */
const press = (el: Element) =>
  act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup'])
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
    ;(el as HTMLElement).click()
  })
const key = (el: Element, k: string) =>
  act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })))
const escape = () => key(document.body, 'Escape')

/** `n` clicks on `el` in turn, and what is open after each. */
async function clicks(el: Element, n: number): Promise<(string | null)[]> {
  const out: (string | null)[] = []
  for (let i = 0; i < n; i++) {
    await press(el)
    out.push(open())
  }
  return out
}

/** The piece of comment `id`'s tint inside the citation's words, or with `inside` false the one outside them. */
const tint = (root: HTMLElement, id: string, inside = true) =>
  [...root.querySelectorAll<HTMLElement>(`mark.answer-tint[data-answer-comment="${id}"]`)].find(
    (m) => !!m.closest('.mark-words') === inside,
  )!

describe('which mark a click on words that carry several opens', () => {
  test('the innermost first, then each one out, the innermost again after the last; a lone mark closes', () => {
    expect([nextMark(1, -1), nextMark(1, 0)]).toEqual([0, null])
    expect([-1, 0, 1].map((o) => nextMark(2, o))).toEqual([0, 1, 0])
    expect([-1, 0, 1, 2].map((o) => nextMark(3, o))).toEqual([0, 1, 2, 0])
    expect(nextMark(0, -1)).toBeNull()
  })
})

describe("words that carry more than one mark, in main's chat", () => {
  test("an explainer inside the citation's words opens first, the citation next, then the explainer", async () => {
    const el = await chat([comment({})])
    const words = el.querySelector<HTMLElement>('.mark-words')!
    expect([words.textContent, tint(el, 'g1').textContent]).toEqual(['0 new messages', 'new messages'])
    expect(await clicks(tint(el, 'g1'), 3)).toEqual(['g1', 'citation', 'g1'])
    await escape()
    expect(open()).toBeNull()
    // the citation's other words open it at once; the explainer's words then open the explainer in its place
    await press(words)
    expect(open()).toBe('citation')
    await press(tint(el, 'g1'))
    expect(open()).toBe('g1')
  })

  test("a heads-up on the citation's very words opens first, then the citation", async () => {
    const el = await chat([heads({ words: '0 new messages' })])
    expect(el.querySelector('.mark-words')!.textContent).toBe(tint(el, 'h1').textContent)
    expect(await clicks(tint(el, 'h1'), 3)).toEqual(['h1', 'citation', 'h1'])
  })

  test('an explainer whose words reach outside the citation opens at once on its words outside it', async () => {
    const el = await chat([comment({ id: 'g2', words: 'there are 0 new' })])
    expect([tint(el, 'g2', false).textContent, tint(el, 'g2').textContent]).toEqual(['there are ', '0 new'])
    expect(await clicks(tint(el, 'g2', false), 2)).toEqual(['g2', null])
    expect(await clicks(tint(el, 'g2'), 2)).toEqual(['g2', 'citation'])
    // a click on its words outside the citation, with the citation's label open, opens it in the label's place
    await press(tint(el, 'g2', false))
    expect(open()).toBe('g2')
  })

  test('two explainers on the same words in a citation open in turn, innermost first, the citation last', async () => {
    const el = await chat([comment({}), comment({ id: 'g3', text: 'new messages: those since the cut-off.' })])
    // the one drawn later stands inside the other
    const nested = '.mark-words mark[data-answer-comment="g1"] > mark[data-answer-comment="g3"]'
    expect(el.querySelector(nested)).not.toBeNull()
    expect(await clicks(tint(el, 'g3'), 4)).toEqual(['g3', 'g1', 'citation', 'g3'])
  })

  test('two comments on the same words, no citation there, open in turn, each click the other, until Esc', async () => {
    const quote = 'After 19 June there are **0 new messages** to other agents.'
    const text = `The board holds 412 posts. ${quote}`
    const jargon = comment({ id: 'c1', check: 'jargon', check_name: 'Jargon', color: 3, quote, text: 'Say: sent.' })
    const el = await chat([comment({ quote }), jargon], text)
    expect(el.querySelector('.mark-words')).toBeNull()
    expect(await clicks(tint(el, 'c1', false), 3)).toEqual(['c1', 'g1', 'c1'])
    await escape()
    expect(open()).toBeNull()
  })

  test("the pointer resting on the words shows the citation's label; a click opens the explainer instead", async () => {
    const el = await chat([comment({})])
    const words = el.querySelector<HTMLElement>('.mark-words')!
    await act(async () => {
      words.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))
      await new Promise((r) => setTimeout(r, 150))
    })
    expect(open()).toBe('citation')
    await press(tint(el, 'g1'))
    expect(open()).toBe('g1')
    // the label's own timer does not bring it back over the explainer
    await act(async () => void (await new Promise((r) => setTimeout(r, 300))))
    expect(open()).toBe('g1')
  })

  test("Enter and Space on the explainer's tint do what a click does, never reaching the citation", async () => {
    const el = await chat([comment({})])
    const words = el.querySelector<HTMLElement>('.mark-words')!
    const g1 = tint(el, 'g1')
    // both are stops of Tab, the citation's words first, as the tint stands inside them
    expect([words.tabIndex, g1.tabIndex]).toEqual([0, 0])
    expect(words.compareDocumentPosition(g1) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy()
    await key(g1, 'Enter')
    expect(open()).toBe('g1')
    await key(g1, 'Enter')
    expect(open()).toBe('citation')
    await key(g1, ' ')
    expect(open()).toBe('g1')
    // Enter on the citation's words opens the citation, and the explainer makes way for it
    await key(words, 'Enter')
    expect(open()).toBe('citation')
  })

  test("a citation in the comment's own details opens over the comment, which stays open", async () => {
    const el = await chat([comment({ details: 'Counted as [[0|card:c1a2b3#messages/after]] in the card.' })])
    await press(tint(el, 'g1'))
    await press(document.querySelector('.answer-cm-pop .wu-cm-more')!)
    const own = document.querySelector('.answer-cm-pop .mark-words')!
    expect(own.textContent).toBe('0')
    await press(own)
    expect(open()).toBe('g1+citation')
  })

  test("a press on the explainer's words released on the citation's other words opens the citation alone", async () => {
    const el = await chat([comment({})])
    const words = el.querySelector<HTMLElement>('.mark-words')!
    await press(tint(el, 'g1'))
    expect(open()).toBe('g1')
    // the browser ends a drag out of the tint with a click on the element that holds both ends
    const g1 = tint(el, 'g1')
    await act(async () => {
      for (const type of ['pointerdown', 'mousedown']) g1.dispatchEvent(new MouseEvent(type, { bubbles: true }))
      for (const type of ['pointerup', 'mouseup']) words.dispatchEvent(new MouseEvent(type, { bubbles: true }))
      words.click()
    })
    expect(open()).toBe('citation')
  })
})
