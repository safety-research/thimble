// @vitest-environment jsdom
// The tour's examples (src/tour/examples.json) that the current components can draw here: the example answer in the
// chat as its citations are checked and as a check comments on it, the citations' labels, the card's takeaway with its
// citations, the Labels sidebar and Color by's source chip. Each is drawn from the real component with the tour's
// example data, and must equal what the file holds, so the tour shows thimble as it is now. When a component changes,
// write them again with
//
//   TOUR_CAPTURE=1 npx vitest run tests/public/tour-examples.test.tsx
//
// The rest of the file (the transcript, the card's chart, the report, the views bar) was captured from a live page.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AnswerCommentPop } from '../../src/chat/AnswerComment.tsx'
import { tintOf, type AnswerComment, type AnswerMark } from '../../src/chat/answerComments.ts'
import { ChatMarkdown, ChipContext } from '../../src/chat/markdown.tsx'
import { ColorBy } from '../../src/files/ColorBy.tsx'
import { MarksFooter } from '../../src/marks/MarksFooter.tsx'
import type { MarkItem } from '../../src/marks/marks.ts'
import { LabelsSidebar } from '../../src/shell/LabelsSidebar.tsx'
import { mount, settle, unmountAll } from './mount.tsx'

const FILE = path.resolve(__dirname, '../../src/tour/examples.json')
const CAPTURE = !!process.env.TOUR_CAPTURE

// ---------- the example data

/** The example answer (tour/steps.ts QUESTION asks it): three cited times, the last one wrong on purpose. */
const ANSWER =
  'It went out at [02:06](#) UTC (deploys.csv writes UK time, so 03:06 there) and was still live when INC-312 opened at [08:02](#). The rollback to 4.11.3 began at [08:20](#).'
const TURN = 'tour'
const CODE = [
  'import pandas as pd',
  "d = pd.read_csv('deploys.csv', parse_dates=['time'])",
  "d['utc'] = d.time.dt.tz_localize('Europe/London').dt.tz_convert('UTC')",
  "print(d.loc[d.detail.str.startswith('payments 4.12.0:'), ['time', 'utc']])",
].join('\n')
const OUTPUT = ['                 time                       utc', '3 2026-05-16 03:06:02 2026-05-16 02:06:02+00:00', ''].join('\n')
const at = OUTPUT.lastIndexOf('02:06')
const DEPLOYS = [
  { n: 5, text: '2026-05-16 03:11:31,deploybot,payments,finished,payments 4.12.0 live on 3 of 3 replicas' },
  { n: 6, text: '2026-05-16 09:28:52,oncall,payments,rollback,payments 4.12.0 back to 4.11.3' },
  { n: 7, text: '2026-05-16 09:34:47,oncall,payments,finished,payments 4.11.3 live on 3 of 3 replicas' },
]
const AGENTS = [
  { n: 7, text: '2026-05-16T08:02:04Z pagerbot Opened INC-312: payments error rate 14%' },
  { n: 8, text: '2026-05-16T08:02:20Z autoheal Restarted payments-1 (error rate over limit)' },
]
const span = (text: string, words: string): [number, number] => [text.indexOf(words), text.indexOf(words) + words.length]
const item = (k: number, words: string, rest: Partial<MarkItem>): MarkItem => ({ n: k + 1, piece: 0, k, words, sentence: '', status: 'verified', shown: words, turn: TURN, ...rest })
const CHECKED: MarkItem[] = [
  item(0, '02:06', { evidence: { kind: 'computed', code: CODE, output: OUTPUT, highlight: [[at, at + 5]], by: 'main' } }),
  item(1, '08:02', { evidence: { kind: 'quote', file: 'agents.log', line: 7, lines: AGENTS.map((l) => (l.n === 7 ? { ...l, highlight: span(l.text, '08:02') } : l)) } }),
  item(2, '08:20', {
    status: 'failed',
    failedBy: 'evidence',
    reason: 'deploys.csv shows the rollback began at 09:28 UK time, which is 08:28 UTC.',
    evidence: { kind: 'quote', file: 'deploys.csv', line: 6, lines: DEPLOYS.map((l) => (l.n === 6 ? { ...l, highlight: span(l.text, '09:28') } : l)) },
  }),
]
const CHECKING: MarkItem[] = CHECKED.map((m) => ({ n: m.n, piece: m.piece, k: m.k, words: m.words, sentence: '', status: 'checking' }))
/** Explainers' comment on the answer's "UK time" (backend checks.py: Explainers reads Claude's answers by default). */
const EXPLAINER: AnswerComment = {
  id: 'tour-explainer', check: 'explainers', check_name: 'Explainers', color: 6, turn: TURN, row: '0', ref: `answer:${TURN}#s1`,
  start: 0, end: 0, quote: 'UK time', words: 'UK time',
  text: 'UK time in May is British Summer Time, one hour ahead of UTC. So 03:06 in deploys.csv is 02:06 UTC.',
  details: '', status: 'open',
}
const TINT: AnswerMark = { id: EXPLAINER.id, quote: EXPLAINER.quote, words: EXPLAINER.words, colour: tintOf(EXPLAINER), ref: EXPLAINER.ref, active: false }

/** The example card's takeaway (examples.json `card`) and the lines of its printed output, in plain words. */
const CARD = 'e2d6a7ec'
const TAKEAWAY =
  `Payments version [[4.12.0|card:${CARD}@out1#L2]] most likely caused the outage. It changed how the service connects to its database. The database came close to running out of connections at night, ran out at [[08:04|card:${CARD}@out1#L8]] in the morning, and recovered once the update was undone at [[08:29|card:${CARD}@out1#L11]]. The night warning cleared by itself, and the alert to the on-call engineer was held until [[07:00|card:${CARD}@out1#L4]].`
const CARD_OUT = [
  'timeline: 12 events',
  '2026-05-16 02:06  Payments version 4.12.0 released',
  '2026-05-16 02:57  Night warning: 181 of 200 database connections in use',
  '2026-05-16 03:14  Night warning clears by itself, alert held until 07:00',
  '2026-05-16 07:41  Morning warning: 176 of 200 database connections in use',
  '2026-05-16 07:52  First customer reports the payment page is stuck',
  '2026-05-16 08:02  Outage declared and Ines, the on-call engineer, alerted',
  '2026-05-16 08:04  Database ran out of connections and more servers were added',
  '2026-05-16 08:15  Ines responds, 13 minutes after the alert',
  '2026-05-16 08:23  Automatic restarts and scaling switched off',
  '2026-05-16 08:29  Payments update undone, back to version 4.11.3',
  '2026-05-16 08:38  Payments working normally again',
  '2026-05-16 11:28  Outage closed after fix 4.12.1',
]

/** The example label over the transcript (examples.json `txReader`): what each step of the agent does. */
const LABEL = {
  id: '085c825a', name: 'what the step does', unit: 'record', kind: 'prompt', description: 'What does this step of the agent do?', spec: '', glob: 'agent-05.jsonl',
  labels: ['reads code', 'changes code', 'runs tests', 'talks to other agents', 'other'], shown: true,
  classes: [
    { name: 'reads code', color: 1, highlight: true },
    { name: 'changes code', color: 2, highlight: true },
    { name: 'runs tests', color: 3, highlight: true },
    { name: 'talks to other agents', color: 5, highlight: true },
    { name: 'other', color: 0, highlight: false },
  ],
  counts: { 'reads code': 8, 'changes code': 8, 'runs tests': 8, 'talks to other agents': 18, other: 34 }, n_labeled: 76,
}

// ---------- drawing

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
beforeEach(() => {
  vi.stubGlobal('fetch', async (url: unknown) => {
    const u = String(url)
    if (u.includes('/ref?')) {
      // the card's printed output around the cited line, as the server resolves `card:<id>@out1#L<n>`
      const n = Number(decodeURIComponent(u).match(/#L(\d+)/)?.[1] ?? 1)
      const from = Math.max(0, n - 3)
      return json({ kind: 'cell', excerpt: CARD_OUT.slice(from, n + 2).join('\n'), meta: { title: 'What happened on 16 May 2026, in UTC?', span: { text: CARD_OUT[n - 1] } } })
    }
    if (u.includes('/concepts')) return json([LABEL])
    if (u.includes('/settings')) return json({ models: {} })
    if (u.endsWith('/checks')) return json([])
    return json({})
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

/** Markup as the tour keeps it: no ids React made up, which differ from one drawing to the next. */
function clean(el: Element): string {
  const copy = el.cloneNode(true) as Element
  for (const e of [copy, ...copy.querySelectorAll('*')]) for (const a of ['id', 'aria-labelledby', 'aria-controls', 'aria-describedby']) e.removeAttribute(a)
  return copy.outerHTML
}
const inner = (el: Element) => clean(el).replace(/^<[^>]+>/, '').replace(/<\/[a-z]+>$/, '')

/** The answer's text as the chat draws it (chat/Rows.tsx): the inside of its .chat-text. */
async function answer(checks: MarkItem[], marks?: AnswerMark[]): Promise<HTMLElement> {
  const el = await mount(
    <ChipContext.Provider value={{ workspace: '', broken: new Set(), anchor: true }}>
      <div className="chat-text">
        <ChatMarkdown text={ANSWER} checks={checks} marks={marks} />
      </div>
    </ChipContext.Provider>,
  )
  return el.querySelector<HTMLElement>('.chat-text')!
}

/** The label each mark in `el` opens on a click, in order. */
async function popsOf(el: HTMLElement): Promise<string[]> {
  const out: string[] = []
  for (const words of el.querySelectorAll<HTMLElement>('.mark .mark-words')) {
    await act(async () => void words.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await settle()
    await settle()
    const pop = document.querySelector<HTMLElement>('.refchip-pop.mark-pop')!
    const copy = pop.cloneNode(true) as HTMLElement
    copy.removeAttribute('style')
    out.push(clean(copy))
    await act(async () => void words.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  }
  return out
}

async function draw(): Promise<Record<string, string | Record<string, string>>> {
  const out: Record<string, string> = {}
  const pops: Record<string, string> = {}
  out.chatChecking = inner(await answer(CHECKING))
  unmountAll()
  const checked = await answer(CHECKED)
  out.chatChecked = inner(checked)
  ;(await popsOf(checked)).forEach((p, k) => (pops[`chat:${k}`] = p))
  unmountAll()
  const explained = await answer(CHECKED, [TINT])
  out.chatExplained = inner(explained)
  await mount(<AnswerCommentPop comment={EXPLAINER} ws="" anchor={EXPLAINER.ref} onDone={async () => undefined} onClose={() => undefined} />)
  const pop = document.querySelector<HTMLElement>('.answer-cm-pop')!.cloneNode(true) as HTMLElement
  pop.removeAttribute('style')
  out.chatComment = clean(pop)
  unmountAll()
  out.chatFoot = clean((await mount(<MarksFooter items={CHECKED} />)).firstElementChild!)
  unmountAll()

  // the card's takeaway, as the Canvas draws it (canvas/CardFace.tsx): each citation a mark of the card's place
  const card = await mount(
    <ChipContext.Provider value={{ workspace: '', broken: new Set(), anchor: true }}>
      <div data-cite-home={CARD}>
        <div className="chat-text bcell-take-text">
          <ChatMarkdown text={TAKEAWAY} checks={[]} />
        </div>
      </div>
    </ChipContext.Provider>,
  )
  const take = card.querySelector<HTMLElement>('.bcell-take-text')!
  out.cardTakeaway = inner(take)
  const refs = [...take.querySelectorAll('.mark')].map((m) => m.getAttribute('data-ref')!)
  ;(await popsOf(take)).forEach((p, k) => (pops[refs[k]] = p))
  unmountAll()

  const side = await mount(<LabelsSidebar ws="tour" section="labels" onClose={() => undefined} />)
  await settle()
  await settle()
  out.labelsSide = clean(side.querySelector('aside.lside')!)
  unmountAll()

  const colorBy = await mount(
    <ColorBy choice={{ by: 'label', id: LABEL.id }} keys={[]} labels={[]} values={[]} off={[]} onChoose={() => undefined} onToggle={() => undefined} countsOf={() => undefined} />,
  )
  out.colorBySource = clean(colorBy.querySelector('.colorby-src')!)
  unmountAll()
  return { ...out, pops }
}

// ---------- where each part stands in examples.json

type Examples = Record<string, string | Record<string, string>>
const parse = (html: string) => {
  const t = document.createElement('template')
  t.innerHTML = html
  return t.content
}
const serialize = (f: DocumentFragment) => [...f.childNodes].map((n) => (n as Element).outerHTML ?? n.textContent).join('')

/** The parts of examples.json this file draws, read from it as the tour reads them. */
function partsIn(ex: Examples): Record<string, string | Record<string, string>> {
  const card = parse(ex.card as string)
  const reader = parse(ex.txReader as string)
  return {
    chatChecking: ex.chatChecking,
    chatChecked: ex.chatChecked,
    chatExplained: ex.chatExplained,
    chatComment: ex.chatComment,
    chatFoot: ex.chatFoot,
    cardTakeaway: card.querySelector('.bcell-take-text')?.innerHTML ?? '',
    labelsSide: ex.labelsSide,
    colorBySource: reader.querySelector('.colorby-src')?.outerHTML ?? '',
    pops: ex.pops,
  }
}

/** examples.json with the drawn parts in place. */
function withParts(ex: Examples, d: Record<string, string | Record<string, string>>): Examples {
  const card = parse(ex.card as string)
  card.querySelector('.bcell-take-text')!.innerHTML = d.cardTakeaway as string
  const reader = parse(ex.txReader as string)
  reader.querySelector('.colorby-src')?.remove()
  reader.querySelector('.colorby > .colorby-trigger')!.insertAdjacentHTML('afterend', d.colorBySource as string)
  const { cardTakeaway: _c, colorBySource: _s, ...own } = d
  const next: Examples = { ...ex, ...own, card: serialize(card), txReader: serialize(reader) }
  // what the tour no longer reads: the old Files sidebar's labels, and the citations' labels before marks
  delete next.txLabels
  delete next.popsPlain
  return next
}

test("the tour's examples are what the current components draw", async () => {
  const drawn = await draw()
  const ex = JSON.parse(readFileSync(FILE, 'utf8')) as Examples
  if (CAPTURE) writeFileSync(FILE, JSON.stringify(withParts(ex, drawn)))
  const now = CAPTURE ? (JSON.parse(readFileSync(FILE, 'utf8')) as Examples) : ex
  expect(partsIn(now)).toEqual(drawn)
  expect(now.txLabels).toBeUndefined()
  expect(now.popsPlain).toBeUndefined()
  // the drawn answer holds what the tour shows: three checked citations, the last one failed, and the explainer's tint
  const answer = parse(drawn.chatExplained as string)
  expect([...answer.querySelectorAll('.mark')].map((m) => m.getAttribute('data-mark-look'))).toEqual(['verified', 'verified', 'failed'])
  expect(answer.querySelector('mark.answer-tint')?.textContent).toBe('UK time')
  expect(parse(drawn.chatChecking as string).querySelectorAll('.mark.is-checking .mark-spin')).toHaveLength(3)
})
