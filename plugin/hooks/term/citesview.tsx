// The Citations view (SPEC-v2 3.8, 3.10): every citation of this session from two sources, the problems first. The
// chat's citations (C13 `citeIndex`, one row per citation main's chat drew, its verdict in `verdicts`) and each card's
// links check (the card data the panel loads: `verification.links` broken, typed and quiet, each with its why). Order:
// refuted (a script got another value) and missing, then differs, typed and quiet, then pending, then ok. A row:
// `value · place · verdict`, and `card <n>` for a card's. Enter opens the existing citation view (a card's row: the
// card); `o` and the title row's `↗` open the browser at the cited place.
import type { RenderElement } from 'claude-code'

import type { TermPanel } from './types'
import { MARGIN_W, headerEls, marginKey, pointed, setBrowser, spread, subLine } from './chrome'
import type { Ctx } from './ctx'
import { placeWords } from './draw'
import type { Line, Seg } from './draw'
import { cid, clip, labelRef, noControls, width } from './lib'
import { linesEl } from './lines'
import type { LineHit } from './lines'
import { COLORS } from './paint'
import type { PaneEvent } from './panel'
import { drawsView, hintHeight, hintsRow, none, openCard, openCite, paneRows, windowList } from './panel'
import { linkCheck } from './reply'
import { checkQueued, loadsView, navOrigin, openPanel, queueCitations, rt } from './term'

/** How a citation stands, in the view's order. */
export type CiteVerdict = 'refuted' | 'missing' | 'differs' | 'typed' | 'quiet' | 'pending' | 'ok'
const ORDER: readonly CiteVerdict[] = ['refuted', 'missing', 'differs', 'typed', 'quiet', 'pending', 'ok']

/** A row of the view: the value, the cited ref, how it stands and why, the card it is on (a card's links check, with its
 *  number among the session's cards), and the chat citation's raw spelling. */
export type CiteItem = { key: string; value: string; ref: string; verdict: CiteVerdict; why: string; card?: string; n?: number; raw?: string }

const num = (n: number) => Math.round(n).toLocaleString('en-US')
const dim = (s: string): Seg => ({ s, fg: COLORS.dim })

/** The value and the ref of a links check's key (`<value>|<ref>`). */
function splitKey(key: string): { value: string; ref: string } {
  const at = key.indexOf('|')
  return at < 0 ? { value: '', ref: key } : { value: key.slice(0, at), ref: key.slice(at + 1) }
}

/** Every citation of the session, the problems first (see the file's head). */
export async function citeItems(cx: Ctx): Promise<CiteItem[]> {
  const out: CiteItem[] = []
  const seen = new Set<string>()
  for (const c of await cx.citeIndex()) {
    const id = cid(c.raw)
    if (seen.has(id) || labelRef(c.ref)) continue
    seen.add(id)
    const v = await cx.verdict(id)
    const card = /^(?:card|cell):([A-Za-z0-9_-]+)/.exec(c.ref)?.[1]
    const check = card ? linkCheck((await cx.card(card))?.links, { raw: c.raw, ref: c.ref, display: c.display }) : {}
    const verdict: CiteVerdict = check.state === 'refuted' ? 'refuted' : v?.status === 'missing' ? 'missing' : v?.status === 'differs' ? 'differs' : check.state === 'typed' ? 'typed' : !v || v.status === 'pending' ? 'pending' : 'ok'
    const why = check.state === 'refuted' ? (check.source ? `a script got ${check.source}` : check.why ?? '') : verdict === 'typed' ? check.why ?? '' : v?.why ?? ''
    out.push({ key: `chat:${id}`, value: c.display ?? '', ref: c.ref, verdict, why: noControls(why), raw: c.raw })
  }
  let n = 0
  for (const id of rt.shown) {
    const tc = await cx.card(id)
    n++
    const l = tc?.links as (NonNullable<typeof tc>['links'] & { quiet?: { key?: string; why?: string }[] }) | undefined
    if (!l) continue
    for (const b of l.broken) out.push({ key: `card:${id}:${b.key}`, ...splitKey(b.key), verdict: b.source ? 'refuted' : 'missing', why: noControls(b.source ? `a script got ${b.source}` : b.why), card: id, n })
    for (const t of l.typed ?? []) out.push({ key: `card:${id}:${t.key}`, ...splitKey(t.key), verdict: 'typed', why: noControls(t.why), card: id, n })
    for (const q of Array.isArray(l.quiet) ? l.quiet : []) out.push({ key: `card:${id}:${String(q.key ?? '')}`, ...splitKey(String(q.key ?? '')), verdict: 'quiet', why: noControls(String(q.why ?? '')), card: id, n })
  }
  return out.map((it, i) => ({ it, i })).sort((a, b) => ORDER.indexOf(a.it.verdict) - ORDER.indexOf(b.it.verdict) || a.i - b.i).map(x => x.it)
}

/** A verdict's glyph and words: `×` red for a value that is not there, `!` red for one no script checked, `◌` while it
 *  is checked, `✓` once found. */
function verdictLook(it: CiteItem): { glyph: Seg; words: string } {
  switch (it.verdict) {
    case 'refuted':
      return { glyph: { s: '×', fg: COLORS.problem }, words: it.why || 'a script got another value' }
    case 'missing':
      return { glyph: { s: '×', fg: COLORS.problem }, words: it.why || 'not found' }
    case 'differs':
      return { glyph: { s: '×', fg: COLORS.problem }, words: it.why || 'the place shows another value' }
    case 'typed':
      return { glyph: { s: '!', fg: COLORS.problem }, words: it.why || 'typed in, not computed' }
    case 'quiet':
      return { glyph: { s: '!', fg: COLORS.problem }, words: it.why || 'not checked' }
    case 'pending':
      return { glyph: { s: '◌' }, words: 'checking' }
    default:
      return { glyph: { s: '✓' }, words: 'found' }
  }
}

/** A cited place in words: a card's cell by its column and row (`merged agent-02`), its output by its lines, a file's
 *  line as draw.ts placeWords says it. */
export function citePlace(ref: string): string {
  const cell = /^(?:card|cell):[A-Za-z0-9_-]+#([^/]+)\/(.+)$/.exec(ref)
  if (cell) return `${cell[1]} ${cell[2]}`
  const out = /^(?:card|cell):[A-Za-z0-9_-]+@out\d*#L(\d+)(?:-L?(\d+))?$/.exec(ref)
  if (out) return out[2] && out[2] !== out[1] ? `output lines ${out[1]}-${out[2]}` : `output line ${out[1]}`
  if (/^(?:card|cell):[A-Za-z0-9_-]+$/.test(ref)) return 'the card'
  return placeWords(ref)
}

/** The rows as lines in `cols`: the glyph at A0, `value · place · verdict` at A2, `card <n>` dim at R. */
export function citeLines(items: readonly CiteItem[], pick: string, cols: number): { lines: Line[]; hits: { y: number; key: string }[] } {
  const lines: Line[] = []
  const hits: { y: number; key: string }[] = []
  for (const it of items) {
    const look = verdictLook(it)
    const bad = it.verdict !== 'ok' && it.verdict !== 'pending'
    const right: Line = it.card ? [dim(`card ${it.n}`)] : []
    const room = cols - 2 - (right.length ? width(`card ${it.n}`) + 2 : 0)
    const value = noControls(it.value) || '(no words)'
    const place = noControls(citePlace(it.ref))
    const left: Line = [look.glyph, { s: ' ' }, { s: clip(value, 24), ...(bad ? { fg: COLORS.problem } : {}) }, dim(` · ${clip(place, Math.max(10, room - width(value) - 6 - Math.min(40, width(look.words))))} · `), bad ? { s: look.words } : dim(look.words)]
    hits.push({ y: lines.length, key: it.key })
    lines.push(pointed(spread(left, right, cols), it.key === pick))
  }
  if (!items.length) lines.push(pointed([{ s: '  ' }, dim('no citations in this session yet')], false))
  return { lines, hits }
}

// the row the keys chose
let citePick = ''

/** The Citations view opened in the panel (SPEC-v2 C13), the row of `pick` (a ref) chosen when given. */
export async function openCitations(cx: Ctx, pick?: string): Promise<void> {
  if (pick) citePick = pick
  await openPanel(cx, { view: 'citations', title: 'Citations' })
}

/** The chat's citations checked where no verdict is kept yet (term.ts resolves them in one batch). */
async function loadCitations(cx: Ctx): Promise<void> {
  queueCitations((await cx.citeIndex()).map(c => ({ raw: c.raw, ref: c.ref, display: c.display })))
  await checkQueued(cx)
}

async function drawCitations(cx: Ctx, e: PaneEvent, _p: TermPanel): Promise<RenderElement> {
  const els = cx.els(e)
  const { Box } = els
  const cols = Math.max(30, e.props.bodyColumns)
  const items = await citeItems(cx)
  const ok = items.filter(x => x.verdict === 'ok').length
  const bad = items.filter(x => x.verdict !== 'ok' && x.verdict !== 'pending').length
  const sub: (string | Seg)[] = [`${num(items.length)} citation${items.length === 1 ? '' : 's'}`, ok ? `✓${num(ok)}` : '', bad ? { s: `×${num(bad)}`, fg: COLORS.problem } : '']
  const body: RenderElement[] = [...headerEls(els as never, { title: 'Citations', cols, sub: subLine(sub) })]
  // a pick given by its ref (openCitations) or by its row's key
  const chosen = items.find(x => x.key === citePick) ?? items.find(x => x.ref === citePick) ?? items[0]
  const pick = chosen?.key ?? ''
  if (chosen) setBrowser(chosen.ref)
  const open = async (it: CiteItem) => {
    await navOrigin(cx, true)
    if (it.card) return openCard(cx, it.card)
    return openCite(cx, it.ref, it.value || null)
  }
  const lay = citeLines(items, pick, cols)
  const step = (d: number) => {
    const at = items.findIndex(x => x.key === pick)
    citePick = items[Math.max(0, Math.min(items.length - 1, at + d))]?.key ?? ''
    return cx.bumpPanel()
  }
  const hits: LineHit[] = lay.hits.map(h => ({ y: h.y, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: () => {
    citePick = h.key
    const it = items.find(x => x.key === h.key)
    return it ? open(it) : undefined
  } }))
  const hints = [...(items.length ? ['↑↓ to choose', 'Enter to open its place', 'o to open it in the browser'] : []), 'b to go back', 'x to close']
  const room = paneRows() - 1 - body.length - hintHeight(hints, cols)
  const win = windowList('citations-list', lay.lines, hits, items.findIndex(x => x.key === pick), room, () => cx.bumpPanel())
  const onKey = (k: string) => {
    if (k === 'up' || k === 'k') return step(-1)
    if (k === 'down' || k === 'j') return step(1)
    if ((k === 'return' || k === 'enter') && chosen) return open(chosen)
    return undefined
  }
  body.push(items.length ? linesEl(cx, e, marginKey('citations-list'), win.lines, win.hits, cols + MARGIN_W, onKey) : none(cx, e, 'no citations in this session yet'))
  body.push(hintsRow(els as never, hints, cols))
  return <Box flexDirection="column">{body}</Box>
}

/** The Citations view's read and drawing registered with the panel (views.ts registerPanelViews). */
export function registerCitationsView(): void {
  loadsView('citations', loadCitations)
  drawsView('citations', drawCitations)
}
