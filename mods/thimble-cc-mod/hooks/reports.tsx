// Reports: a writer subagent ("report · writing <title>") writes a report of the work under .thimble-cc-mod/reports/,
// of one of the types report.ts registers (a document unless the analyst names another, such as slides or an
// interactive story), started from a prompt (main's `report` tool, /thimble-report), from an answer ("open as report"
// makes the answer a document at once, no model call), or from a report (the types' retell buttons). The panel draws
// each type by its renderer: a document as a page with its contents, toggles and callouts, drawn as main's chat draws a
// reply; slides one at a time (‹ ›, b and n); a story stepped through beat by beat, its figure lit at each beat's
// step. Citations are chips and cards are drawn as in any reply (register.tsx drawReply), so citations work in them,
// and:
//
// - "?" beside any passage (a paragraph, a list item, a callout, a table, a card) starts a side thread told where the
//   passage stands: the report, its file and its section.
// - "verify" beside a section's heading (and "verify all") has subagents check every citation of it: a value is
//   recomputed by a script the mod runs, a citation without one is judged by reading its place. Each chip shows its
//   state (a spinner, ✓, red ✗), the heading and the contents a tally.
// - main's `report_highlight` tool (the analyst asks in the chat) has a subagent mark the passages the analyst's words
//   name, each with the place that shows it: a `●` in the set's hue beside the passage, its reason under it (`↗` opens
//   the place), and a one-line legend of the sets.
//
// register.tsx hands this module what it shares (ReportCtx) and calls it from its own hooks: the panel's views, the
// subagents' progress (session.append) and ends (turn.complete), the page row's keys (ui.message).
import type { Elements, MatchedEvent, ProcessRunInit, RenderElement, ResolveInput } from 'claude-code'

import type { ChatAgent, ChatHighlight, ChatReport, ChatReportNav, ChatVerify } from '../types'
import type { Focus } from './anim'
import { claimsIn, plainCites } from './cite'
import type { Claim } from './cite'
import type { CardData, Line } from './draw'
import { ACCENT, FRESH, LINK, MARGIN_W, headerEls, hintsEl, lineEl, marginKey, pointed, ruleEl, spread, subLine } from './chrome'
import { clip } from './lib'
import { COLORS, SERIES } from './paint'
import { TYPES, buttonRows, calloutOf, docSegments, fitCard, formProblems, guessType, headingKey, highlightLabel, highlightPrompt, isForm, parseMarks, parseVerdicts, passageKey, reportCards, reportPassages, reportSections, sectionOfHeading, settleType, slidesOf, slugOf, splitTitle, stepCount, stepFocus, storyOf, textRows, tocOf, typeOf, verifyPrompt, wrapRows } from './report'
import type { ReportForm, Section, VerifyItem } from './report'
import { withGuide, withoutTaskLine } from './threads'

type PaneEvent = MatchedEvent<'ui.render', { component: 'Pane'; requestId: string }>
type Spawned = { agentId: string; engine: string } | { deny: string }

/** How register.tsx's drawReply draws a report's text: the line that tells a side thread where a passage stands (from
 *  its section's heading line, '' before any), what stands right of a heading line, a highlighted passage's bar colour
 *  and the rows under it (`words` as drawReply hands its "?"), and list items asked about one by one. */
export type ReplyOpts = {
  /** the columns left of the text: a reply's 4 (⏺, a space, "?", a space), a panel's 2 (its margin M) */
  margin?: number
  where?: (heading: string) => string
  tools?: (line: string) => RenderElement | null
  mark?: (words: string) => { color: string; under: RenderElement[] } | null
  items?: boolean
}

/** What register.tsx shares with the reports, bound to the `$` of the hook at hand: `$` is followed only into
 *  functions of the hooks module's own file, so this module reaches the engine through these (register.tsx reportCtx). */
export type ReportCtx = {
  home: string
  panel: string
  margin: number
  now: () => Promise<number>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  /** a file's mtime; throws when it does not exist */
  mtime: (path: string) => Promise<number>
  list: (dir: string) => Promise<string[]>
  run: (argv: string[], init: ProcessRunInit) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  report: (slug: string) => Promise<ChatReport | undefined>
  setReport: (r: ChatReport) => Promise<void>
  agent: (id: string) => Promise<ChatAgent | undefined>
  setAgent: (id: string, a: ChatAgent) => Promise<void>
  nav: () => Promise<ChatReportNav | null>
  setNav: (nav: ChatReportNav) => Promise<void>
  els: (e: ResolveInput) => Elements['terminal']
  scroll: (key: string, block?: 'start' | 'center') => Promise<void>
  where: () => Promise<{ cwd: string; root: string }>
  guide: () => Promise<string>
  drawReply: (e: ResolveInput, text: string, width: number, answer: string, prefix?: string, opts?: ReplyOpts) => Promise<RenderElement[]>
  /** `data`: the card as drawn, such as a slide's card cut to the rows that fit */
  cardEl: (e: ResolveInput, id: string, width: number, key: string, focus?: Focus, data?: CardData) => Promise<RenderElement>
  loadCard: (id: string) => Promise<CardData | null>
  openPane: (view: 'report' | 'reports', title: string) => Promise<void>
  closePanel: () => Promise<void>
  spawn: (prompt: string, desc: string, fresh: string) => Promise<Spawned>
  noteMain: (text: string) => Promise<void>
  /** a part drawn from styled lines (homeview.tsx): its hits run their closures on a click, its keys go to `onKey` */
  link: (e: ResolveInput, key: string, lines: Line[], hits: { y: number; x0: number; x1: number; row: boolean; run: () => Promise<void> | void }[], cols: number, onKey?: (k: string) => Promise<void> | void) => RenderElement
  /** a card in its frame as the mod draws it itself (register.tsx framedCard) */
  framed: (e: ResolveInput, card: CardData, w: number, lines?: Line[], key?: string) => RenderElement
  /** code as Claude Code colours it, with a gutter of line numbers from `startLine` */
  code: (e: ResolveInput, source: string, max?: number, language?: string, startLine?: number) => RenderElement
  /** a side thread about something, in the panel */
  thread: (about: { label: string; context: string }) => Promise<void>
  /** check a text's citations (their chips show the verdicts) and count those that fail */
  checkCites: (text: string) => Promise<number>
  /** run `fn` once main's turn has ended (at once when none runs): a subagent started inside main's turn would hold
   *  the turn open until it ends */
  afterTurn: (fn: () => Promise<void>) => Promise<void>
  /** a report's claims known to the citation panel, each one's verification state (by its claim's key), the mod's run
   *  of a verification script, and a place opened in the citation panel */
  remember: (cls: Claim[]) => void
  verifyOf: (key: string) => Promise<ChatVerify | undefined>
  setVerify: (key: string, v: ChatVerify) => Promise<void>
  runVerify: (key: string) => Promise<void>
  openRef: (ref: string) => Promise<void>
}


export const REPORT_TOOL = 'mcp__thimble-cc-mod__report'
export const TOOL_DESCRIPTION = [
  "Start thimble-cc-mod's writer: a subagent that writes a report of the work for the analyst, outside this conversation, while the analyst watches it in the panel.",
  `Types (form): ${TYPES.map(t => `${t.id}, ${t.blurb}`).join('; ')}.`,
  `Write a document unless the analyst names another type; ${TYPES.filter(t => t.onRequest).map(t => t.id).join(' and ')} only when they ask for one.`,
  'Call it when the analyst asks for a report, a write-up, a deck, a story or a page of the findings, and do not write it yourself. It returns at once; thimble-cc-mod tells you when the writer is done.',
].join(' ')
export const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    form: { type: 'string', enum: TYPES.map(t => t.id), description: 'the type the analyst asked for; document when they named none' },
    title: { type: 'string', description: 'a short working title in the analyst\'s words, such as "What happened in the wiki"' },
    request: { type: 'string', description: "the analyst's request, in their words" },
  },
  required: ['request'],
}
export const REPORT_COMMAND_DESCRIPTION = `Have a writer make a report of the work, shown in the panel: /thimble-report [${TYPES.map(t => t.id).join('|')}] <what you want>`

export const HIGHLIGHT_TOOL = 'mcp__thimble-cc-mod__report_highlight'
export const HIGHLIGHT_DESCRIPTION = [
  'Highlight passages of a thimble-cc-mod report, such as "highlight where the agents coordinate": a subagent finds the passages the words apply to and the evidence for each, outside this conversation, and the panel marks them in a colour with a legend; each mark opens its evidence.',
  'Call it when the analyst asks to highlight, mark or find something in a report. It returns at once.',
].join(' ')
export const HIGHLIGHT_SCHEMA = {
  type: 'object',
  properties: {
    request: { type: 'string', description: "what to highlight, in the analyst's words" },
    report: { type: 'string', description: 'the report\'s file name without .md; leave it out for the report the panel shows' },
  },
  required: ['request'],
}

/** The type a request names in words, else a document. */
export const guessForm = guessType

const ALIASES: Record<string, ReportForm> = { doc: 'document', report: 'document', page: 'document', deck: 'slides', 'case file': 'casefile' }

/** `/thimble-report [type] <request>`: the type named first (or in the words), and the request. */
export function parseReportArgs(args: string): { form: ReportForm; request: string } {
  const m = /^\s*([a-z]+(?: file)?)\b[\s:,-]*/i.exec(args)
  const word = m?.[1]?.toLowerCase() ?? ''
  const id = ALIASES[word] ?? (isForm(word) ? word : '')
  if (!m || !id) return { form: guessType(args), request: args.trim() }
  return { form: id, request: args.slice(m[0].length).trim() || args.trim() }
}

// ------------------------------------------------------------------------------------------------ the record

const texts = new Map<string, { mtime: number; text: string }>()

async function readText(ctx: ReportCtx, file: string): Promise<string> {
  const { cwd } = await ctx.where()
  const path = `${cwd}/${file}`
  let mtime = 0
  try {
    mtime = await ctx.mtime(path)
  } catch {
    return ''
  }
  const hit = texts.get(path)
  if (hit && hit.mtime === mtime) return hit.text
  let text = ''
  try {
    text = await ctx.read(path)
  } catch {
    text = ''
  }
  texts.set(path, { mtime, text })
  return text
}

function parseRecord(raw: string): ChatReport | null {
  try {
    const r = JSON.parse(raw) as Partial<ChatReport>
    if (!r || typeof r.slug !== 'string' || typeof r.file !== 'string') return null
    // a writer still running when its session ended never finished
    const state = r.state === 'writing' ? 'error' : (r.state ?? 'ready')
    return { slug: r.slug, form: r.form ?? 'document', title: r.title ?? r.slug, request: r.request ?? '', file: r.file, state, ...(state === 'error' && r.state === 'writing' ? { why: 'the session ended before the writer finished' } : r.why ? { why: r.why } : {}), tools: r.tools ?? 0, partial: r.partial ?? '', problems: r.problems ?? [], created: r.created ?? 0, ...(r.source ? { source: r.source } : {}), ...(r.orient ? { orient: r.orient } : {}), ...(r.highlights?.length ? { highlights: r.highlights.map(x => (x.state === 'working' ? { ...x, state: 'error', why: 'the session ended before it finished' } : x)) } : {}) }
  } catch {
    return null
  }
}

async function getReport(ctx: ReportCtx, slug: string | undefined): Promise<ChatReport | undefined> {
  if (!slug) return undefined
  const v = await ctx.report(slug)
  if (v) return v
  const { cwd } = await ctx.where()
  try {
    return parseRecord(await ctx.read(`${cwd}/${ctx.home}/reports/${slug}.json`)) ?? undefined
  } catch {
    return undefined
  }
}

/** A report in state and in its record beside its file, so a later session lists it. */
async function saveReport(ctx: ReportCtx, r: ChatReport): Promise<void> {
  await ctx.setReport(r)
  const { cwd } = await ctx.where()
  await ctx.write(`${cwd}/${ctx.home}/reports/${r.slug}.json`, JSON.stringify({ ...r, agentId: undefined }, null, 1)).catch(() => undefined)
}

async function patchReport(ctx: ReportCtx, slug: string, patch: Partial<ChatReport>): Promise<ChatReport | undefined> {
  const r = await getReport(ctx, slug)
  if (!r) return undefined
  const next = { ...r, ...patch }
  await saveReport(ctx, next)
  return next
}

/** Every report in the folder, newest first. */
export async function allReports(ctx: ReportCtx): Promise<ChatReport[]> {
  const { cwd } = await ctx.where()
  let names: string[] = []
  try {
    names = (await ctx.list(`${cwd}/${ctx.home}/reports`)).filter(f => f.endsWith('.json'))
  } catch {
    names = []
  }
  const out: ChatReport[] = []
  for (const f of names) {
    const r = await getReport(ctx, f.replace(/\.json$/, ''))
    if (r) out.push(r)
  }
  return out.sort((a, b) => b.created - a.created)
}

async function takenSlugs(ctx: ReportCtx): Promise<Set<string>> {
  const { cwd } = await ctx.where()
  try {
    return new Set((await ctx.list(`${cwd}/${ctx.home}/reports`)).map(f => f.replace(/\.(json|md)$/, '')))
  } catch {
    return new Set()
  }
}

/** Show a report in the panel. */
export async function showReport(ctx: ReportCtx, slug: string): Promise<void> {
  const r = await getReport(ctx, slug)
  const nav = await ctx.nav()
  if (nav?.slug !== slug) await ctx.setNav({ slug, slide: 0, notes: false, open: [] })
  await ctx.openPane('report', clip(r?.title ?? 'Report', 60))
}

// ------------------------------------------------------------------------------------------------ the writer

async function writerPrompt(ctx: ReportCtx, r: ChatReport, form: ReportForm): Promise<string> {
  const { root } = await ctx.where()
  const file = async (name: string) => ctx.read(`${root}/prompt/reports/${name}`).catch(() => '')
  const t = typeOf(form)
  const guide = (await file(t.prompt)).trim()
  const values: Record<string, string> = {
    form: t.name,
    form_id: t.id,
    contract: t.renderer,
    title: r.title,
    request: r.request.replace(/\s+/g, ' ').trim(),
    file: r.file,
    slug: r.slug,
    helper: `${root}/helper`,
    source: r.source ? `the ${t.renderer === 'document' ? 'report' : 'document'} it retells, \`${r.source}\`, which it follows closely, ` : '',
    form_guide: guide,
  }
  return (await file('writer.md')).replace(/\{\{(\w+)\}\}/g, (m, k: string) => values[k] ?? m)
}

/** Start a writer on a report: its record and the panel at once, then the subagent. */
export async function startReport(ctx: ReportCtx, ask: { form: ReportForm; title: string; request: string; source?: string }): Promise<ChatReport> {
  const title = clip((ask.title || ask.request || typeOf(ask.form).name).replace(/\s+/g, ' ').trim(), 80)
  const slug = slugOf(ask.source ? `${title} ${ask.form}` : title, await takenSlugs(ctx))
  const r: ChatReport = { slug, form: ask.form, title, request: ask.request, file: `${ctx.home}/reports/${slug}.md`, state: 'writing', tools: 0, partial: '', problems: [], created: await ctx.now(), ...(ask.source ? { source: ask.source } : {}) }
  await saveReport(ctx, r)
  await showReport(ctx, slug)
  await ctx.afterTurn(() => startWriter(ctx, r, ask.form))
  return (await getReport(ctx, slug)) ?? r
}

async function startWriter(ctx: ReportCtx, r: ChatReport, form: ReportForm): Promise<void> {
  const prompt = await writerPrompt(ctx, r, form)
  const label = `report · writing ${clip(r.title, 40)}`
  const s = await ctx.spawn(prompt, label, withGuide(await ctx.guide(), prompt))
  if ('deny' in s) {
    await patchReport(ctx, r.slug, { state: 'error', why: `could not start the writer: ${s.deny}` })
    return
  }
  await ctx.setAgent(s.agentId, { kind: 'report', label, report: r.slug })
  await patchReport(ctx, r.slug, { agentId: s.agentId })
}

/** A writer's row: its tool calls and latest words, for the panel. */
export async function reportAppend(ctx: ReportCtx, agentId: string | undefined, door: string, content: unknown): Promise<void> {
  if (!agentId || door !== 'response' || !Array.isArray(content)) return
  const a = await ctx.agent(agentId)
  if (a?.kind !== 'report' || !a.report) return
  const r = await getReport(ctx, a.report)
  if (!r || r.state !== 'writing') return
  const blocks = content as { type?: string; text?: string }[]
  const tools = blocks.filter(b => b.type === 'tool_use').length
  const text = withoutTaskLine(blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')).trim()
  if (tools || text) await ctx.setReport({ ...r, tools: r.tools + tools, partial: text ? clip(text.replace(/\s+/g, ' '), 200) : r.partial })
}

/** The writer ended: its file checked (citations, the form), main told, the report shown. */
export async function reportComplete(ctx: ReportCtx, a: ChatAgent, reason: string, answer: string): Promise<void> {
  const r = await getReport(ctx, a.report)
  if (!r || r.state !== 'writing') return
  texts.clear()
  const text = await readText(ctx, r.file)
  const form = typeOf(r.form).id
  if (!text.trim()) {
    const why = reason === 'answer' ? `the writer ended without writing ${r.file}${answer.trim() ? `: ${clip(answer.trim(), 200)}` : ''}` : `the writer ended: ${reason}`
    await patchReport(ctx, r.slug, { state: 'error', why })
    await showReport(ctx, r.slug)
    return
  }
  const bad = await ctx.checkCites(text)
  const problems = [...formProblems(text, form), ...(bad ? [`${bad} citation${bad === 1 ? '' : 's'} do not resolve or do not show their value`] : [])]
  const title = plainCites(splitTitle(text).title).replace(/\*\*|__|`/g, '') || r.title
  const t = typeOf(form)
  await patchReport(ctx, r.slug, { state: 'ready', title, problems, partial: clip(withoutTaskLine(answer).replace(/\s+/g, ' ').trim(), 200) })
  await ctx.noteMain(`thimble-cc-mod: its writer finished the ${t.name} "${title}", saved as ${r.file}; the analyst reads it in the panel.`)
  await showReport(ctx, r.slug)
}

/** "open as report": an answer as a document report, at once, without a model. */
export async function openAsReport(ctx: ReportCtx, text: string, head: string): Promise<void> {
  const own = splitTitle(text).title
  const title = clip((own || head || text.split('\n').find(l => l.trim()) || 'Answer').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim(), 80)
  const slug = slugOf(plainCites(title), await takenSlugs(ctx))
  const file = `${ctx.home}/reports/${slug}.md`
  const { cwd } = await ctx.where()
  await ctx.write(`${cwd}/${file}`, `${own ? text.trim() : `# ${title}\n\n${text.trim()}`}\n`)
  const problems = formProblems(own ? text : `# ${title}\n\n${text}`, 'document')
  await saveReport(ctx, { slug, form: 'document', title: plainCites(title), request: head, file, state: 'ready', tools: 0, partial: '', problems, created: await ctx.now() })
  await showReport(ctx, slug)
}

// ------------------------------------------------------------------------------------------------ verify this section

/** A section's claims, each once, keyed as its chips are. */
function sectionClaims(sec: Section): Claim[] {
  const seen = new Set<string>()
  return sec.parts.flatMap(p => claimsIn(p.text, p.answer)).filter(cl => !seen.has(cl.key) && Boolean(seen.add(cl.key)))
}

const VERIFY_BATCH = 6
const BUSY = new Set(['asked', 'running'])
const FAILED = new Set(['refuted', 'error', 'missing'])

/** "verify" on a section (every section when `key` is left out): subagents check each of its citations not verified
 *  or under way, at most six to a subagent. A value is recomputed by a script the mod runs once the subagent ends; a
 *  citation without a value is judged by the subagent from its place. Returns how many citations were sent. */
export async function verifySection(ctx: ReportCtx, slug: string, key?: string): Promise<number> {
  const r = await getReport(ctx, slug)
  if (!r || r.state !== 'ready') return 0
  const text = await readText(ctx, r.file)
  let sent = 0
  for (const sec of reportSections(text, typeOf(r.form).renderer, slug)) {
    if (key && sec.key !== key) continue
    const cls = sectionClaims(sec)
    ctx.remember(cls)
    const todo: Claim[] = []
    for (const cl of cls) {
      const v = await ctx.verifyOf(cl.key)
      if (!v || (v.state !== 'verified' && !BUSY.has(v.state))) todo.push(cl)
    }
    for (let k = 0; k < todo.length; k += VERIFY_BATCH) {
      const items: VerifyItem[] = todo.slice(k, k + VERIFY_BATCH).map(cl => ({ key: cl.key, raw: cl.c.raw, display: cl.c.display, sentence: cl.sentence, script: `${ctx.home}/verify/v-${cl.key}.py` }))
      const asked = (it: VerifyItem): ChatVerify => (it.display === null ? { id: it.key, state: 'asked', script: '', expected: null, kind: 'support' } : { id: it.key, state: 'asked', script: it.script, expected: it.display })
      for (const it of items) await ctx.setVerify(it.key, asked(it))
      const prompt = verifyPrompt({ title: r.title, file: r.file, heading: sec.heading, items })
      const label = `verification · checking "${clip(sec.heading || r.title, 36)}"`
      const s = await ctx.spawn(prompt, label, withGuide(await ctx.guide(), prompt))
      if ('deny' in s) {
        for (const it of items) await ctx.setVerify(it.key, { ...asked(it), state: 'error', stderr: `could not start a subagent: ${s.deny}` })
        continue
      }
      await ctx.setAgent(s.agentId, { kind: 'report-verify', label, report: slug, claims: items.map(it => it.key) })
      sent += items.length
    }
  }
  return sent
}

/** A verifier ended: each judged citation takes its verdict, each value's script is run by the mod (one after another,
 *  apart from the hook), and a citation left without either says why. */
async function verifyDone(ctx: ReportCtx, a: ChatAgent, reason: string, answer: string): Promise<void> {
  const verdicts = reason === 'answer' ? parseVerdicts(answer) : new Map<number, { supported: boolean; why: string }>()
  const ended = reason === 'answer' ? '' : `the subagent ended: ${reason}`
  const { cwd } = await ctx.where()
  const runs: string[] = []
  const judged: boolean[] = []
  for (const [i, key] of (a.claims ?? []).entries()) {
    const v = await ctx.verifyOf(key)
    if (v?.state !== 'asked') continue
    const got = verdicts.get(i + 1)
    if (v.kind === 'support' && got && !ended) judged.push(got.supported)
    if (v.kind === 'support') await ctx.setVerify(key, got && !ended ? { ...v, state: got.supported ? 'verified' : 'refuted', why: got.why } : { ...v, state: 'missing', stderr: ended || 'the subagent gave no verdict on it' })
    else if (await ctx.mtime(`${cwd}/${v.script}`).then(() => true, () => false)) runs.push(key)
    else await ctx.setVerify(key, { ...v, state: 'missing', stderr: ended || clip(got?.why || answer.trim(), 300) })
  }
  // main is told of the citations judged from their places; each value's script tells main its result as it runs
  const r = await getReport(ctx, a.report)
  if (judged.length && r) {
    const ok = judged.filter(Boolean).length
    await ctx.noteMain(`thimble-cc-mod: a verifier judged ${judged.length} citation${judged.length === 1 ? '' : 's'} of the report "${r.title}" from their places: ${ok} supported, ${judged.length - ok} not; each shows ✓ or × in the panel.`)
  }
  void (async () => {
    for (const key of runs) await ctx.runVerify(key).catch(() => undefined)
  })()
}

/** Claims counted by their verification: verified, failed, under way, and all. */
type Tally = { ok: number; bad: number; busy: number; all: number }

function tally(cls: readonly Claim[], states: ReadonlyMap<string, ChatVerify | undefined>): Tally {
  const t = { ok: 0, bad: 0, busy: 0, all: cls.length }
  for (const cl of cls) {
    const st = states.get(cl.key)?.state ?? ''
    if (st === 'verified') t.ok++
    else if (FAILED.has(st)) t.bad++
    else if (BUSY.has(st)) t.busy++
  }
  return t
}

// ------------------------------------------------------------------------------------------------ highlights

async function setHighlight(ctx: ReportCtx, slug: string, id: string, patch: Partial<ChatHighlight>): Promise<void> {
  const r = await getReport(ctx, slug)
  if (r) await patchReport(ctx, slug, { highlights: (r.highlights ?? []).map(hl => (hl.id === id ? { ...hl, ...patch } : hl)) })
}

/** "highlight <words>": a set in the report's record at once (the legend shows it working), then a subagent given the
 *  report's passages by id. `inTurn` (main's tool): the subagent starts once main's turn ends. */
export async function startHighlight(ctx: ReportCtx, slug: string, request: string, inTurn = false): Promise<ChatHighlight | null> {
  const r = await getReport(ctx, slug)
  const words = request.replace(/\s+/g, ' ').trim()
  if (!r || !words) return null
  const text = await readText(ctx, r.file)
  if (!text.trim()) return null
  const sets = r.highlights ?? []
  const used = new Set(sets.map(hl => hl.color))
  const color = SERIES.find(c => !used.has(c)) ?? SERIES[sets.length % SERIES.length]!
  const hl: ChatHighlight = { id: `h${(await ctx.now()).toString(36)}${sets.length}`, request: words, label: highlightLabel(words), color, state: 'working', marks: [] }
  await patchReport(ctx, slug, { highlights: [...sets, hl] })
  const start = async () => {
    const prompt = highlightPrompt({ title: r.title, file: r.file, request: words, passages: reportPassages(text, typeOf(r.form).renderer, slug) })
    const label = `report · highlighting ${clip(hl.label, 40)}`
    const s = await ctx.spawn(prompt, label, withGuide(await ctx.guide(), prompt))
    if ('deny' in s) await setHighlight(ctx, slug, hl.id, { state: 'error', why: `could not start a subagent: ${s.deny}` })
    else await ctx.setAgent(s.agentId, { kind: 'report-highlight', label, report: slug, highlight: hl.id })
  }
  if (inTurn) await ctx.afterTurn(start)
  else await start()
  return hl
}

/** A highlighter ended: the passages it named, each with the place that shows it and why. */
async function highlightDone(ctx: ReportCtx, a: ChatAgent, reason: string, answer: string): Promise<void> {
  const r = await getReport(ctx, a.report)
  if (!r || !a.highlight) return
  if (reason !== 'answer') return setHighlight(ctx, r.slug, a.highlight, { state: 'error', why: `the subagent ended: ${reason}` })
  const passages = reportPassages(await readText(ctx, r.file), typeOf(r.form).renderer, r.slug)
  const marks = parseMarks(answer, passages)
  await setHighlight(ctx, r.slug, a.highlight, { state: 'ready', marks })
  const label = (r.highlights ?? []).find(hl => hl.id === a.highlight)?.label ?? 'a highlight'
  await ctx.noteMain(`thimble-cc-mod: the report "${r.title}" now highlights ${label}: ${marks.length} passage${marks.length === 1 ? '' : 's'}, marked in the panel.`)
}

async function dropHighlight(ctx: ReportCtx, slug: string, id: string): Promise<void> {
  const r = await getReport(ctx, slug)
  if (r) await patchReport(ctx, slug, { highlights: (r.highlights ?? []).filter(hl => hl.id !== id) })
}

/** The legend's press on a set: the panel scrolls to its next mark. */
async function nextMark(ctx: ReportCtx, hl: ChatHighlight): Promise<void> {
  const nav = await ctx.nav()
  if (!nav || !hl.marks.length) return
  const i = ((nav.at?.[hl.id] ?? -1) + 1) % hl.marks.length
  await ctx.setNav({ ...nav, at: { ...(nav.at ?? {}), [hl.id]: i } })
  await ctx.scroll(`mark:${hl.id}:${i}`, 'center')
}

/** A report's subagents' ends: its writer's, a verifier's, a highlighter's. */
export async function reportAgentDone(ctx: ReportCtx, a: ChatAgent, reason: string, answer: string): Promise<void> {
  if (a.kind === 'report-verify') return verifyDone(ctx, a, reason, answer)
  if (a.kind === 'report-highlight') return highlightDone(ctx, a, reason, answer)
  return reportComplete(ctx, a, reason, answer)
}

// ------------------------------------------------------------------------------------------------ the panel

/** A page row's turn (keys.tsx, the b and n buttons): the slide or the story's step before or after; a story read as
 *  one page or stepped through. */
export async function reportNav(ctx: ReportCtx, op: string): Promise<void> {
  const nav = await ctx.nav()
  if (!nav) return
  const r = await getReport(ctx, nav.slug)
  const n = r ? stepCount(await readText(ctx, r.file), typeOf(r.form).renderer) : 1
  const slide = Math.max(0, Math.min(n - 1, nav.slide + (op === 'prev' ? -1 : op === 'next' ? 1 : 0)))
  if (op === 'notes') await ctx.setNav({ ...nav, notes: !nav.notes })
  else if (op === 'page') await ctx.setNav({ ...nav, page: !nav.page })
  else if (/^\d+$/.test(op)) await ctx.setNav({ ...nav, slide: Math.max(0, Math.min(n - 1, Number(op))), page: false })
  else if (slide !== nav.slide) await ctx.setNav({ ...nav, slide })
}

async function toggle(ctx: ReportCtx, key: string): Promise<void> {
  const nav = await ctx.nav()
  if (!nav) return
  await ctx.setNav({ ...nav, open: nav.open.includes(key) ? nav.open.filter(k => k !== key) : [...nav.open, key] })
}

function stateWords(r: ChatReport): string {
  const name = typeOf(r.form).name
  if (r.state === 'writing') return `${name} · ◌ writing · ${r.tools} tool call${r.tools === 1 ? '' : 's'}${r.partial ? ` · ${r.partial}` : ''}`
  if (r.state === 'error') return `${name} · ${r.why ?? 'failed'}`
  return name
}

/** Hotkeys with no label of their own (views/SPEC.md, "The visual system", rule 24), as register.tsx hiddenKeys. */
function hiddenKeys(e: PaneEvent, ctx: ReportCtx, keys: { key: string; hotkey: string; onPress: () => void }[]): RenderElement | null {
  if (!keys.length || e.surface === 'mobile') return null
  const { Box, Button } = ctx.els(e)
  return (
    <Box key="hidden-keys" width={0} height={0} flexShrink={0} overflow="hidden" flexDirection="row">
      {keys.map(k => (
        <Button key={k.key === 'close' ? 'close' : k.key.startsWith('=') ? k.key.slice(1) : `hk-${k.key}`} label={k.hotkey} hotkey={k.hotkey} plain onPress={k.onPress} />
      ))}
    </Box>
  )
}

/** A tally of citations in words (`12 verified · 1 failed`, the failures red), and ◌ while some are verified. */
function tallyWords(e: PaneEvent, ctx: ReportCtx, t: Tally, lead = ''): RenderElement[] {
  const { Text } = ctx.els(e)
  const out: RenderElement[] = []
  const sep = () => (out.length || lead ? <Text dimColor>{' · '}</Text> : null)
  if (t.ok) out.push(...[sep(), <Text dimColor>{`${t.ok} verified`}</Text>].filter((x): x is RenderElement => x !== null))
  if (t.bad) out.push(...[sep(), <Text color={COLORS.problem}>{`${t.bad} failed`}</Text>].filter((x): x is RenderElement => x !== null))
  if (t.busy) out.push(...[sep(), <Text dimColor>{`◌ verifying ${t.busy}`}</Text>].filter((x): x is RenderElement => x !== null))
  return out
}

/** What one drawing of a report shares among its parts: its sections and their claims' verification states, and its
 *  highlights' marks by passage. */
type Look = { secs: Section[]; claims: Map<string, Claim[]>; states: Map<string, ChatVerify | undefined>; marks: Map<string, { hl: ChatHighlight; i: number }[]> }

async function lookOf(ctx: ReportCtx, r: ChatReport, text: string): Promise<Look> {
  const secs = text.trim() && r.state === 'ready' ? reportSections(text, typeOf(r.form).renderer, r.slug) : []
  const claims = new Map<string, Claim[]>()
  const states = new Map<string, ChatVerify | undefined>()
  for (const sec of secs) {
    const cls = sectionClaims(sec)
    claims.set(sec.key, cls)
    for (const cl of cls) states.set(cl.key, await ctx.verifyOf(cl.key))
  }
  const marks = new Map<string, { hl: ChatHighlight; i: number }[]>()
  for (const hl of r.highlights ?? []) hl.marks.forEach((m, i) => marks.set(m.key, [...(marks.get(m.key) ?? []), { hl, i }]))
  return { secs, claims, states, marks }
}

/** The marks on a passage drawReply draws: by its words, else by a long passage that holds it or that it holds. */
function marksOn(look: Look, words: string): { hl: ChatHighlight; i: number }[] {
  const k = passageKey(words)
  if (!k) return []
  const hit = look.marks.get(k)
  if (hit || k.length < 24) return hit ?? []
  for (const [mk, v] of look.marks) if (mk.length >= 24 && (k.includes(mk) || mk.includes(k))) return v
  return []
}

/** A section's verification beside its heading: ✓ and ✗ counts, "verifying n…", and "verify" for what is left. */
function sectionTool(e: PaneEvent, ctx: ReportCtx, slug: string, sec: Section, look: Look): RenderElement | null {
  const { Box, Text, Button } = ctx.els(e)
  const cls = look.claims.get(sec.key) ?? []
  if (!cls.length) return null
  const t = tally(cls, look.states)
  const left = t.all - t.ok - t.bad - t.busy
  const label = t.busy ? '' : left ? (t.ok + t.bad ? 'verify the rest' : 'verify') : t.bad ? 'again' : ''
  return (
    <Box key={`vt:${sec.key}`} flexDirection="row" columnGap={2}>
      <Text>{tallyWords(e, ctx, t)}</Text>
      {label ? <Button key={`verify:${sec.key}`} label={label} plain onPress={() => void verifySection(ctx, slug, sec.key)} /> : null}
    </Box>
  )
}

/** How drawReply draws this report's text: list items asked about one by one, each thread told where its passage
 *  stands, a section's verification beside its heading, a highlighted passage's bar and reasons. */
function replyOpts(e: PaneEvent, ctx: ReportCtx, r: ChatReport, look: Look, cols: number): ReplyOpts {
  const { Text } = ctx.els(e)
  return {
    margin: ctx.margin,
    items: true,
    where: heading => `In the report "${r.title}"${heading.trim() ? `, section "${clip(plainCites(heading.replace(/^#+\s*/, '')), 80)}"` : ''} (${r.file}); read the report for what surrounds it.`,
    tools: line => {
      const sec = sectionOfHeading(look.secs, line)
      return sec ? sectionTool(e, ctx, r.slug, sec, look) : null
    },
    mark: words => {
      const hits = marksOn(look, words)
      if (!hits.length) return null
      return {
        color: hits[0]!.hl.color,
        under: hits.map(({ hl, i }) => {
          const m = hl.marks[i]!
          const why = clip(m.why || hl.label, Math.max(20, cols - 6))
          // `↗` blue, a link to the place that shows it; its reason dim
          return m.ref
            ? ctx.link(e, `mark:${hl.id}:${i}`, [[{ s: '↗', fg: LINK }, { s: ` ${why}`, fg: COLORS.dim }]], [{ y: 0, x0: 0, x1: 1, row: false, run: () => ctx.openRef(m.ref!) }], cols)
            : <Text key={`mark:${hl.id}:${i}`} dimColor wrap="truncate-end">{`  ${why}`}</Text>
        }),
      }
    },
  }
}

/** The report the panel shows (views/SPEC.md, section 7, "A report"): its title in the accent and bold, wrapped, with
 *  no subtitle (but while its writer writes, or when it failed); its problems in red; its highlights' legend; under the
 *  rule, its type drawn as main's chat draws a reply, at A0; at the bottom, after the second rule, `verify all`, its
 *  retellings and `all reports ›`, then the key hints. No stats row and no file path. */
export async function drawReport(e: PaneEvent, ctx: ReportCtx): Promise<RenderElement> {
  const { Box, Text, Button } = ctx.els(e)
  const els = { Box, Text, Button }
  const nav = await ctx.nav()
  const r = await getReport(ctx, nav?.slug)
  if (!nav || !r) return <Box flexDirection="column"><Text dimColor>none</Text></Box>
  const cols = Math.max(30, e.props.bodyColumns)
  const t = typeOf(r.form)
  const view = t.renderer
  const text = await readText(ctx, r.file)
  const look = await lookOf(ctx, r, text)
  const opts = replyOpts(e, ctx, r, look, cols)
  const ready = r.state === 'ready'
  const body: RenderElement[] = []
  const slides = view === 'slides' && text ? slidesOf(text) : null
  const shownTitle = plainCites(slides?.title || splitTitle(text).title || r.title).replace(/\*\*|__|`/g, '')
  // the subtitle only says what is not done: the writer writing, or why it failed
  const sub: Line = r.state === 'writing' ? subLine([`◌ writing · ${r.tools} tool call${r.tools === 1 ? '' : 's'}`, r.partial || '']) : r.state === 'error' ? [{ s: r.why ?? 'failed', fg: COLORS.problem }] : []
  body.push(...headerEls(els, { title: shownTitle, cols, sub, rule: false }))
  for (const p of r.problems.slice(0, 3)) body.push(<Text color={COLORS.problem} wrap="wrap">{`× ${p}`}</Text>)
  // the legend: one entry per highlight set, a press goes to its next mark
  const sets = r.highlights ?? []
  if (sets.length) {
    body.push(
      <Box key="legend" flexDirection="row" columnGap={2} flexWrap="wrap">
        {sets.map(hl => (
          <Box key={`hl:${hl.id}`} flexDirection="row">
            <Text {...(hl.state === 'error' ? { color: COLORS.problem } : hl.state === 'working' ? {} : { color: hl.color })}>{hl.state === 'working' ? '◌ ' : hl.state === 'error' ? '× ' : '● '}</Text>
            {hl.state === 'ready' && hl.marks.length ? (
              <Button key={`hl-go:${hl.id}`} label={hl.label} plain onPress={() => void nextMark(ctx, hl)} />
            ) : (
              <Text dimColor>{hl.state === 'working' ? `${hl.label} · finding passages` : hl.state === 'error' ? `${hl.label} · ${hl.why ?? 'failed'}` : `${hl.label} · no passage found`}</Text>
            )}
            {hl.state === 'ready' && hl.marks.length ? <Text dimColor>{` ${hl.marks.length}`}</Text> : null}
            <Text>{'  '}</Text>
            <Button key={`hl-x:${hl.id}`} label="remove" plain onPress={() => void dropHighlight(ctx, r.slug, hl.id)} />
          </Box>
        ))}
      </Box>,
    )
  }
  const all = tally([...look.claims.values()].flat(), look.states)
  const answer = `report:${r.slug}`
  const retellTypes = ready ? TYPES.filter(to => to.retell && to.id !== t.id && to.renderer !== view) : []
  const verifyAll = ready && all.all > 0 && all.ok + all.bad + all.busy < all.all
  body.push(ruleEl(els, cols, 'rule-top'))
  if (text.trim()) {
    if (view === 'slides' && slides) {
      // the rows the slide may take: the panel's, less the rows above it (the path, title, problems, legend, the rule)
      // and below it (the rule, the buttons and the key hints)
      const above = 1 + wrapRows(shownTitle, cols) + r.problems.slice(0, 3).reduce((n, p) => n + wrapRows(`× ${p}`, cols), 0) + (sets.length ? wrapRows(sets.map(hl => `● ${hl.label} ${hl.marks.length}  remove`).join('  '), cols) : 0) + 1
      const below = 2 + buttonRows([...(verifyAll ? ['verify all'] : []), ...retellTypes.map(to => to.retell!.label), 'all reports ›'], cols)
      const rows = e.props.scroll?.bodyRows ?? 0
      body.push(...(await drawSlides(e, ctx, r, slides, nav.slide, nav.notes, cols, opts, look, rows ? rows - above - below : 0)))
    } else if (view === 'story') body.push(...(await drawStory(e, ctx, r, text, nav, cols, answer, opts, look)))
    else body.push(...(await drawDocument(e, ctx, text, nav.open, cols, answer, opts, look)))
  } else if (r.state === 'writing') body.push(<Text dimColor wrap="wrap">{`the request: ${r.request}`}</Text>)
  const retellOf = (to: (typeof retellTypes)[number]) => () => void startReport(ctx, { form: to.id, title: r.title, request: `Retell the ${t.name} "${r.title}" as ${to.name}.`, source: r.file })
  // the report's actions, plain words 2 cells apart, after the second rule
  body.push(ruleEl(els, cols, 'rule-end'))
  body.push(
    <Box key="report-controls" flexDirection="row" columnGap={2} flexWrap="wrap">
      {verifyAll ? <Button key="verify-all" label="verify all" plain onPress={() => void verifySection(ctx, r.slug)} /> : null}
      {retellTypes.map(to => <Button key={`retell-${to.id}`} label={to.retell!.label} plain onPress={retellOf(to)} />)}
      <Button key="report-list" label="all reports ›" plain onPress={() => void ctx.openPane('reports', 'Reports')} />
    </Box>,
  )
  body.push(hintsEl(els, [...(verifyAll ? ['c to verify all'] : []), ...retellTypes.map(to => `${to.retell!.hotkey} ${to.retell!.label}`), 'l for all reports', 'x to close'], cols))
  const hk = hiddenKeys(e, ctx, [
    ...(verifyAll ? [{ key: 'verify', hotkey: 'c', onPress: () => void verifySection(ctx, r.slug) }] : []),
    ...retellTypes.map(to => ({ key: `retell-${to.id}`, hotkey: to.retell!.hotkey, onPress: retellOf(to) })),
    { key: 'list', hotkey: 'l', onPress: () => void ctx.openPane('reports', 'Reports') },
    { key: 'close', hotkey: 'x', onPress: () => void ctx.closePanel() },
  ])
  if (hk) body.unshift(hk)
  return <Box flexDirection="column">{body}</Box>
}

/** A document: its contents (`Contents` bold, each section's number in a dim column at A0 and its title a button that
 *  scrolls the panel to it, its tally beside it), then its segments drawn as main's chat draws a reply at A0, a
 *  toggle's body once opened. */
async function drawDocument(e: PaneEvent, ctx: ReportCtx, text: string, open: readonly string[], cols: number, answer: string, opts: ReplyOpts, look: Look): Promise<RenderElement[]> {
  const { Box, Text, Button } = ctx.els(e)
  const segs = docSegments(splitTitle(text).body)
  const toc = tocOf(segs)
  const out: RenderElement[] = []
  if (toc.length >= 3) {
    out.push(<Text key="toc-head" bold>Contents</Text>)
    const shown = toc.slice(0, 24)
    const nw = String(shown.length).length
    const keys: { key: string; hotkey: string; onPress: () => void }[] = []
    shown.forEach((t, i) => {
      const seg = segs[t.segment]
      const key = seg?.kind === 'md' ? headingKey(seg.text, `r${t.segment}-`, t.line) : ''
      const sec = t.level === 2 ? sectionOfHeading(look.secs, t.line) : undefined
      const tl = sec ? tally(look.claims.get(sec.key) ?? [], look.states) : null
      const go = () => void (key ? ctx.scroll(key) : undefined)
      if (i < 9) keys.push({ key: `toc${i}`, hotkey: String(i + 1), onPress: go })
      out.push(
        <Box key={`toc-row:${i}`} flexDirection="row">
          <Text dimColor>{`${String(i + 1).padStart(nw)}  ${t.level === 3 ? '  ' : ''}`}</Text>
          <Button key={`toc:${i}`} label={clip(t.text, cols - 24)} plain onPress={go} />
          {tl && (tl.ok || tl.bad || tl.busy) ? <Text>{'  '}</Text> : null}
          {tl ? <Text>{tallyWords(e, ctx, tl)}</Text> : null}
        </Box>,
      )
    })
    const hk = hiddenKeys(e, ctx, keys)
    if (hk) out.unshift(hk)
    out.push(<Text key="toc-gap"> </Text>)
  }
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!
    if (s.kind === 'md') {
      // the reply's rows bring their margin: the passage's "?" or ↳ and a highlight's ● at M, the text at A0
      out.push(<Box key={marginKey(`seg:${i}`)} flexDirection="column">{await ctx.drawReply(e, s.text, cols, answer, `r${i}-`, opts)}</Box>)
      continue
    }
    const isOpen = open.includes(s.key)
    out.push(
      <Box key={`toggle-row:${i}`} marginTop={1} marginBottom={isOpen ? 0 : 1}>
        {isOpen ? (
          <Box backgroundColor={COLORS.selected}>
            <Button key={`toggle:${s.key}`} label={`▾ ${s.summary}`} plain onPress={() => void toggle(ctx, s.key)} />
          </Box>
        ) : (
          <Button key={`toggle:${s.key}`} label={`▸ ${s.summary}`} plain onPress={() => void toggle(ctx, s.key)} />
        )}
      </Box>,
    )
    if (isOpen) out.push(<Box key={marginKey(`toggle-body:${i}`)} flexDirection="column" marginLeft={2} marginBottom={1}>{await ctx.drawReply(e, s.body, cols - 2, answer, `t${i}-`, opts)}</Box>)
  }
  return out
}

/** One slide, then the page row (‹ 3 / 9 ›, ← → once it has the keys) and the slide buttons, its verification among
 *  them. The slide fits the `room` rows it is given (0: not known): a card taller than its share shows its first rows
 *  and how many more there are, which open the card whole. */
async function drawSlides(e: PaneEvent, ctx: ReportCtx, r: ChatReport, deck: ReturnType<typeof slidesOf>, at: number, notes: boolean, cols: number, opts: ReplyOpts, look: Look, room = 0): Promise<RenderElement[]> {
  const { Box, Text, Button, Client } = ctx.els(e)
  const n = deck.slides.length
  const i = Math.max(0, Math.min(n - 1, at))
  const s = deck.slides[i]!
  const answer = `report:${r.slug}#${i + 1}`
  const out: RenderElement[] = []
  const any = deck.slides.some(x => x.notes)
  const sec = look.secs.find(x => x.key === `s${i}`)
  if (s.kind === 'title') {
    out.push(<Text key="slide-gap"> </Text>)
    out.push(<Text key="slide-title" wrap="wrap">{plainCites(s.heading).replace(/\*\*|__|`/g, '') || ' '}</Text>)
    if (s.body) out.push(<Box key={marginKey('slide-body')} flexDirection="column" marginTop={1}>{await ctx.drawReply(e, s.body, cols, answer, `s${i}-`, opts)}</Box>)
  } else {
    out.push(<Text key="slide-head" wrap="wrap">{plainCites(s.heading).replace(/\*\*|__|`/g, '')}</Text>)
    if (s.cards.length) {
      const per = s.cards.length === 1 || cols < 80 ? 1 : Math.min(s.cards.length, /grid|four/.test(s.layout) ? 2 : cols >= 140 ? 3 : 2)
      const w = Math.floor((cols - 2 * (per - 1)) / per)
      // each row of cards gets an equal share of what the heading, the text, the notes and the buttons leave, less a row
      const lines = Math.ceil(s.cards.length / per)
      const rest =
        wrapRows(plainCites(s.heading), cols) +
        (s.body ? 1 + textRows(s.body, cols) : 0) +
        (notes && s.notes ? 1 + textRows(s.notes, cols) : 0) +
        2 + buttonRows(['back', 'next', ...(any ? [notes ? 'hide notes' : 'notes'] : []), ...(sec ? ['0 verified · verify the rest'] : [])], cols)
      const share = room ? Math.floor((room - rest - lines - 1) / lines) : 0
      for (let k = 0; k < s.cards.length; k += per) {
        const row = await Promise.all(
          s.cards.slice(k, k + per).map(async (f, j) => {
            const key = `slide-card:${i}:${k + j}`
            const data = share > 0 ? await ctx.loadCard(f.id) : null
            const fit = data ? fitCard(data, w, share) : null
            if (!fit?.more) return ctx.cardEl(e, f.id, w, key)
            return (
              <Box key={`slide-fig:${i}:${k + j}`} flexDirection="column" width={w}>
                {await ctx.cardEl(e, f.id, w, key, undefined, fit.card)}
                <Button key={`slide-more:${i}:${k + j}`} label={`… ${fit.more} more ${fit.unit}`} plain dimColor onPress={() => void ctx.openRef(`card:${f.id}`)} />
              </Box>
            )
          }),
        )
        out.push(<Box key={`slide-cards:${k}`} flexDirection="row" columnGap={2} marginTop={1}>{row}</Box>)
      }
    }
    if (s.body) out.push(<Box key={marginKey('slide-body')} flexDirection="column" marginTop={1}>{await ctx.drawReply(e, s.body, cols, answer, `s${i}-`, opts)}</Box>)
    if (notes && s.notes) {
      out.push(<Text key="notes-head" bold>Notes</Text>)
      out.push(<Box key={marginKey('slide-notes')} flexDirection="column">{await ctx.drawReply(e, s.notes, cols, answer, `n${i}-`, opts)}</Box>)
    }
  }
  out.push(<Box key="slide-pad" marginTop={1}><Client key="slide-keys" module="./keys.tsx" width={cols} props={{ label: `${i + 1} / ${n}`, cols }} /></Box>)
  out.push(
    <Box key="slide-buttons" flexDirection="row" columnGap={2} flexWrap="wrap">
      <Button key="slide-prev" label="back" plain onPress={() => void reportNav(ctx, 'prev')} />
      <Button key="slide-next" label="next" plain onPress={() => void reportNav(ctx, 'next')} />
      {any ? <Button key="slide-notes" label={notes ? 'hide notes' : 'notes'} plain onPress={() => void reportNav(ctx, 'notes')} /> : null}
      {sec ? sectionTool(e, ctx, r.slug, sec, look) : null}
      {hiddenKeys(e, ctx, [{ key: 'prev', hotkey: 'b', onPress: () => void reportNav(ctx, 'prev') }, { key: 'next', hotkey: 'n', onPress: () => void reportNav(ctx, 'next') }, ...(any ? [{ key: 'notes', hotkey: 'o', onPress: () => void reportNav(ctx, 'notes') }] : [])])}
    </Box>,
  )
  return out
}

/** A beat's figure lit at its step, beside its words where the panel is wide enough (`place` left or right), else
 *  above them. */
async function drawBeat(e: PaneEvent, ctx: ReportCtx, b: ReturnType<typeof storyOf>['beats'][number], k: number, cols: number, answer: string, opts: ReplyOpts): Promise<RenderElement[]> {
  const { Box, Text } = ctx.els(e)
  const f = b.place !== 'none' ? b.figure : null
  const data = f ? await ctx.loadCard(f.id) : null
  const callout = f ? calloutOf(f.step) : ''
  const focus = data && f?.step && !callout ? stepFocus(data, f.step) : undefined
  const wide = Boolean(f) && cols >= 110 && (b.place === 'left' || b.place === 'right')
  const cw = wide ? Math.max(50, Math.floor(cols * 0.58)) : cols
  const figure = f ? (
    <Box key={`beat-fig:${k}`} flexDirection="column" width={cw} flexShrink={0}>
      {await ctx.cardEl(e, f.id, cw, `beat-card:${k}`, focus)}
      {callout ? <Text>{callout}</Text> : null}
      {f.caption ? <Text dimColor wrap="wrap">{f.caption}</Text> : null}
    </Box>
  ) : null
  const words = b.body ? <Box key={`beat-text:${k}`} flexDirection="column" flexGrow={1} flexShrink={1}>{await ctx.drawReply(e, b.body, (wide ? cols - cw - 2 : cols) - ctx.margin, answer, `b${k}-`, opts)}</Box> : null
  if (wide) return [<Box key={`beat-row:${k}`} flexDirection="row" columnGap={2}>{b.place === 'left' ? [figure, words] : [words, figure]}</Box>]
  return [figure, words].filter((x): x is RenderElement => x !== null)
}

/** An interactive story: stepped through, the opening with its beats listed, then one beat at a time beside its
 *  figure, which stays where beats share a card and lights each one's step; or read as one page. */
async function drawStory(e: PaneEvent, ctx: ReportCtx, r: ChatReport, text: string, nav: ChatReportNav, cols: number, answer: string, opts: ReplyOpts, look: Look): Promise<RenderElement[]> {
  const { Box, Text, Button, Client } = ctx.els(e)
  const st = storyOf(text)
  const out: RenderElement[] = []
  const head = (k: number, words: string) => (
    <Text key={`beat-head:${k}`} wrap="wrap">
      <Text dimColor>{`${String(k + 1).padStart(2)}  `}</Text>
      {plainCites(words).replace(/\*\*|__|`/g, '')}
    </Text>
  )
  if (nav.page) {
    if (st.lead) out.push(<Box key={marginKey('story-lead')} flexDirection="column">{await ctx.drawReply(e, st.lead, cols, answer, 'lead-', opts)}</Box>)
    for (let k = 0; k < st.beats.length; k++) out.push(<Box key={`beat:${k}`} flexDirection="column" marginTop={1}>{[head(k, st.beats[k]!.heading), ...(await drawBeat(e, ctx, st.beats[k]!, k, cols, answer, opts))]}</Box>)
    out.push(<Box key="story-buttons" flexDirection="row" columnGap={2} marginTop={1}><Button key="story-page" label="step through" plain onPress={() => void reportNav(ctx, 'page')} />{hiddenKeys(e, ctx, [{ key: 'page', hotkey: 'a', onPress: () => void reportNav(ctx, 'page') }])}</Box>)
    return out
  }
  const n = st.beats.length + 1
  const i = Math.max(0, Math.min(n - 1, nav.slide))
  if (i === 0) {
    if (st.lead) out.push(<Box key={marginKey('story-lead')} flexDirection="column">{await ctx.drawReply(e, st.lead, cols, answer, 'lead-', opts)}</Box>)
    out.push(<Text key="story-beats"><Text>Beats</Text><Text dimColor>{`  ${st.beats.length}`}</Text></Text>)
    st.beats.forEach((b, k) =>
      out.push(
        <Box key={`story-beat-row:${k}`} flexDirection="row">
          <Text dimColor>{`  ${String(k + 1).padStart(String(st.beats.length).length)}  `}</Text>
          <Button key={`story-beat:${k}`} label={clip(plainCites(b.heading).replace(/\*\*|__|`/g, ''), cols - 10)} plain onPress={() => void reportNav(ctx, String(k + 1))} />
        </Box>,
      ),
    )
  } else {
    const b = st.beats[i - 1]!
    const prev = st.beats[i - 2]
    out.push(head(i - 1, b.heading))
    // the figure that stays: the previous beat showed the same card, now lit at this beat's step
    if (b.figure && prev?.figure?.id === b.figure.id && b.figure.step) out.push(<Text key="beat-same" dimColor>{`the same figure, now at ${b.figure.step}`}</Text>)
    out.push(<Box key={`beat:${i}`} flexDirection="column" marginTop={1}>{await drawBeat(e, ctx, b, i - 1, cols, answer, opts)}</Box>)
  }
  const sec = look.secs.find(x => x.key === `s${i}`)
  out.push(<Box key="story-pad" marginTop={1}><Client key="story-keys" module="./keys.tsx" width={cols} props={{ label: i ? `beat ${i} / ${n - 1}` : 'opening', cols }} /></Box>)
  out.push(
    <Box key="story-buttons" flexDirection="row" columnGap={2} flexWrap="wrap">
      <Button key="story-prev" label="back" plain onPress={() => void reportNav(ctx, 'prev')} />
      <Button key="story-next" label="next" plain onPress={() => void reportNav(ctx, 'next')} />
      <Button key="story-page" label="read as a page" plain onPress={() => void reportNav(ctx, 'page')} />
      {sec ? sectionTool(e, ctx, r.slug, sec, look) : null}
      {hiddenKeys(e, ctx, [{ key: 'prev', hotkey: 'b', onPress: () => void reportNav(ctx, 'prev') }, { key: 'next', hotkey: 'n', onPress: () => void reportNav(ctx, 'next') }, { key: 'page', hotkey: 'a', onPress: () => void reportNav(ctx, 'page') }])}
    </Box>,
  )
  return out
}

// the reports list's row the keys chose
let reportPick = ''

/** Every report in the folder (views/SPEC.md, section 7, "A report", the reports list): its title and a dim subtitle;
 *  under the rule, one row per report (its state glyph, its title, its kind and card count dim at R), `❯` and the
 *  accent on the row the keys chose; a click or Enter shows it. */
export async function drawReports(e: PaneEvent, ctx: ReportCtx): Promise<RenderElement> {
  const { Box, Text, Button } = ctx.els(e)
  const els = { Box, Text, Button }
  const cols = Math.max(30, e.props.bodyColumns)
  const all = (await allReports(ctx)).slice(0, 40)
  const body: RenderElement[] = [...headerEls(els, { title: 'Reports', cols, sub: subLine([`${all.length} report${all.length === 1 ? '' : 's'}`]) })]
  const lines: Line[] = []
  const hits: { y: number; x0: number; x1: number; row: boolean; run: () => Promise<void> | void }[] = []
  const pick = all.find(r => r.slug === reportPick)?.slug ?? all[0]?.slug ?? ''
  for (const r of all) {
    // its kind and cards, dim at R; its state is its glyph's
    const text = r.state === 'ready' ? await readText(ctx, r.file).catch(() => '') : ''
    const nCards = text ? reportCards(text).length : 0
    const facts = [typeOf(r.form).name, r.state === 'writing' ? `${r.tools} tool call${r.tools === 1 ? '' : 's'}` : '', nCards ? `${nCards} card${nCards === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
    const g = r.state === 'writing' ? { s: '◌' } : r.state === 'error' ? { s: '×', fg: COLORS.problem } : { s: '●' }
    hits.push({ y: lines.length, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: () => showReport(ctx, r.slug) })
    lines.push(pointed(spread([g, { s: ' ' }, { s: r.title }], [{ s: facts, fg: COLORS.dim }], cols), r.slug === pick))
  }
  if (!all.length) lines.push(pointed([{ s: '  ' }, { s: 'none', fg: COLORS.dim }], false))
  const step = (d: number) => {
    const at = all.findIndex(r => r.slug === pick)
    reportPick = all[Math.max(0, Math.min(all.length - 1, at + d))]?.slug ?? ''
    return ctx.openPane('reports', 'Reports')
  }
  body.push(ctx.link(e, marginKey('reports-list'), lines, hits, cols + MARGIN_W, k => (k === 'up' || k === 'k' ? step(-1) : k === 'down' || k === 'j' ? step(1) : (k === 'return' || k === 'enter') && pick ? showReport(ctx, pick) : undefined)))
  // each report a press away by its key too, for a surface that draws no Client: no row of its own
  body.unshift(
    <Box key="report-presses" width={0} height={0} flexShrink={0} overflow="hidden" flexDirection="row">
      {all.map(r => <Button key={`report-open:${r.slug}`} label={r.title} plain onPress={() => void showReport(ctx, r.slug)} />)}
    </Box>,
  )
  body.push(hintsEl(els, ['↑↓ to choose', 'Enter to open', 'x to close'], cols))
  const hk = hiddenKeys(e, ctx, [...all.slice(0, 9).map((r, i) => ({ key: `r${i}`, hotkey: String(i + 1), onPress: () => void showReport(ctx, r.slug) })), { key: 'close', hotkey: 'x', onPress: () => void ctx.closePanel() }])
  if (hk) body.unshift(hk)
  return <Box flexDirection="column">{body}</Box>
}

// ------------------------------------------------------------------------------------------------ hooks

/** Main's call of the `report` tool: a writer started, and what main is told. A writer's own call is refused. A type
 *  written only on request (a story) needs the analyst's words to name it, else the writer writes a document. */
export async function reportTool(ctx: ReportCtx, e: { agentId?: string }): Promise<{ result: string } | { deny: string }> {
  if (e.agentId !== undefined) return { deny: 'thimble-cc-mod: the writer writes the document itself; it starts no other writer' }
  const x = e as unknown as { form?: unknown; title?: unknown; request?: unknown }
  const request = typeof x.request === 'string' ? x.request : ''
  const form = settleType(x.form, request)
  const r = await startReport(ctx, { form, title: typeof x.title === 'string' ? x.title : '', request })
  if (r.state === 'error') return { deny: `thimble-cc-mod could not start its writer: ${r.why ?? ''}` }
  const instead = isForm(x.form) && x.form !== form ? ` The analyst's words do not ask for a ${typeOf(x.form).name}, so it writes a ${typeOf(form).name}.` : ''
  return { result: `thimble-cc-mod started its writer on the ${typeOf(form).name} "${r.title}" (${r.file}).${instead} The analyst watches it being written in the panel, and thimble-cc-mod tells you when it is done. Do not write it yourself: reply in one line that the writer has started.` }
}

/** The one dim line main's call of the tool shows as. */
export function reportToolLine(input: unknown): string {
  const x = (input ?? {}) as { form?: unknown; title?: unknown; request?: unknown }
  const what = typeof x.title === 'string' && x.title ? x.title : typeof x.request === 'string' ? x.request : ''
  return `  report · ${typeOf(isForm(x.form) ? x.form : undefined).name}${what ? ` "${clip(what, 60)}"` : ''}`
}

/** Main's call of the `report_highlight` tool: a highlighter started on the report named, else the one the panel
 *  shows, else the newest. */
export async function highlightTool(ctx: ReportCtx, e: { agentId?: string }): Promise<{ result: string } | { deny: string }> {
  if (e.agentId !== undefined) return { deny: 'thimble-cc-mod: only the main conversation highlights a report' }
  const x = e as unknown as { request?: unknown; report?: unknown }
  const request = typeof x.request === 'string' ? x.request : ''
  const named = typeof x.report === 'string' ? x.report.replace(/\.md$/, '').split('/').at(-1)! : ''
  const slug = (named && (await getReport(ctx, named)) ? named : '') || (await ctx.nav())?.slug || (await allReports(ctx)).find(r => r.state === 'ready')?.slug || ''
  if (!slug) return { deny: 'thimble-cc-mod has no report to highlight yet: the analyst can ask for one first' }
  const hl = await startHighlight(ctx, slug, request, true)
  if (!hl) return { deny: `thimble-cc-mod could not highlight in ${slug}: say what to highlight, in a report that is written` }
  await showReport(ctx, slug)
  const r = await getReport(ctx, slug)
  return { result: `thimble-cc-mod started a subagent that marks the passages of the report "${r?.title ?? slug}" for "${hl.label}"; the analyst sees them in the panel, each with its evidence. Reply in one line that it has started.` }
}

export function highlightToolLine(input: unknown): string {
  const x = (input ?? {}) as { request?: unknown }
  return `  report · highlight${typeof x.request === 'string' && x.request ? ` "${clip(highlightLabel(x.request), 60)}"` : ''}`
}

/** /thimble-report [type] <request>. */
export async function reportCommand(ctx: ReportCtx, args: string): Promise<{ text: string }> {
  const { form, request } = parseReportArgs(args)
  if (!request) return { text: 'say what the report is for: /thimble-report what happened in the wiki' }
  const r = await startReport(ctx, { form, title: '', request })
  return { text: r.state === 'error' ? `could not start the writer: ${r.why ?? ''}` : `the writer is writing the ${typeOf(form).name} "${r.title}"` }
}

/** /thimble-reports: the list in the panel. */
export async function reportsCommand(ctx: ReportCtx): Promise<{ text: string }> {
  await ctx.openPane('reports', 'Reports')
  const n = (await allReports(ctx)).length
  return { text: `${n} report${n === 1 ? '' : 's'}` }
}
