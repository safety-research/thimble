// The Checks view (SPEC-v2 J7, 3.12): the checks' comments on passages of Claude's answers (C13 `answerComments`, read by
// the transcript's lane from `thimble state answer-comments`), one at a time:
//
//   home › checks › Important details                                    ‹ 1 of 2 ›  ↗
//   on your answer at 4:06 PM · it looks for what a reader would likely miss
//   ───────────────────────────────────────────────────────────────────────────────
//   ⚑ passage   After 19 June there are 0 new messages to other agents on any page.
//     comment   The label could not read 899 revisions whose text the dump hides …
//
//   put in the prompt   dismiss   open in the browser
// ─────────────────────────────────────────────────────────────────────────────────
// ❯ ask about this comment
//
// ─────────────────────────────────────────────────────────────────────────────────
//
// The entry box (entry.tsx) asks a side thread about the passage, told the comment (`a` gives it the keys); `m` puts a
// draft in the prompt (nothing is sent); `d` dismisses the comment (`thimble act answer-comment-resolve`): its tint and
// flag go and the view moves to the next one; `o` and the title row's `↗` open the comment in the browser
// (`answer:<turn>#s<n>`); `n` and `p` step. While a comment
// shows, `$.state.checksOpen` names it (the transcript lights its passage more). With no open comment the view lists the
// checks (`thimble state checks`): each one's name, on or off, and its comments; `o` opens the browser's Checks pane.
import type { RenderElement } from 'claude-code'

import type { AnswerComment, TermPanel } from './types'
import { markSeen, hiddenComments, openComments } from './band'
import { MARGIN_W, controlsEl, fieldEls, headerEls, marginKey, pointed, setBrowser, spread, subLine } from './chrome'
import type { Ctx } from './ctx'
import { act } from './data'
import type { Line, Seg } from './draw'
import { hueOf } from './labels'
import { plainCites } from './cite'
import { clip, noControls, quoted } from './lib'
import { linesEl } from './lines'
import { COLORS } from './paint'
import type { PaneEvent } from './panel'
import { askEntry, askKey, drawsView, entryBottom, hiddenKeys, hintsRow, none } from './panel'
import type { AskOver } from './panel'
import { checksOf } from './report'
import { loadsView, openPanel, readSurface, rt, surfaceValue } from './term'
import { openInBrowser } from './offramp'

/** The flag a commented passage carries in the reply's margin (the transcript's paint.ts FLAG). */
export const FLAG = '⚑'
/** The most characters of a passage or a comment a draft in the prompt quotes, on one line (SPEC-v2 S20). */
const QUOTE_MAX = 80

const dim = (s: string): Seg => ({ s, fg: COLORS.dim })

/** When a comment was made, as the view says it (`4:06 PM`). */
export function timeWords(at: string): string {
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return ''
  return new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

/** Words quoted into the prompt: one line, cut at QUOTE_MAX characters. */
function oneLine(s: string): string {
  return clip(noControls(s).replace(/\s+/g, ' ').trim(), QUOTE_MAX)
}

/** The draft `m` puts in the prompt, which the person edits before sending. */
export function promptDraft(c: AnswerComment): string {
  const when = timeWords(c.at)
  return `About "${oneLine(c.quote)}" in your answer${when ? ` at ${when}` : ''}, the ${oneLine(c.checkName)} check says: "${oneLine(c.text)}"`
}

// the comment the view shows, by its id ('' for the first open one)
let shownId = ''

/** The Checks view opened in the panel (SPEC-v2 C13), on comment `commentId` when given, else on the first open one;
 *  the checks' `new` cleared. */
export async function openChecks(cx: Ctx, commentId?: string): Promise<void> {
  const open = await openComments(cx)
  const c = open.find(x => x.id === commentId) ?? open.find(x => x.id === shownId) ?? open[0]
  shownId = c?.id ?? ''
  await markSeen(cx, ['checks'])
  await cx.setChecksOpen(c?.id ?? null)
  await openPanel(cx, { view: 'checks', title: c ? noControls(c.checkName) : 'Checks', ...(c ? { mode: 'comment' } : {}) })
}

/** A check's words as read: citations as their words or `[ chip ]` (plainCites), no `**` or backticks of Markdown. */
const prose = (s: string): string => plainCites(noControls(s)).replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1')

/** The view moved to comment `c` (n, p, a dismiss), its step's title that comment's check, in place of the step. */
async function stepTo(cx: Ctx, c: AnswerComment | undefined): Promise<void> {
  shownId = c?.id ?? ''
  await cx.setChecksOpen(c?.id ?? null)
  const p = await cx.panel()
  await openPanel(cx, { ...(p ?? { view: 'checks' }), view: 'checks', title: c ? noControls(c.checkName) : 'Checks', ...(c ? { mode: 'comment' } : { mode: '' }) }, { replace: true })
}

/** A comment dismissed (`thimble act answer-comment-resolve`): gone at once, the view on the next one. */
async function dismiss(cx: Ctx, c: AnswerComment): Promise<void> {
  if (!rt.sc) return
  const before = await openComments(cx)
  const at = before.findIndex(x => x.id === c.id)
  const got = await act(cx, rt.sc, 'answer-comment-resolve', { comment: c.id, reopen: false })
  if (!got.ok) return cx.toast(`thimble: the comment was not dismissed: ${got.error}`)
  hiddenComments.add(c.id)
  const left = await openComments(cx)
  await markSeen(cx, ['checks'])
  await stepTo(cx, left[Math.min(at, left.length - 1)])
}

/** What a side thread about a comment is told: its passage, and the comment. */
function askOver(c: AnswerComment): AskOver {
  const quote = noControls(c.quote)
  return { anchor: c.ref, anchorText: `${quote}\n\nThe ${noControls(c.checkName)} check's comment on this passage of the answer: ${noControls(c.text)}`, element: c.ref, about: `comment ${quoted(clip(noControls(c.text), 50))}` }
}

async function loadChecks(cx: Ctx): Promise<void> {
  // the checks, which the view lists when no comment is open
  await readSurface(cx, 'checks', 'checks')
}

async function drawChecks(cx: Ctx, e: PaneEvent, _p: TermPanel): Promise<RenderElement> {
  const els = cx.els(e)
  const { Box, Text, Button } = els
  const cols = Math.max(30, e.props.bodyColumns)
  const open = await openComments(cx)
  const i = Math.max(0, open.findIndex(x => x.id === shownId))
  const c = open[i]
  if (!c) return drawCheckList(cx, e, cols, open)
  setBrowser(c.ref)
  const hue = hueOf(c.color || 2)
  const when = timeWords(c.at)
  const prev = () => (i > 0 ? stepTo(cx, open[i - 1]) : undefined)
  const next = () => (i < open.length - 1 ? stepTo(cx, open[i + 1]) : undefined)
  // `‹ 1 of 2 ›` against R on the title row: an arrow a click away where there is a comment to step to, else dim (n and
  // p step too)
  const arrow = (key: string, words: string, go: (() => unknown) | null) =>
    go ? <Button key={key} plain onPress={() => void go()}><Text color={COLORS.link}>{words}</Text></Button> : <Text key={key} dimColor>{words}</Text>
  const right = (
    <Box key="checks-page" flexDirection="row">
      {arrow('checks-prev', '‹ ', i > 0 ? prev : null)}
      <Text>{` ${i + 1} of ${open.length} `}</Text>
      {arrow('checks-next', ' ›', i < open.length - 1 ? next : null)}
    </Box>
  )
  const body: RenderElement[] = [...headerEls(els as never, { title: noControls(c.checkName), cols, right, sub: subLine([`on your answer${when ? ` at ${when}` : ''}`, noControls(c.about)]) })]
  // the passage with the check's flag in its color, the comment, its details
  const rows: [string, RenderElement | string, string?][] = [
    ['passage', <Text wrap="wrap">{prose(c.quote)}</Text>],
    ['comment', <Text wrap="wrap">{prose(c.text)}</Text>],
    ...(c.details ? [['details', <Text dimColor wrap="wrap">{prose(c.details)}</Text>] as [string, RenderElement]] : []),
  ]
  body.push(
    <Box key={marginKey('checks-comment')} flexDirection="row">
      <Box width={MARGIN_W} flexShrink={0} flexDirection="column">
        <Text color={hue}>{`${FLAG} `}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="column">
        {fieldEls(els as never, rows, 'checks')}
      </Box>
    </Box>,
  )
  const draft = () => void cx.fill(promptDraft(c))
  const browse = () => void openInBrowser(cx, c.ref)
  // the entry box, whose question starts a side thread about the passage, told the comment
  const askAt = `ask-check-${c.id}`
  const entry = e.surface === 'mobile' ? null : askEntry(cx, e, { key: askAt, placeholder: 'ask about this comment', cols, target: { kind: 'sentence', text: noControls(c.quote) }, over: askOver(c) })
  const acts = controlsEl(els as never, [
    <Button key="checks-prompt" label="put in the prompt" plain onPress={draft} />,
    <Button key="checks-dismiss" label="dismiss" plain onPress={() => void dismiss(cx, c)} />,
    <Button key="checks-browser" label="open in the browser" plain onPress={browse} />,
  ], 'checks-acts')
  const hints = [...(entry ? ['a to ask'] : []), 'm to put it in the prompt', 'd to dismiss', 'o to open in the browser', ...(open.length > 1 ? ['n p for the next or previous'] : []), 'b to go back', 'x to close']
  if (entry) body.push(...entryBottom(cx, e, cols, [acts], entry, hints))
  else body.push(acts!, hintsRow(els as never, hints, cols))
  const hk = hiddenKeys(cx, e, [
    ...(entry ? [{ ...askKey(cx, askAt), key: 'checks-a' }] : []),
    { key: 'checks-m', hotkey: 'm', onPress: draft },
    { key: 'checks-d', hotkey: 'd', onPress: () => void dismiss(cx, c) },
    { key: 'checks-n', hotkey: 'n', onPress: () => void next() },
    { key: 'checks-p', hotkey: 'p', onPress: () => void prev() },
  ])
  return <Box flexDirection="column">{[...(hk ? [hk] : []), ...body]}</Box>
}

/** No open comment: the checks, each one's name in its color, on or off, and its comments on answers. */
async function drawCheckList(cx: Ctx, e: PaneEvent, cols: number, open: readonly AnswerComment[]): Promise<RenderElement> {
  const els = cx.els(e)
  const { Box } = els
  setBrowser('checks')
  const got = await surfaceValue(cx, 'checks')
  const checks = checksOf(got?.ok ? got.value : [])
  const running = (await cx.checksRunning()) > 0
  const body: RenderElement[] = [...headerEls(els as never, { title: 'Checks', cols, sub: subLine(['no comment on an answer is open', running ? '◌ a check reads an answer' : '']) })]
  const lines: Line[] = checks.map(k => {
    const n = open.filter(x => x.check === k.id).length
    return pointed(spread([{ s: '●', fg: hueOf(k.colour) }, { s: ' ' }, { s: noControls(k.name) }], [dim(`${k.shown ? 'on' : 'off'}${n ? ` · ${n} open comment${n === 1 ? '' : 's'}` : ''}`)], cols), false)
  })
  body.push(lines.length ? linesEl(cx, e, marginKey('checks-list'), lines, [], cols + MARGIN_W) : none(cx, e, got ? 'no checks' : '◌ reading the checks'))
  body.push(hintsRow(els as never, ['o to open the Checks pane in the browser', 'b to go back', 'x to close'], cols))
  return <Box flexDirection="column">{body}</Box>
}

/** The Checks view's read and drawing registered with the panel (views.ts registerPanelViews). */
export function registerChecksView(): void {
  loadsView('checks', loadChecks)
  drawsView('checks', drawChecks)
}
