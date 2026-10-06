// The analysis harness: what the agents read of the corpus (coverage), a labeling tool like thimble's apply_label,
// and /thimble-orient, an orientation run as a fork whose coverage is checked before it may end.
//
// - Coverage. Every tool result of main and of every subagent (session.append) is handed to helper/coverage.py, which
//   decides which files and records it showed or scanned (helper/pyaudit notes the files Python opens). Home's Files
//   section shows each folder's and file's records and the share read, /thimble-coverage opens the panel (each file,
//   what was read of it, and what was never opened), and main gets the line with each prompt. When main ends a turn on an answer that speaks for the corpus as a whole while a kind of file
//   was never opened, the check's text shows under the answer, and main reads the same text with the analyst's next
//   prompt; main starts no turn of its own for it.
// - Labels. Main's `label` tool defines a category over the records of some files (a prompt, a regex or a code
//   predicate), tries it on a sample or applies it to all, and answers with the counts, examples of each value and
//   two cards. A prompt label's records are judged by model calls in batches ($.model.complete, thimble's labels
//   prompt); a regex or code label runs in helper/labels.py. The panel shows the label after the browser's label
//   editor: its fields (type, scope, the definition, values, sample), each editable, its counts, its examples folded
//   (the analyst can agree or set a record's value, which wins and teaches the next run), the cards that read it, and
//   "run on the sample" and "run on all". Labels are kept in .thimble-cc-mod/labels.json, where the views read them.
// - The orientation. /thimble-orient [brief] starts a fork with prompt/orient.md as a report writer, so the panel shows
//   it working and then draws its document. It hears nothing of the count while it works. When it ends, the
//   coverage line (thimble's orient_checks.coverage: the files whose lines its calls showed, by glob, and its share of
//   the files and their lines) ends its document, shows in main's chat, and goes to main with the next prompt, so the
//   analyst and main read the same line.
//
// register.tsx hands this module what it shares (HarnessCtx, built on ReportCtx) and calls it from its hooks.
import type { MatchedEvent, ModelCompleteRequest, ModelCompleteResult, RenderElement, ResolveInput } from 'claude-code'

import type { ChatCoverage, ChatLabel, ChatLabelExample, ChatReport } from '../types'
import { clip } from './lib'
import { demojibake, placeWords, valueColour, width } from './draw'
import type { Line } from './draw'
import { ACCENT, FRESH, LINK, MARGIN_W, controlsEl, headerEls, hintsEl, lineEl, marginKey, pointed, ruleEl, spread, subLine } from './chrome'
import { COLORS } from './paint'
import type { ReportCtx } from './reports'
import { slugOf } from './report'
import { withGuide } from './threads'
import { LABEL_USAGE, ORIENT_DEFAULTS, labelInputOf, labelLine, namesOnly, orientLine, orientOptsOf, parseLabelArgs, parseOrientArgs } from './commands'
import type { OrientOpts } from './commands'
import { startReport } from './reports'

type PaneEvent = MatchedEvent<'ui.render', { component: 'Pane'; requestId: string }>

/** What register.tsx shares with the harness, bound to the hook's `$` (register.tsx harnessCtx). */
export type HarnessCtx = ReportCtx & {
  /** `run` in the sandbox of the mod's own scripts (register.tsx boxRun), for the label runs that run code */
  boxed: ReportCtx['run']
  /** the agents `ids` and every agent spawned under them, at any depth */
  children: (ids: string[]) => Promise<string[]>
  session: () => Promise<string>
  sleep: (ms: number) => Promise<void>
  complete: (req: ModelCompleteRequest) => Promise<ModelCompleteResult>
  labelModel: () => Promise<string>
  coverage: () => Promise<ChatCoverage | null>
  setCoverage: (c: ChatCoverage) => Promise<void>
  label: (slug: string) => Promise<ChatLabel | undefined>
  setLabel: (l: ChatLabel) => Promise<void>
  labelOpen: () => Promise<string>
  setLabelOpen: (slug: string) => Promise<void>
  openHarness: (view: 'coverage' | 'label' | 'labels', title: string) => Promise<void>
  /** a card in the panel */
  openCard: (id: string) => Promise<void>
  /** cards whose files labels.py wrote again: drawn again, and the citations of them checked again */
  cardsChanged: (ids: string[]) => Promise<void>
  thread: (about: { label: string; context: string }) => Promise<void>
  /** words for main, as the analyst's prompt (a new label described in the labels list) */
  submit: (text: string) => Promise<void>
  /** the label panel's parts opened (`<slug>:examples`, `<slug>:cards`) */
  labelOpened: () => Promise<string[]>
  setLabelOpened: (open: string[]) => Promise<void>
  toast: (text: string) => void
  log: (text: string) => void
}

// ------------------------------------------------------------------------------------------------ coverage

/** The tools whose results show or scan the corpus. Glob lists names only. */
const TRACKED = new Set(['Read', 'Bash', 'Grep'])
type CovEvent = { agent: string; tool: string; input: unknown; output: unknown; t: number; session: string }
const calls = new Map<string, { agent: string; tool: string; input: unknown }>() // a tracked call not answered yet
let covQueue: CovEvent[] = []
let covRunning = false
let covIdle: Promise<void> = Promise.resolve()
let covDetail: { at: number; data: CoverageSummary | null } = { at: -1, data: null }

/** A file as helper/coverage.py's summary gives it. */
export type CoverageFile = { file: string; size: number; records: number | null; seen: number; judged?: number; state: 'read' | 'scanned' | 'untouched'; ranges: number[][]; agents: string[] }
export type CoverageKind = { kind: string; files: number; read: number; scanned: number; untouched: number; records: number; records_seen: number }
export type CoverageSummary = {
  line: string
  totals: { files: number; read: number; scanned: number; untouched: number; records: number; records_seen: number; records_judged?: number; bytes: number; bytes_seen: number }
  kinds: CoverageKind[]
  files: CoverageFile[]
  capped?: boolean
}

/** A row of a conversation (session.append): a tracked call remembered, a tracked call's result queued for the count. */
export function coverageAppend(ctx: HarnessCtx, agentId: string | undefined, door: string, content: unknown): void {
  if (!Array.isArray(content)) return
  const blocks = content as { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown }[]
  if (door === 'response') {
    for (const b of blocks) if (b.type === 'tool_use' && b.id && b.name && TRACKED.has(b.name)) calls.set(b.id, { agent: agentId ?? 'main', tool: b.name, input: b.input })
    return
  }
  if (door !== 'tool-result') return
  let added = false
  for (const b of blocks) {
    const c = b.type === 'tool_result' && b.tool_use_id ? calls.get(b.tool_use_id) : undefined
    if (!c || !b.tool_use_id) continue
    calls.delete(b.tool_use_id)
    covQueue.push({ ...c, output: b.content, t: 0, session: '' })
    added = true
  }
  if (added && !covRunning) covIdle = flushCoverage(ctx)
}

async function flushCoverage(ctx: HarnessCtx): Promise<void> {
  covRunning = true
  try {
    const { cwd, root } = await ctx.where()
    const session = await ctx.session()
    while (covQueue.length) {
      const now = (await ctx.now()) / 1000
      const batch = covQueue.splice(0).map(ev => ({ ...ev, t: now, session }))
      const r = await ctx.run(['python3', `${root}/helper/coverage.py`, 'record'], { cwd, stdin: JSON.stringify({ cwd, session, events: batch }), timeoutMs: 120000 })
      if (r.exitCode !== 0) {
        ctx.log(`thimble-cc-mod: the coverage count failed: ${clip(r.stderr.trim().split('\n').at(-1) ?? '', 200)}`)
        continue
      }
      const got = JSON.parse(r.stdout) as { line: string; totals: CoverageSummary['totals']; unopened?: string[] }
      const t = got.totals
      await ctx.setCoverage({ line: got.line, files: t.files, read: t.read, scanned: t.scanned, untouched: t.untouched, records: t.records, recordsSeen: t.records_seen, unopened: got.unopened ?? [], at: await ctx.now() })
    }
  } catch (err) {
    ctx.log(`thimble-cc-mod: the coverage count failed: ${clip(String(err), 200)}`)
  } finally {
    covRunning = false
  }
}

/** The whole summary of this session's reads, each file with what was read of it (`agents`: only theirs). */
export async function coverageSummary(ctx: HarnessCtx, agents: string[] = []): Promise<CoverageSummary | null> {
  await covIdle
  const { cwd, root } = await ctx.where()
  const session = await ctx.session()
  // a run cut short (a reload of the hooks, a drawing that gave way to the next) is no summary, never a throw out of a
  // drawing
  const r = await ctx.run(['python3', `${root}/helper/coverage.py`, 'summary', '--cwd', cwd, '--session', session, ...agents.flatMap(a => ['--agent', a])], { cwd, timeoutMs: 120000 }).catch(() => null)
  if (!r || r.exitCode !== 0) return null
  try {
    return JSON.parse(r.stdout) as CoverageSummary
  } catch {
    return null
  }
}

/** A share as the line shows it (helper/coverage.py pct). */
export function pct(a: number, b: number): string {
  if (!b || !a) return '0%'
  const p = (100 * a) / b
  return p < 0.1 ? '<0.1%' : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`
}

function num(n: number): string {
  return n.toLocaleString('en-US')
}

/** "1-40, 88, 1203-1250", the first `n` runs: line numbers name lines, so they read as written (views/SPEC.md, "Words
 *  that recur"). */
export function rangeWords(ranges: number[][], n = 6): string {
  const shown = ranges.slice(0, n).map(([a = 0, b = 0]) => (a === b ? String(a) : `${a}-${b}`))
  return `${shown.join(', ')}${ranges.length > n ? ', …' : ''}`
}

/** Words of a reply that speak for the corpus as a whole. */
const GENERAL = /\b(all|every|each|most|majority|none|never|always|only|nobody|no one|overall|in general|typically|throughout|across the)\b/i

/** The check of an answer that speaks for the corpus as a whole while a kind of file was never opened, or had no record
 *  read (only counted over by code), or null when nothing calls for it: a short answer with no citation, card or
 *  heading never does. The analyst reads it under the answer and main with the next prompt, the same words. */
export function critiqueOf(s: CoverageSummary, answer: string): string | null {
  const substantial = answer.length > 400 || /\[\[/.test(answer) || /^##\s/m.test(answer)
  if (!substantial || !GENERAL.test(answer) || !s.totals.files) return null
  const missed = new Set(s.kinds.filter(k => k.untouched === k.files).map(k => k.kind))
  const unread = new Set(s.kinds.filter(k => !missed.has(k.kind) && k.records > 0 && k.records_seen === 0).map(k => k.kind))
  if (!missed.size && !unread.size) return null
  const untouched = s.files.filter(f => f.state === 'untouched')
  const counted = s.files.filter(f => f.state === 'scanned' && unread.has(kindOf(f.file)))
  const name = (f: CoverageFile) => `${f.file} (${f.records !== null ? `${num(f.records)} records` : `${num(f.size)} bytes`})`
  const list = (fs: CoverageFile[]) => `${fs.slice(0, 8).map(name).join(', ')}${fs.length > 8 ? `, and ${fs.length - 8} more` : ''}`
  const parts = [`Coverage check: this session has ${s.line}.`]
  if (missed.size) parts.push(`No call opened ${missed.size === 1 ? 'this kind of file' : `these ${missed.size} kinds of file`}: ${list(untouched)}.`)
  if (unread.size) parts.push(`Code counted over ${unread.size === 1 ? 'this kind of file' : `these ${unread.size} kinds of file`}, but no call showed any of ${unread.size === 1 ? 'its' : 'their'} records: ${list(counted)}.`)
  parts.push('The answer speaks for the corpus as a whole but rests only on the files read.')
  return parts.join(' ')
}

/** A file's kind, as helper/coverage.py kind_of masks it: ids and numbers in its path replaced. */
export function kindOf(file: string): string {
  return file.replace(/(?=[0-9a-f]*\d)[0-9a-f]{8,}/gi, '*').replace(/\d+/g, '#')
}

/** The line main gets with each prompt: what this session has read, and the files nothing opened. */
export async function coverageContext(ctx: HarnessCtx): Promise<string> {
  const c = await ctx.coverage()
  if (!c || c.files === 0) return ''
  return `thimble-cc-mod coverage so far in this session: ${c.line} (of ${num(c.records)} records in ${c.files} files). \`python3 {{helper}}/coverage.py\` lists each file.`
}

const BAR = 12

/** What was read of a file as a bar of `w` cells on a track to the whole: `█` dim (a mark no colour names), then `─` in
 *  the rule grey. */
function shareBar(seen: number, total: number, state: string, w = BAR): { on: string; off: string } {
  const n = state === 'untouched' ? 0 : total ? Math.max(seen ? 1 : 0, Math.round((w * seen) / total)) : seen ? w : 0
  return { on: '█'.repeat(n), off: '─'.repeat(w - n) }
}

/** Hotkeys with no label of their own (views/SPEC.md, "The visual system", rule 24), as register.tsx hiddenKeys. */
function hiddenKeys(ctx: HarnessCtx, e: PaneEvent, keys: { key: string; hotkey: string; onPress: () => void }[]): RenderElement | null {
  if (!keys.length || e.surface === 'mobile') return null
  const { Box, Button } = ctx.els(e as unknown as ResolveInput)
  return (
    <Box key="hidden-keys" width={0} height={0} flexShrink={0} overflow="hidden" flexDirection="row">
      {keys.map(k => (
        <Button key={k.key === 'close' ? 'close' : k.key.startsWith('=') ? k.key.slice(1) : `hk-${k.key}`} label={k.hotkey} hotkey={k.hotkey} plain onPress={k.onPress} />
      ))}
    </Box>
  )
}

/** The summary last read and the count it was read at, without reading it again (a drawing cannot wait for it). */
export function coverageLast(): { at: number; data: CoverageSummary | null } {
  return covDetail
}

/** The summary as the count last left it, read again only when the count has changed. */
export async function coverageDetail(ctx: HarnessCtx): Promise<CoverageSummary | null> {
  const at = (await ctx.coverage())?.at ?? 0
  if (covDetail.at !== at || !covDetail.data) {
    const data = await coverageSummary(ctx)
    if (data) covDetail = { at, data }
    else return covDetail.data
  }
  return covDetail.data
}

/** The count's line without what a label judged: the panel says what the agents read (views/SPEC.md, "The coverage
 *  panel"); main's note keeps it. */
function readLine(line: string): string {
  return line
    .split(' · ')
    .filter(p => !/judged by a label/.test(p))
    .join(' · ')
}

/** The coverage panel (views/SPEC.md, section 7, "The coverage panel"): its title and the count's line dim under it;
 *  under the rule, a row per file, those nothing opened first: its state (● read, ○ not), its name, a bar of what was
 *  read on a track that takes the room the name and the numbers leave, its records and the share read against R; a
 *  dim secondary row of the lines read; after a blank row, `all` dim with the corpus's records and the share read; at
 *  the bottom, `read what was missed`. It does not say how many records a label judged. */
export async function drawCoverage(e: PaneEvent, ctx: HarnessCtx): Promise<RenderElement> {
  const { Box, Text, Button } = ctx.els(e as unknown as ResolveInput)
  const els = { Box, Text, Button }
  const s = await coverageDetail(ctx)
  const cols = Math.max(30, e.props.bodyColumns)
  const gaps = s ? s.files.filter(f => f.state !== 'read').map(f => f.file) : []
  const askMissed = () =>
    void ctx.thread({
      label: 'the files no answer has read',
      context: `thimble-cc-mod's coverage count of this session: ${s?.line ?? ''}. Files with no record read: ${gaps.slice(0, 30).join(', ')}.\nRead a sample of each (start, middle, end), say what each holds and whether it changes any answer so far.`,
    })
  const rows: RenderElement[] = [...headerEls(els, { title: 'Coverage', cols, sub: subLine([s ? readLine(s.line) : "what this session's agents read of the corpus"]) })]
  if (!s) {
    rows.push(<Text key="cov-none" dimColor>{'  none'}</Text>)
  } else {
    const t = s.totals
    const order = { untouched: 0, scanned: 1, read: 2 } as const
    const files = [...s.files].sort((a, b) => order[a.state] - order[b.state] || b.size - a.size)
    const recs = files.map(f => (f.records !== null ? num(f.records) : `${num(f.size)} B`))
    const recW = Math.max(7, ...recs.map(r => r.length))
    const shares = files.map(f => (f.state === 'read' ? pct(f.seen, (f.records ?? 0) || 1) : ''))
    const shareW = Math.max(4, ...shares.map(x => x.length))
    const nameW = Math.max(8, Math.min(36, Math.max(...files.map(f => f.file.length))))
    // the bar takes what the name and the numbers leave, so the share ends on R (rule 4)
    const barW = Math.max(BAR, cols - 2 - nameW - 2 - 2 - recW - 2 - shareW)
    // the column names, dim, over the numbers they name
    rows.push(<Text key="cov-head" dimColor>{`${' '.repeat(2 + nameW + 2 + barW + 2)}${'records'.padStart(recW)}  ${'read'.padStart(shareW)}`}</Text>)
    files.slice(0, 60).forEach((f, i) => {
      const total = f.records ?? 0
      const bar = shareBar(f.seen, total, f.state, barW)
      const what = f.state === 'untouched' ? 'never opened' : f.state === 'scanned' ? 'counted by code, no record read' : `${f.ranges.length === 1 && f.ranges[0]![0] === f.ranges[0]![1] ? 'line' : 'lines'} ${rangeWords(f.ranges, 4)}`
      const firstUnread = f.state === 'read' ? (f.ranges[0]?.[0] === 1 ? (f.ranges[0]?.[1] ?? 0) + 1 : 1) : 1
      rows.push(
        <Box key={`cov-f:${f.file}`} flexDirection="column">
          <Box flexDirection="row">
            <Text {...(f.state === 'read' ? {} : { dimColor: true })}>{f.state === 'read' ? '● ' : '○ '}</Text>
            <Box width={nameW} flexShrink={0}>
              <Button key={`cov-open:${f.file}`} label={clip(f.file, nameW)} plain onPress={() => void ctx.openRef(total ? `${f.file}#L${Math.min(firstUnread, total)}` : f.file)} />
            </Box>
            <Text>{'  '}</Text>
            <Text>
              <Text dimColor>{bar.on}</Text>
              <Text color={COLORS.rule}>{bar.off}</Text>
            </Text>
            <Text>{`  ${recs[i]!.padStart(recW)}`}</Text>
            <Text dimColor>{`  ${shares[i]!.padStart(shareW)}`}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">{`  ${what}`}</Text>
        </Box>,
      )
    })
    if (files.length > 60) rows.push(<Text key="cov-more" dimColor>{`  … ${files.length - 60} more`}</Text>)
    // the whole, as a row of the table after a blank row: its records and the share of them seen in a call's output
    rows.push(<Text key="cov-all-gap"> </Text>)
    rows.push(
      <Text key="cov-all" wrap="truncate-end">
        <Text dimColor>{`  ${'all'.padEnd(nameW)}  ${' '.repeat(barW)}  `}</Text>
        <Text>{num(t.records).padStart(recW)}</Text>
        <Text dimColor>{`  ${pct(t.records_seen, t.records || 1).padStart(shareW)}`}</Text>
      </Text>,
    )
  }
  // the bottom: the thread that reads what was missed
  if (gaps.length) {
    rows.push(ruleEl(els, cols, 'cov-rule2'))
    rows.push(controlsEl(els, [<Button key="cov-ask" label="read what was missed" plain onPress={askMissed} />], 'cov-controls')!)
  }
  rows.push(hintsEl(els, [...(gaps.length ? ['r to read what was missed'] : []), 'b to go back', 'x to close'], cols))
  const hk = hiddenKeys(ctx, e, [...(gaps.length ? [{ key: 'ask', hotkey: 'r', onPress: askMissed }] : []), { key: 'close', hotkey: 'x', onPress: () => void ctx.closePanel() }])
  if (hk) rows.unshift(hk)
  return <Box flexDirection="column">{rows}</Box>
}

/** /thimble-coverage: the panel, and the line; /thimble-coverage check on|off turns the check after a turn on or off. */
export async function coverageCommand(ctx: HarnessCtx, args = ''): Promise<{ text: string }> {
  const m = /^\s*check\s+(on|off)\s*$/i.exec(args)
  if (m) {
    setChecking(m[1]!.toLowerCase() === 'on')
    return { text: `the coverage check after an answer is ${m[1]!.toLowerCase()}` }
  }
  await ctx.openHarness('coverage', 'Coverage')
  const line = (await ctx.coverage())?.line
  return { text: line ? readLine(line) : 'nothing read yet' }
}

// ------------------------------------------------------------------------------------------------ the check after a turn

// The check runs at main's turn.complete (Claude Code hands a hooks module no classic Stop: checked live on 2.1.290).
// Its text shows under the answer and goes to main with the analyst's next prompt (register.tsx); main starts no turn
// of its own for it, as thimble's coverage feedback reaches the agent and the analyst at the end of a run.
let checking = true // /thimble-coverage check on|off

/** At the end of main's turn: the check when the answer speaks for the whole corpus while a kind of file was never
 *  opened, else null. */
export async function coverageAfterTurn(ctx: HarnessCtx, answer: string): Promise<string | null> {
  if (!checking || !answer.trim()) return null
  const s = await coverageSummary(ctx)
  return s ? critiqueOf(s, answer) : null
}

/** The check as main reads it with the analyst's next prompt: the words the analyst read under the answer, and where
 *  to look. */
export function checkNote(check: string, helper: string): string {
  return `thimble-cc-mod: the analyst read this coverage check under your last answer: "${check}" \`python3 ${helper}/coverage.py\` lists what was read of each file.`
}

/** /thimble-coverage check on|off. */
export function setChecking(on: boolean): void {
  checking = on
}

// ------------------------------------------------------------------------------------------------ the orientation

/** An orientation's round: its report, the analyst's request and switches, whether the critique ran, and `by`, the
 *  forks that did the analysis, whose reads (and their subagents') the coverage line counts, never the critique's. */
type Orient = { slug: string; file: string; brief: string; opts: OrientOpts; critiqued: boolean; by: string[] }

const orients = new Map<string, Orient>() // an orientation's agent -> its round
let starting = false // an orientation asked for whose first fork has not started yet
const CRITIQUE = ' · critique and revision'

const ORIENT_LABEL = 'report · orientation'

/** An orientation's record, by its agent: kept in this module, else (after a reload of the hooks, which starts the
 *  module over) read back from the agent's and the report's state. */
async function orientOf(ctx: HarnessCtx, agentId: string | undefined): Promise<Orient | undefined> {
  if (!agentId) return undefined
  const kept = orients.get(agentId)
  if (kept) return kept
  const a = await ctx.agent(agentId)
  if (a?.kind !== 'report' || !a.report || !a.label.startsWith(ORIENT_LABEL)) return undefined
  const r = await ctx.report(a.report)
  const brief = r && !/^an orientation of the whole corpus$/.test(r.request) ? r.request : ''
  const o: Orient = { slug: a.report, file: r?.file ?? `${ctx.home}/reports/${a.report}.md`, brief, opts: { brief, ...ORIENT_DEFAULTS, ...(r?.orient ?? {}) }, critiqued: a.label.endsWith(CRITIQUE), by: r?.orientBy ?? [] }
  orients.set(agentId, o)
  return o
}

/** Whether a subagent is an orientation's (orientOf). */
export async function isOrient(ctx: HarnessCtx, agentId: string | undefined): Promise<boolean> {
  return Boolean(await orientOf(ctx, agentId))
}

/** The corpus as the orientation's prompt lists it: each file with its records, from the coverage count. */
function listing(s: CoverageSummary | null): string {
  if (!s) return '(thimble-cc-mod could not list the files: list them yourself.)'
  const lines = s.files.slice(0, 80).map(f => `- ${f.file}: ${f.records !== null ? `${num(f.records)} records (lines)` : 'binary'}, ${num(f.size)} bytes`)
  return [`${s.totals.files} files, ${num(s.totals.records)} records in all:`, ...lines, ...(s.files.length > 80 ? [`- … ${s.files.length - 80} more`] : [])].join('\n')
}

/** A prompt's parts: `{{#name}}…{{/name}}` kept when `on[name]` is true, `{{^name}}…{{/name}}` when it is not, then
 *  `{{key}}` filled from `values`. */
export function fillPrompt(text: string, on: Record<string, boolean>, values: Record<string, string>): string {
  let out = text
  for (let i = 0; i < 4; i++) {
    const next = out.replace(/\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_m, sign: string, name: string, body: string) => ((sign === '#') === Boolean(on[name]) ? body : ''))
    if (next === out) break
    out = next
  }
  return out.replace(/\n{3,}/g, '\n\n').replace(/\{\{(\w+)\}\}/g, (m, k: string) => values[k] ?? m)
}

/** /thimble-orient [brief] [deck=on|off] [--no-views] …: the analyst's arguments read, then orientStart. */
export async function orientCommand(ctx: HarnessCtx, args: string): Promise<{ text: string }> {
  const got = parseOrientArgs(args)
  if ('error' in got) return { text: got.error }
  const started = await orientStart(ctx, got.opts)
  return { text: 'error' in started ? started.error : `orienting · ${orientLine(got.opts)}` }
}

export const ORIENT_TOOL = 'mcp__thimble-cc-mod__orient'
export const ORIENT_DESCRIPTION = [
  "Start thimble-cc-mod's orientation, as the analyst's /thimble-orient does: a subagent outside this conversation surveys every file of the corpus and writes a short document the analyst reads in the panel, then the outputs its switches turn on. It returns at once, and thimble-cc-mod tells you when the orientation is done.",
  'Call it when the analyst asks for an orientation, or for an overview of the whole corpus they have not seen yet, with their focus as `brief`. Set a switch only when the analyst names it, such as "without a report" or "with a critique"; a switch left out keeps thimble\'s Start default (the deck, views and report on, the critique off). One orientation runs at a time.',
].join(' ')
export const ORIENT_SCHEMA = {
  type: 'object',
  properties: {
    brief: { type: 'string', description: "what the analyst wants the orientation to focus on, in their words; empty for the whole corpus" },
    deck: { type: 'boolean', description: 'the document holds five to eight cards (default true); false: a document without cards' },
    views: { type: 'boolean', description: 'it proposes up to four views, which are built in the background (default true)' },
    critique: { type: 'boolean', description: 'a reviewer who did not do the analysis checks the document against the records and revises it (default false)' },
    report: { type: 'boolean', description: "thimble-cc-mod's writer writes a fuller report from the document once the orientation ends (default true)" },
  },
}

/** Main's call of the `orient` tool: the same options as the command. */
export async function orientTool(ctx: HarnessCtx, e: { agentId?: string } & Record<string, unknown>): Promise<{ result: string } | { deny: string }> {
  if (e.agentId !== undefined) return { deny: 'thimble-cc-mod: only the main conversation starts an orientation' }
  const got = orientOptsOf(e)
  if ('error' in got) return { deny: `thimble-cc-mod orient: ${got.error}` }
  const started = await orientStart(ctx, got.opts)
  if ('error' in started) return { deny: `thimble-cc-mod orient: ${started.error}` }
  return { result: `thimble-cc-mod started the orientation (${orientLine(got.opts)}); it writes ${started.file}. The analyst watches it in the panel, and thimble-cc-mod tells you when it is done. Reply in one line that it has started.` }
}

/** The one dim line main's call of the tool shows as. */
export function orientToolLine(input: unknown): string {
  const got = orientOptsOf((input ?? {}) as Record<string, unknown>)
  return `  orient · ${'error' in got ? got.error : orientLine(got.opts)}`
}

/** An orientation: a report writer that orients, its record and the panel at once, the fork after main's turn. */
export async function orientStart(ctx: HarnessCtx, opts: OrientOpts): Promise<{ file: string } | { error: string }> {
  if (starting || orients.size) return { error: 'an orientation is already running; it shows in the panel (/thimble-reports)' }
  starting = true
  try {
    const { cwd, root } = await ctx.where()
    let taken = new Set<string>()
    try {
      taken = new Set((await ctx.list(`${cwd}/${ctx.home}/reports`)).map(f => f.replace(/\.(film\.json|json|md|mp4)$/, '')))
    } catch {
      taken = new Set()
    }
    const brief = opts.brief.trim()
    const slug = slugOf('orientation', taken)
    const title = brief ? `Orientation: ${clip(brief, 60)}` : 'Orientation'
    const { brief: _b, ...switches } = opts
    const r: ChatReport = { slug, form: 'document', title, request: brief || 'an orientation of the whole corpus', file: `${ctx.home}/reports/${slug}.md`, state: 'writing', tools: 0, partial: '', problems: [], created: await ctx.now(), orient: switches }
    await ctx.setReport(r)
    await ctx.write(`${cwd}/${ctx.home}/reports/${slug}.json`, JSON.stringify(r, null, 1)).catch(() => undefined)
    await ctx.setNav({ slug, slide: 0, notes: false, open: [] })
    await ctx.openPane('report', title)
    const values: Record<string, string> = {
      brief: brief || '(none: orient the analyst to the whole corpus)',
      listing: listing(await coverageSummary(ctx)),
      helper: `${root}/helper`,
      file: r.file,
      slug,
    }
    const prompt = fillPrompt(await ctx.read(`${root}/prompt/orient.md`), switches, values)
    // the guidance rides along: a fork of a conversation that has had no prompt yet has not read it
    const full = withGuide(await ctx.guide(), prompt)
    await ctx.afterTurn(async () => {
      try {
        const label = `${ORIENT_LABEL}${brief ? ` · ${clip(brief, 30)}` : ''}`
        const s = await ctx.spawn(full, label, full)
        if ('deny' in s) {
          await ctx.setReport({ ...r, state: 'error', why: `could not start the orientation: ${s.deny}` })
          return
        }
        orients.set(s.agentId, { slug, file: r.file, brief, opts, critiqued: false, by: [s.agentId] })
        await ctx.setAgent(s.agentId, { kind: 'report', label, report: slug })
        await ctx.setReport({ ...((await ctx.report(slug)) ?? r), agentId: s.agentId, orientBy: [s.agentId] })
      } finally {
        starting = false
      }
    })
    return { file: r.file }
  } catch (err) {
    starting = false
    return { error: `could not start the orientation: ${clip(String(err), 160)}` }
  }
}

/** A follow-up round of an orientation: a fork with `prompt`, which takes over its report. */
async function orientRound(ctx: HarnessCtx, o: Orient, prompt: string, suffix: string, partial: string, next: Partial<Orient>): Promise<boolean> {
  const label = `${ORIENT_LABEL}${suffix}`
  const sp = await ctx.spawn(prompt, label, prompt)
  if ('deny' in sp) return false
  orients.set(sp.agentId, { ...o, ...next })
  await ctx.setAgent(sp.agentId, { kind: 'report', label, report: o.slug })
  const r = await ctx.report(o.slug)
  if (r) await ctx.setReport({ ...r, agentId: sp.agentId, partial })
  return true
}

/** An orientation's round ended. When the critique is on, a fork that did not do the analysis reviews the document and
 *  revises it; while it runs the report stays "writing" (true). Else the coverage line ends the document, shows in
 *  main's chat and goes to main with the next prompt, the writer starts when the report is on, and the reports module
 *  may show the document (false). The orientation hears nothing of the count while it works, and gets no second round:
 *  the analyst can ask for more, or turn the critique on. Claude Code here hands a hooks module no classic
 *  SubagentStop, which would have kept the orientation itself going. */
export async function orientEnded(ctx: HarnessCtx, agentId: string, reason: string): Promise<boolean> {
  const o = await orientOf(ctx, agentId)
  if (!o) return false
  orients.delete(agentId)
  const { cwd, root } = await ctx.where()
  const written = await ctx.read(`${cwd}/${o.file}`).then(t => t.trim().length > 0, () => false)
  const values: Record<string, string> = { file: o.file, brief: o.brief || '(none: the whole corpus)', helper: `${root}/helper`, slug: o.slug }
  const on = { deck: o.opts.deck, views: o.opts.views, critique: o.opts.critique, report: o.opts.report }
  if (o.opts.critique && !o.critiqued && written && reason === 'answer') {
    const prompt = withGuide(await ctx.guide(), fillPrompt(await ctx.read(`${root}/prompt/orient-critique.md`), on, values))
    if (await orientRound(ctx, o, prompt, CRITIQUE, 'a reviewer checks the document against the records', { critiqued: true })) return true
  }
  // an orientation that finished (not one stopped or failed): the coverage line of the forks that did the analysis and
  // the subagents under them (the whole session's when they are not known: an orientation begun before a reload of
  // the hooks by an older mod)
  const roots = o.by.length ? o.by : o.critiqued ? [] : [agentId]
  const s = reason === 'answer' ? await coverageSummary(ctx, roots.length ? await ctx.children(roots) : []) : null
  const line = s ? coverageLine(s) : ''
  if (written && line) {
    const text = await ctx.read(`${cwd}/${o.file}`).catch(() => '')
    if (text.trim() && !/^Coverage: /m.test(text)) await ctx.write(`${cwd}/${o.file}`, `${text.trimEnd()}\n\n${line}\n`)
  }
  if (line) {
    // the engine draws a plugin's log line after the plugin's name
    ctx.log(`the orientation ended · ${line}`)
    await ctx.noteMain(`thimble-cc-mod: the orientation ended; the analyst read this line in the chat${written ? ` and at the end of its document ${o.file}` : ''}: "${line}"`)
  }
  // the report: thimble starts its writer once the orientation ends; it retells the document, citing its cards. Its
  // working title, and so its file name, leaves out "report": Claude Code refuses a subagent's Write of a file named
  // like a report ("Subagents should return findings as text, not write report files"; seen live on 2.1.289)
  if (written && o.opts.report && reason === 'answer') {
    const title = o.brief ? `${o.brief.charAt(0).toUpperCase()}${o.brief.slice(1)}` : 'What the orientation found'
    await startReport(ctx, {
      form: 'document',
      title,
      request: `The analyst's report of the orientation${o.brief ? ` (its focus: ${o.brief})` : ''}: a fuller account of its findings than ${o.file}, drawn from that document${o.opts.deck ? ' and its cards, which it cites' : ''} and checked against the records.`,
      source: o.file,
    }).catch((err: unknown) => ctx.log(`thimble-cc-mod: could not start the orientation's report: ${clip(String(err), 160)}`))
  }
  return false
}

const COVERAGE_GLOBS = 8 // globs the line groups files into; past this, by top folder (orient_checks.COVERAGE_GLOBS)
const COVERAGE_LISTED = 6 // globs of viewed files the line names; the rest are counted
const COVERAGE_NAMED = 2 // a glob with this few files viewed has them named

/** n of total as a whole percentage, 100% only when it is all, 0% only when none and <1% below a half
 *  (orient_checks._share). */
export function share(n: number, total: number): string {
  if (total <= 0 || n <= 0) return '0%'
  if (n >= total) return '100%'
  if ((100 * n) / total < 0.5) return '<1%'
  return `${Math.min(99, Math.round((100 * n) / total))}%`
}

/** The glob a file is grouped under: its folder with ids masked and its suffix (`runs/run-12/log.jsonl` is
 *  `runs/run-*\/*.jsonl`), or with `top` its top folder whole (`runs/**`); a file at the root goes by its suffix
 *  (orient_checks._glob). */
export function globOf(rel: string, top = false): string {
  const cut = rel.lastIndexOf('/')
  const folder = cut < 0 ? '' : rel.slice(0, cut)
  const name = rel.slice(cut + 1)
  const dot = name.lastIndexOf('.')
  const suffix = dot > 0 ? name.slice(dot) : ''
  if (folder && top) return `${folder.split('/')[0]}/**`
  if (folder) return `${kindOf(folder).replaceAll('#', '*')}/*${suffix}`
  return `*${suffix}`
}

/** The coverage line of an orientation, as thimble's (orient_checks.coverage) words it: the files whose lines its calls
 *  showed, grouped by glob (a glob viewed whole, a file alone in its glob, the files of a glob viewed in part when they
 *  are COVERAGE_NAMED or fewer, else the glob with how many), then its share of the files and of their lines.
 *  "Coverage: viewed only events/*.jsonl · 22% of files · 12% of lines". A file only counted over by code is not viewed. */
export function coverageLine(s: CoverageSummary): string {
  const files = s.files
  const viewed = files.filter(f => f.state === 'read')
  const lines = files.reduce((n, f) => n + (f.records ?? 0), 0)
  const seen = viewed.reduce((n, f) => n + Math.min(f.seen, f.records ?? 0), 0)
  const shares = lines ? `${share(viewed.length, files.length)} of files · ${share(seen, lines)} of lines` : `${share(viewed.length, files.length)} of files`
  if (!viewed.length) return `Coverage: viewed no file · ${shares}`
  if (viewed.length === files.length) return `Coverage: viewed every file · ${shares}`
  let groups = new Map<string, CoverageFile[]>()
  for (const f of files) groups.set(globOf(f.file), [...(groups.get(globOf(f.file)) ?? []), f])
  if (groups.size > COVERAGE_GLOBS) {
    groups = new Map()
    for (const f of files) groups.set(globOf(f.file, true), [...(groups.get(globOf(f.file, true)) ?? []), f])
  }
  const recs = (fs: CoverageFile[]) => fs.reduce((n, f) => n + (f.records ?? 0), 0)
  const side: [number, string][] = []
  for (const [g, fs] of groups) {
    const opened = fs.filter(f => f.state === 'read')
    if (!opened.length) continue
    if (opened.length === fs.length) side.push([recs(fs), fs.length === 1 ? fs[0]!.file : g])
    else if (opened.length <= COVERAGE_NAMED) side.push(...opened.map(f => [f.records ?? 0, f.file] as [number, string]))
    else side.push([recs(opened), `${g} (${num(opened.length)} of ${num(fs.length)} ${fs.length === 1 ? 'file' : 'files'})`])
  }
  const names = side.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1])).map(x => x[1])
  const listed = names.slice(0, COVERAGE_LISTED).join(', ') + (names.length > COVERAGE_LISTED ? `, and ${num(names.length - COVERAGE_LISTED)} more` : '')
  return `Coverage: viewed only ${listed} · ${shares}`
}

// ------------------------------------------------------------------------------------------------ labels

export const LABEL_TOOL = 'mcp__thimble-cc-mod__label'
export const LABEL_DESCRIPTION = [
  "thimble-cc-mod's labeling tool: define a category over the records of some files and apply it to each record, as thimble's apply_label does. The analyst sees the label in the panel (its definition, counts and examples of each value) and can correct it.",
  'A record is a line of a text file (a JSON line is read as its object) or a row of a CSV file. kind "regex": a Python pattern searched in each record (its field when `field` is given); a match takes the first value, any other record the last. kind "code": Python defining label(unit) that returns (value, confidence), where unit is the JSON record\'s dict, a CSV row\'s dict or {"text": line}. kind "prompt": a model reads each record against `definition`, for a category that takes reading for meaning.',
  'Use it whenever you sort records into categories, instead of a regex or keyword test inside a script. Try a new label with `limit` (about 30 records, spread over the files), read its examples, fix the definition, then run it again without `limit`.',
  "It answers with the count of each value, examples, and a label card (the count of each value, with a link to the label, where the analyst reads its records and can agree or disagree with them) to embed and cite. A card script reads a label's values with tcard's label(name), and its cards then show the label. To run a label of this folder again, such as on every record after a trial or after the analyst corrected records, give only its name (and limit for a trial): records whose value it kept are not read again.",
].join(' ')
export const LABEL_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'the label in a few words the analyst would use, such as "asks for a refund"' },
    paths: { type: 'array', items: { type: 'string' }, description: 'globs of the files whose records it labels, relative to this folder, such as "tickets/*.jsonl"' },
    kind: { type: 'string', enum: ['prompt', 'regex', 'code'] },
    definition: { type: 'string', description: 'prompt: one or two sentences that two careful readers would apply the same way, saying when each value applies; regex: the pattern; code: the Python of label(unit)' },
    values: { type: 'array', items: { type: 'string' }, description: 'two or a few short values, the positive first and the negative last; default ["yes", "no"]' },
    field: { type: 'string', description: 'a field of each JSON record (dotted for a nested one) or a CSV column that holds the text to read; default the whole record' },
    within: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } }, description: 'label only the records another label gave this value (default its first), such as the few a regex kept before a prompt reads them' },
    limit: { type: 'integer', description: 'label only this many records, spread evenly over the files, as a trial' },
  },
  required: ['name'],
}

const BATCH = 10 // records per model call
const MAX_TOKENS = 16000 // a reply's cap, thinking included
const FALLBACK_MODEL = 'claude-opus-4-8' // reads a record the label's model leaves without a value
const BATCH_CHARS = 40000
const CONCURRENCY = 12
const PROMPT_MAX = 3000 // records a prompt label reads in one run without a limit
const UNITS_PAGE = 150 // records labels.py hands over in one output (6,000 characters each at most)
const RETRIES = [1000, 2000, 4000, 8000]
const running = new Map<string, AbortController>()

type LabelSpec = { name: string; kind: 'prompt' | 'regex' | 'code'; definition: string; values: string[]; paths: string[]; field: string; within?: { label: string; value?: string } }
type Unit = { ref: string; text: string; set?: string }
type Row = { value: string; confidence: number; rationale: string }
type Finished = {
  error?: string
  slug: string
  name: string
  kind: string
  values: string[]
  counts: Record<string, number>
  labeled: number
  total: number
  trial: boolean
  examples: ChatLabelExample[]
  errors: string[]
  cards: string[]
  card_output: string
  card_error: string
  script: string
  status?: string
}

/** The tool's input as a label's spec, or why it cannot be one. */
export function specOf(x: Record<string, unknown>): LabelSpec | string {
  const name = typeof x.name === 'string' ? x.name.trim() : ''
  const kind = x.kind
  const definition = typeof x.definition === 'string' ? x.definition : ''
  const paths = Array.isArray(x.paths) ? x.paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '') : typeof x.paths === 'string' ? [x.paths] : []
  const values = Array.isArray(x.values) ? [...new Set(x.values.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map(v => v.trim()))] : []
  if (!name) return 'give the label a name'
  if (kind !== 'prompt' && kind !== 'regex' && kind !== 'code') return 'kind is prompt, regex or code'
  if (!definition.trim()) return 'give the definition: the prompt, the pattern or the code'
  if (!paths.length) return 'give the globs of the files whose records it labels in paths'
  if (values.length === 1) return 'give two or more values, the positive first'
  const w = x.within as { label?: unknown; value?: unknown } | undefined
  return {
    name,
    kind,
    definition,
    values: values.length ? values : ['yes', 'no'],
    paths,
    field: typeof x.field === 'string' ? x.field.trim() : '',
    ...(w && typeof w.label === 'string' && w.label.trim() ? { within: { label: w.label.trim(), ...(typeof w.value === 'string' && w.value ? { value: w.value } : {}) } } : {}),
  }
}

function labelSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'label'
  )
}

const LABEL_SYSTEM =
  'You sort items into the values of a category, so that the analyst can count by it. A count means something only when two careful readers would give the same item the same value. So read each item whole, decide from its own words, and judge every item on its own.'

/** One model call's prompt: thimble's labels prompt, the analyst's examples, then the numbered items. */
export function labelPrompt(spec: LabelSpec, items: Unit[], examples: { ref: string; text: string; value: string }[]): string {
  const unit = `record of ${spec.paths.join(', ')}${spec.field ? ` (its field ${spec.field})` : ''}`
  const parts = [
    `The category is named "${spec.name}". One item is one ${unit}, shown under its number and its ref.`,
    '',
    'The definition follows.',
    '',
    spec.definition.trim(),
    '',
    `The allowed values are ${spec.values.map(v => `"${v}"`).join(', ')}. For every numbered item write one line of JSON and nothing else: {"i": <its number>, "label": <one of the allowed values>, "confidence": <between 0 and 1>, "rationale": "<one sentence naming the words in it that decided the value>"}. Give a high confidence when the item's words settle the value and a low one when you had to guess.`,
  ]
  if (examples.length) {
    parts.push('', 'The analyst has already given these items their values. Read them as the standard for the category and give an item like one of them the same value.', '')
    examples.forEach((x, k) => parts.push(`### example ${k + 1} [${x.ref}]`, x.text, `The analyst gave it the value ${x.value}.`, ''))
  }
  parts.push('')
  items.forEach((it, k) => parts.push(`### item ${k + 1} [${it.ref}]`, it.text, ''))
  return parts.join('\n')
}

/** A model's answer as each item's row, by its number from 1: one JSON object a line (or an array of them), the value
 *  taken as the allowed one it names. */
export function parseLabels(text: string, values: string[], n: number): Map<number, Row> {
  const out = new Map<number, Row>()
  const objs: unknown[] = []
  for (const raw of jsonObjects(text)) {
    try {
      objs.push(JSON.parse(raw))
    } catch {
      // not JSON
    }
  }
  const pick = (raw: unknown): string | undefined => {
    const s = String(raw ?? '').trim().replace(/^["']|["']$/g, '')
    return values.find(v => v === s) ?? values.find(v => v.toLowerCase() === s.toLowerCase()) ?? values.find(v => s.toLowerCase().startsWith(v.toLowerCase()))
  }
  for (const o of objs) {
    if (!o || typeof o !== 'object') continue
    const r = o as { i?: unknown; label?: unknown; value?: unknown; confidence?: unknown; rationale?: unknown }
    const i = Number(r.i)
    const value = pick(r.label ?? r.value)
    if (!Number.isInteger(i) || i < 1 || i > n || out.has(i) || !value) continue
    const c = Number(r.confidence)
    out.set(i, { value, confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.5, rationale: clip(String(r.rationale ?? ''), 400) })
  }
  return out
}

/** Every top-level {...} of a text, its braces balanced outside strings: a reply's objects, one a line or spread over
 *  several, in an array or a code fence. */
export function jsonObjects(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let str = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (str) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') str = false
      continue
    }
    if (c === '"' && depth > 0) str = true
    else if (c === '{') {
      if (depth++ === 0) start = i
    } else if (c === '}' && depth > 0 && --depth === 0) out.push(text.slice(start, i + 1))
  }
  return out
}

function batchesOf(units: Unit[]): Unit[][] {
  const out: Unit[][] = []
  let cur: Unit[] = []
  let chars = 0
  for (const u of units) {
    if (cur.length && (cur.length >= BATCH || chars + u.text.length > BATCH_CHARS)) {
      out.push(cur)
      cur = []
      chars = 0
    }
    cur.push(u)
    chars += u.text.length
  }
  if (cur.length) out.push(cur)
  return out
}

/** What a prompt label's calls went through: recovered (calls retried after an overload or a rate limit, empty replies
 *  split and asked again, records a reply left out asked again, records the fallback model read) and lost (records
 *  left with no value, each reason once, the first such record). */
type Judged = { retried: number; split: number; reasked: number; fellBack: number; lost: number; why: string[]; first: string }

/** The run's one status line, dim in the panel: what the calls went through and recovered from; '' when nothing. */
export function judgedStatus(j: Judged, model: string): string {
  const parts = [
    j.split ? `${num(j.split)} empty ${j.split === 1 ? 'reply' : 'replies'} split and asked again` : '',
    j.retried ? `${num(j.retried)} ${j.retried === 1 ? 'call' : 'calls'} retried after an overload` : '',
    j.reasked ? `${num(j.reasked)} ${j.reasked === 1 ? 'record' : 'records'} a reply left out asked again` : '',
    j.fellBack ? `${num(j.fellBack)} ${j.fellBack === 1 ? 'record' : 'records'} ${model} gave no value read by ${FALLBACK_MODEL}` : '',
  ].filter(Boolean)
  return parts.join(' · ')
}

/** The run's problem, one line: the records left with no value, why, and one of them; '' when none. */
export function judgedProblem(j: Judged): string {
  if (!j.lost) return ''
  return `${num(j.lost)} ${j.lost === 1 ? 'record has' : 'records have'} no value (${j.why.slice(0, 2).join('; ')}${j.why.length > 2 ? `; ${j.why.length - 2} more reasons` : ''}), such as ${j.first}`
}

/** A prompt label's model calls: BATCH records a call, CONCURRENCY calls at once (fewer after a rate limit), each
 *  call retried on an overload, the items a reply left out asked again once. */
async function judge(ctx: HarnessCtx, l: ChatLabel, spec: LabelSpec, units: Unit[], examples: { ref: string; text: string; value: string }[], stop: AbortSignal, onRows: (n: number) => Promise<void>): Promise<{ rows: Record<string, Row>; errors: string[]; status: string }> {
  const rows: Record<string, Row> = {}
  const j: Judged = { retried: 0, split: 0, reasked: 0, fellBack: 0, lost: 0, why: [], first: '' }
  const lose = (batch: Unit[], why: string) => {
    j.lost += batch.length
    if (!j.why.includes(why)) j.why.push(why)
    j.first ||= batch[0]!.ref
  }
  const model = await ctx.labelModel()
  const queue = batchesOf(units)
  let width = CONCURRENCY
  let active = 0
  const one = async (batch: Unit[], again: boolean): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      if (stop.aborted) return
      const r = await ctx.complete({ model, system: LABEL_SYSTEM, prompt: labelPrompt(spec, batch, examples), effort: 'low', maxTokens: MAX_TOKENS, timeoutMs: 300000 })
      // An empty reply came back on the same hard batches every time (live, 13 of 233 calls): the model spent the cap
      // thinking. Each half is asked on its own, down to one record.
      if (!r.isAnswered && r.reason === 'empty-reply' && batch.length > 1) {
        j.split++
        const half = Math.ceil(batch.length / 2)
        await one(batch.slice(0, half), again)
        await one(batch.slice(half), again)
        return
      }
      // one record still answered empty, or with no allowed value: read once by FALLBACK_MODEL, and its row says so
      if (batch.length === 1 && model !== FALLBACK_MODEL && ((!r.isAnswered && r.reason === 'empty-reply') || (r.isAnswered && !parseLabels(r.text, spec.values, 1).size))) {
        const f = await ctx.complete({ model: FALLBACK_MODEL, system: LABEL_SYSTEM, prompt: labelPrompt(spec, batch, examples), effort: 'low', maxTokens: MAX_TOKENS, timeoutMs: 300000 })
        const row = f.isAnswered ? parseLabels(f.text, spec.values, 1).get(1) : undefined
        if (row) {
          rows[batch[0]!.ref] = { ...row, rationale: `${row.rationale} (read by ${FALLBACK_MODEL}: ${model} gave no value)`.trim() }
          j.fellBack++
        } else lose(batch, `neither ${model} nor ${FALLBACK_MODEL} gave an allowed value`)
        return
      }
      if (r.isAnswered) {
        const got = parseLabels(r.text, spec.values, batch.length)
        const missed: Unit[] = []
        batch.forEach((u, k) => {
          const row = got.get(k + 1)
          if (row) rows[u.ref] = row
          else missed.push(u)
        })
        if (missed.length && !again) {
          j.reasked += missed.length
          await one(missed, true)
        } else if (missed.length) lose(missed, 'the model gave no allowed value')
        return
      }
      const retryable = r.reason === 'api-error' && ['rate_limit', 'overloaded', 'server_error', 'unknown'].includes(String(r.error))
      if (!retryable || attempt >= RETRIES.length) {
        lose(batch, `a model call failed: ${r.reason}${r.reason === 'api-error' ? ` ${String(r.error)}` : ''}`)
        return
      }
      j.retried++
      if (r.reason === 'api-error' && r.error === 'rate_limit') width = Math.max(2, Math.floor(width / 2))
      await ctx.sleep(RETRIES[attempt]!)
    }
  }
  await new Promise<void>(resolve => {
    const pump = (): void => {
      if (stop.aborted && active === 0) return resolve()
      while (!stop.aborted && active < width && queue.length) {
        const batch = queue.shift()!
        active++
        void one(batch, false)
          .catch((err: unknown) => {
            lose(batch.filter(u => !rows[u.ref]), clip(String(err), 160))
          })
          .finally(() => {
            active--
            void onRows(Object.keys(rows).length).finally(pump)
          })
      }
      if (active === 0 && (!queue.length || stop.aborted)) resolve()
    }
    pump()
  })
  void l
  const problem = judgedProblem(j)
  return { rows, errors: problem ? [problem] : [], status: judgedStatus(j, model) }
}

/** labels.py's steps that run code: a code label's function, and the label card's script that run, finish and verdict
 *  write and run. They run in the sandbox; listing, showing and paging records do not. */
const RUNS_CODE = new Set(['run', 'finish', 'verdict'])

async function helper(ctx: HarnessCtx, args: string[], timeoutMs = 600000): Promise<Record<string, unknown>> {
  const { cwd, root } = await ctx.where()
  const run = RUNS_CODE.has(args[0] ?? '') ? ctx.boxed : ctx.run
  const r = await run(['python3', `${root}/helper/labels.py`, ...args, '--cwd', cwd], { cwd, timeoutMs })
  if (r.exitCode !== 0) return { error: clip(r.stderr.trim().split('\n').slice(-3).join(' ') || `labels.py exited ${r.exitCode}`, 400) }
  try {
    return JSON.parse(r.stdout) as Record<string, unknown>
  } catch {
    return { error: `labels.py printed no JSON: ${clip(r.stdout, 200)}` }
  }
}

function sameSpec(a: Partial<LabelSpec> | undefined, b: LabelSpec): boolean {
  return Boolean(a) && a!.definition === b.definition && a!.kind === b.kind && JSON.stringify(a!.values) === JSON.stringify(b.values) && (a!.field ?? '') === b.field && JSON.stringify(a!.paths) === JSON.stringify(b.paths) && JSON.stringify(a!.within ?? null) === JSON.stringify(b.within ?? null)
}

/** Define (or redefine) a label and run it: on `limit` records spread over its files, else on all. Its state shows in
 *  the panel and the tool's row while it runs. Returns what labels.py finished with, or why it could not. */
export async function runLabel(ctx: HarnessCtx, spec: LabelSpec, limit: number): Promise<Finished | { error: string }> {
  const { cwd } = await ctx.where()
  const slug = labelSlug(spec.name)
  const dir = `${cwd}/${ctx.home}/labels/${slug}`
  running.get(slug)?.abort()
  const stop = new AbortController()
  running.set(slug, stop)
  let prev: Partial<LabelSpec> | undefined
  try {
    prev = JSON.parse(await ctx.read(`${dir}/spec.json`)) as Partial<LabelSpec>
  } catch {
    prev = undefined
  }
  await ctx.write(`${dir}/spec.json`, JSON.stringify(spec, null, 1))
  const base: ChatLabel = { slug, name: spec.name, kind: spec.kind, definition: spec.definition, values: spec.values, paths: spec.paths, field: spec.field, ...(spec.within ? { within: spec.within } : {}), state: 'running', trial: limit > 0, limit, total: 0, labeled: 0, counts: {}, examples: [], cards: [], errors: [], created: await ctx.now() }
  const old = await ctx.label(slug)
  await ctx.setLabel({ ...base, ...(old && old.state !== 'running' ? { counts: old.counts, examples: old.examples, cards: old.cards } : {}) })
  try {
    let done: Record<string, unknown>
    if (spec.kind !== 'prompt') {
      done = await helper(ctx, ['run', slug, ...(limit > 0 ? ['--limit', String(limit)] : [])])
    } else {
      // the records come a page at a time: the output of a process the mod reads is capped
      const lim = limit > 0 ? ['--limit', String(limit)] : []
      const u = await helper(ctx, ['units', slug, ...lim, '--page', '0', '--per', String(UNITS_PAGE)])
      if (u.error) return fail(ctx, base, String(u.error))
      const picked = Number(u.picked ?? (u.units as Unit[] | undefined)?.length ?? 0)
      const total = Number(u.total ?? 0)
      if (!picked) return fail(ctx, base, `no records in ${spec.paths.join(', ')}${spec.within ? ` that the label "${spec.within.label}" gave its value` : ''}`)
      if (limit <= 0 && picked > PROMPT_MAX) return fail(ctx, base, `${num(picked)} records is more than a prompt label reads in one run (${num(PROMPT_MAX)}). Run it on a sample with limit (its counts estimate the shares), or narrow it: other paths, or within a regex or code label that keeps the records worth reading.`)
      const units = [...((u.units as Unit[]) ?? [])]
      for (let page = 1; page < Number(u.pages ?? 1); page++) {
        const more = await helper(ctx, ['units', slug, ...lim, '--page', String(page), '--per', String(UNITS_PAGE)])
        if (more.error) return fail(ctx, base, String(more.error))
        units.push(...((more.units as Unit[]) ?? []))
      }
      // the rows of the run before, when the label is the same, so "apply to all" after a trial reads only the rest
      let kept: Record<string, Row & { analyst?: boolean }> = {}
      if (sameSpec(prev, spec)) {
        try {
          kept = (JSON.parse(await ctx.read(`${dir}/rows.json`)) as { rows?: Record<string, Row> }).rows ?? {}
        } catch {
          kept = {}
        }
      }
      const rows: Record<string, Row> = {}
      const todo: Unit[] = []
      for (const x of units) {
        if (x.set) rows[x.ref] = { value: x.set, confidence: 1, rationale: kept[x.ref]?.rationale ?? '' }
        else if (kept[x.ref] && !kept[x.ref]!.analyst) rows[x.ref] = kept[x.ref]!
        else todo.push(x)
      }
      await ctx.setLabel({ ...base, total, labeled: Object.keys(rows).length, ...(old ? { counts: old.counts, examples: old.examples, cards: old.cards } : {}) })
      const examples = ((u.examples as { ref: string; text: string; value: string }[]) ?? []).slice(0, 8)
      const already = Object.keys(rows).length
      const got = await judge(ctx, base, spec, todo, examples, stop.signal, async n => {
        const cur = await ctx.label(slug)
        if (cur?.state === 'running') await ctx.setLabel({ ...cur, total, labeled: already + n })
      })
      if (stop.signal.aborted) return fail(ctx, base, 'stopped')
      Object.assign(rows, got.rows)
      await ctx.write(`${dir}/rows.prompt.json`, JSON.stringify({ rows, total, trial: limit > 0 && limit < total, errors: got.errors, status: got.status }))
      done = await helper(ctx, ['finish', slug])
    }
    if (done.error) return fail(ctx, base, String(done.error))
    const f = done as unknown as Finished
    // what the label read goes to the coverage count: a prompt label's model judged each record, a rule went over
    // the files, and the examples its answer shows are records the agent read
    let judged: string[] = []
    if (spec.kind === 'prompt') {
      try {
        judged = Object.keys((JSON.parse(await ctx.read(`${dir}/rows.json`)) as { rows?: Record<string, unknown> }).rows ?? {})
      } catch {
        judged = []
      }
    }
    covQueue.push({ agent: 'label', tool: 'Label', input: { refs: judged, files: spec.paths, seen: f.examples.map(x => x.ref) }, output: '', t: 0, session: '' })
    if (!covRunning) covIdle = flushCoverage(ctx)
    await ctx.setLabel({ ...base, state: 'ready', trial: f.trial, total: f.total, labeled: f.labeled, counts: f.counts, examples: f.examples, cards: f.cards, errors: [...f.errors, ...(f.card_error ? [`the card script failed: ${clip(f.card_error, 200)}`] : [])], ...(f.status ? { status: f.status } : {}) })
    await ctx.cardsChanged(f.cards)
    return f
  } finally {
    if (running.get(slug) === stop) running.delete(slug)
  }
}

async function fail(ctx: HarnessCtx, base: ChatLabel, why: string): Promise<{ error: string }> {
  await ctx.setLabel({ ...base, state: 'error', why })
  return { error: why }
}

/** What the tool answers the model: counts, examples of each value, the cards and what to do next. */
export function labelAnswer(spec: LabelSpec, f: Finished): string {
  const counts = spec.values.map(v => `${v} ${num(f.counts[v] ?? 0)}`).join(', ')
  const how = spec.kind === 'prompt' ? 'a model read each record' : spec.kind === 'regex' ? 'the regex matched each record' : 'the code decided each record'
  const lines = [
    `Label "${f.name}" (${spec.kind}): ${f.trial ? `a trial on ${num(f.labeled)} of ${num(f.total)} records, spread over the files` : `all ${num(f.labeled)} records`}; ${how}. Counts: ${counts}.`,
  ]
  if (f.errors.length) lines.push(`Problems: ${f.errors.join('; ')}`)
  if (f.status) lines.push(`The model calls: ${f.status}.`)
  lines.push('', 'Examples of each value:')
  for (const x of f.examples) lines.push(`- ${x.value}  ${x.ref}: ${clip(x.text, 160)}${x.rationale ? `  (why: ${clip(x.rationale, 140)})` : ''}`)
  if (f.card_output) lines.push('', `The label's card, made by ${f.script}, shows the counts and links to the label, where the analyst reads its records and can agree or disagree with them:`, f.card_output.trim())
  lines.push(
    '',
    f.trial
      ? 'Read the examples: where a value is wrong, or the definition misses another way of saying the same thing, rewrite the definition and try it again; then run it without limit before you count by it.'
      : 'The analyst sees the label in the panel. A takeaway that counts by it names the label and says whether a rule or a model made it.',
  )
  return lines.join('\n')
}

/** Main's (or a subagent's) call of the `label` tool. */
export async function labelTool(ctx: HarnessCtx, raw: { agentId?: string } & Record<string, unknown>): Promise<{ result: string } | { deny: string }> {
  // the command's spellings (files, trial, a within written as "label=value") read as the tool's names
  const e = { ...labelInputOf(raw), agentId: raw.agentId } as { agentId?: string } & Record<string, unknown>
  let spec = specOf(e)
  // a name alone (and a limit) runs a label of this folder again, as it was defined
  if (typeof spec === 'string' && typeof e.name === 'string' && e.name.trim() && e.definition === undefined && e.kind === undefined) {
    const { cwd } = await ctx.where()
    try {
      spec = specOf(JSON.parse(await ctx.read(`${cwd}/${ctx.home}/labels/${labelSlug(e.name.trim())}/spec.json`)) as Record<string, unknown>)
    } catch {
      spec = `no label "${e.name.trim()}" in this folder: give its kind, definition and paths`
    }
  }
  if (typeof spec === 'string') return { deny: `thimble-cc-mod label: ${spec}` }
  const limit = Number.isInteger(e.limit) && Number(e.limit) > 0 ? Number(e.limit) : 0
  const slug = labelSlug(spec.name)
  if (e.agentId === undefined) {
    await ctx.setLabelOpen(slug)
    await ctx.openHarness('label', `Label: ${clip(spec.name, 40)}`)
  }
  const f = await runLabel(ctx, spec, limit)
  if ('error' in f && f.error) return { deny: `thimble-cc-mod label "${spec.name}": ${f.error}` }
  return { result: labelAnswer(spec, f as Finished) }
}

/** The one dim line the tool's call shows as, with the run's progress. */
export function labelToolLine(input: unknown, l: ChatLabel | undefined): string {
  const x = (input ?? {}) as { name?: unknown; kind?: unknown; limit?: unknown }
  const name = typeof x.name === 'string' ? x.name : ''
  const kind = typeof x.kind === 'string' ? x.kind : (l?.kind ?? '')
  const what = `  label · "${clip(name, 50)}" · ${kind}${Number(x.limit) > 0 ? ` · trial of ${Number(x.limit)}` : ''}`
  if (!l) return what
  if (l.state === 'running') return `${what} · ${l.total ? `◌ ${num(l.labeled)} of ${num(l.limit > 0 ? Math.min(l.limit, l.total) : l.total)} labeled` : '◌ labeling'}`
  if (l.state === 'error') return `${what} · ${clip(l.why ?? 'failed', 80)}`
  return `${what} · ${l.values.map(v => `${v} ${num(l.counts[v] ?? 0)}`).join(' · ')}`
}

// the kind the analyst picked in a label's `type` field before saving it, by the label's slug
const kindDraft = new Map<string, string>()

/** The file a label's records come from, by its stem ("revisions"), else "records". */
function unitOf(l: ChatLabel): string {
  const stems = [...new Set(l.paths.map(p => (p.split('/').at(-1) ?? p).replace(/\.[A-Za-z0-9]+$/, '').replace(/\*/g, '')))].filter(Boolean)
  return stems.length === 1 ? stems[0]! : 'records'
}

/** How long ago, in plain words ("2 min ago"), or '' for an unknown time. */
function ago(now: number, then: number): string {
  if (!then) return ''
  const m = Math.max(0, Math.round((now - then) / 60000))
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}

/** What a label's last run was, in words: `a sample of 30 of 14,591 revisions`, `all 14,591 revisions`, or
 *  `◌ labeling 12 of 30` while it runs. */
function lastRun(l: ChatLabel): string {
  const unit = unitOf(l)
  if (l.state === 'running') return `◌ labeling ${num(l.labeled)} of ${num(l.limit > 0 && l.total ? Math.min(l.limit, l.total) : l.total)}`
  return l.trial ? `a sample of ${num(l.labeled)} of ${num(l.total)} ${unit}` : `all ${num(l.labeled)} ${unit}`
}

/** The label panel (views/SPEC.md, section 7, "The label panel"), after the browser's label editor: the label's name
 *  and its last run dim under it; under the rule, its fields, each editable (`type`, `scope`, the definition under its
 *  kind's name, `values`, `sample`), Enter in one saving the label and running it on the sample; the counts, each
 *  value's bar on a track to the whole with its count and share; `▸ examples` and `▸ cards`, folded, the examples
 *  grouped by value with their places, words, why, and `agree  it is …`; at the bottom, `run on the sample` and
 *  `run on all N` (`stop` while it runs), its errors under them. */
export async function drawLabel(e: PaneEvent, ctx: HarnessCtx): Promise<RenderElement> {
  const { Box, Text, Button, Input } = ctx.els(e as unknown as ResolveInput)
  const els = { Box, Text, Button }
  const slug = await ctx.labelOpen()
  const l = slug ? await ctx.label(slug) : undefined
  const cols = Math.max(30, e.props.bodyColumns)
  if (!l) return <Box flexDirection="column"><Text dimColor>none</Text></Box>
  const now = await ctx.now()
  const opened = await ctx.labelOpened()
  const rows: RenderElement[] = [...headerEls(els, { title: l.name, cols, sub: subLine([lastRun(l), ago(now, l.created)]) })]
  const keys: { key: string; hotkey: string; onPress: () => void }[] = []
  const running = l.state === 'running'
  const sample = l.trial && l.limit > 0 ? l.limit : 30
  // the fields, each editable: Enter saves the label with it and runs it on the sample
  const kind = kindDraft.get(l.slug) ?? l.kind
  const defName = kind === 'prompt' ? 'prompt' : kind === 'regex' ? 'pattern' : 'code'
  const save = (patch: Partial<LabelSpec>, limit = sample) => {
    const k = kindDraft.get(l.slug)
    kindDraft.delete(l.slug)
    void rerun(ctx, l, { ...(k && k !== l.kind ? { kind: k as LabelSpec['kind'] } : {}), ...patch }, limit)
  }
  const L = Math.max(...['type', 'scope', defName, 'values', 'sample'].map(w => w.length)) + 2
  const field = (label: string, el: RenderElement) => (
    <Box key={`lf:${label}`} flexDirection="row">
      <Box width={L} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="column">
        {el}
      </Box>
    </Box>
  )
  // `type`: the kind in use on the selection background, the others a click away
  rows.push(
    field(
      'type',
      <Box flexDirection="row" columnGap={2}>
        {(['prompt', 'regex', 'code'] as const).map(k =>
          k === kind ? (
            <Text key={`lk:${k}`} backgroundColor={COLORS.selected}>{k}</Text>
          ) : (
            <Button key={`lk:${k}`} label={k} plain onPress={() => void (kindDraft.set(l.slug, k), ctx.setLabelOpened([...opened]))} />
          ),
        )}
      </Box>,
    ),
  )
  const scopeText = `${l.paths.join(', ')}${l.field ? ` · field ${l.field}` : ''}`
  const field2 = (label: string, value: string, onSave: (v: string) => void) =>
    field(label, running ? <Text wrap="wrap">{value}</Text> : <Input key={`lb-${label}:${l.slug}`} value={value} submitLabel="save and run" onSubmit={v => onSave(v)} />)
  rows.push(
    field2('scope', scopeText, v => {
      const m = /^(.*?)(?:\s*·\s*field\s+(\S+))?\s*$/.exec(v.trim())
      const paths = (m?.[1] ?? '').split(',').map(x => x.trim()).filter(Boolean)
      if (paths.length) save({ paths, field: m?.[2] ?? '' })
    }),
  )
  // the definition: the whole prompt wrapped (code coloured as Claude Code colours it); `edit` turns it into the field
  // that holds it, whose Enter saves it and runs the label on the sample
  const editKey = `${l.slug}:edit`
  const editing = !running && (opened.includes(editKey) || kind !== l.kind)
  const shownDef = kind === l.kind ? l.definition : ''
  const editDone = (v: string) => {
    void ctx.setLabelOpened(opened.filter(x => x !== editKey))
    if (v.trim()) save({ definition: v.trim() })
  }
  if (editing) rows.push(field(defName, <Input key={`lb-def:${l.slug}:${kind}`} value={shownDef} autoFocus submitLabel="save and run" onSubmit={editDone} />))
  else
    rows.push(
      field(
        defName,
        <Box flexDirection="column">
          {kind === 'code' ? ctx.code(e as unknown as ResolveInput, l.definition, 14, 'python', 1) : <Text wrap="wrap">{l.definition}</Text>}
          {running ? null : <Box flexDirection="row"><Button key={`lb-edit:${l.slug}`} label="edit" plain onPress={() => void ctx.setLabelOpened([...opened.filter(x => x !== editKey), editKey])} /></Box>}
        </Box>,
      ),
    )
  rows.push(field2('values', l.values.join(' · '), v => {
    const vs = [...new Set(v.split(/\s*[·,]\s*/).map(x => x.trim()).filter(Boolean))]
    if (vs.length >= 2) save({ values: vs })
  }))
  rows.push(field2('sample', String(sample), v => {
    const n = Number.parseInt(v.trim(), 10)
    if (Number.isFinite(n) && n > 0) save({}, n)
  }))
  rows.push(<Text key="lb-gap"> </Text>)
  // the counts: each value's ● in its hue, its name, a bar on a track to the whole, its count and its share dim
  const total = l.values.reduce((a, v) => a + (l.counts[v] ?? 0), 0)
  const vw = Math.min(Math.max(12, Math.floor(cols / 3)), Math.max(...l.values.map(v => width(v))))
  const counts = l.values.map(v => num(l.counts[v] ?? 0))
  const cw = Math.max(...counts.map(c => c.length))
  // the track takes what the names and the numbers leave, so the shares end on R (rule 4)
  const barW = Math.max(8, cols - 2 - vw - 2 - 2 - cw - 7)
  l.values.forEach((v, i) => {
    const n = l.counts[v] ?? 0
    const w = total ? Math.round((barW * n) / total) : 0
    const colour = valueColour(l.values, v)
    const hue = colour && colour !== COLORS.dim ? { color: colour } : { dimColor: true }
    rows.push(
      <Text key={`lb-c:${v}`} wrap="truncate-end">
        <Text {...hue}>{'● '}</Text>
        <Text>{`${clip(v, vw).padEnd(vw)}  `}</Text>
        <Text {...hue}>{'█'.repeat(w)}</Text>
        <Text color={COLORS.rule}>{'─'.repeat(barW - w)}</Text>
        <Text>{`  ${counts[i]!.padStart(cw)}`}</Text>
        <Text dimColor>{total ? `  ${pct(n, total).padStart(5)}` : ''}</Text>
      </Text>,
    )
  })
  if (l.status) rows.push(<Text key="lb-status" dimColor wrap="wrap">{l.status}</Text>)
  rows.push(<Text key="lb-gap2"> </Text>)
  // the examples and the cards, folded: a click (or e, c) opens them
  const exKey = `${l.slug}:examples`
  const cardKey = `${l.slug}:cards`
  const flip = (k: string) => () => ctx.setLabelOpened(opened.includes(k) ? opened.filter(x => x !== k) : [...opened, k])
  const toggleRow = (k: string, name: string, n: number) => ctx.link(e as unknown as ResolveInput, `lt:${k}`, [[{ s: opened.includes(k) ? '▾ ' : '▸ ' }, { s: name }, { s: `  ${num(n)}`, fg: COLORS.dim }]], [{ y: 0, x0: 0, x1: 2 + width(name) + 2 + num(n).length, row: false, run: flip(k) }], cols)
  rows.push(toggleRow(exKey, 'examples', l.examples.length))
  keys.push({ key: 'examples', hotkey: 'e', onPress: () => void flip(exKey)() })
  if (opened.includes(exKey)) {
    for (const v of l.values) {
      const xs = l.examples.filter(x => x.value === v)
      if (!xs.length) continue
      rows.push(<Text key={`lb-h:${v}`} wrap="truncate-end"><Text>{'  '}</Text><Text color={valueColour(l.values, v)}>{'● '}</Text><Text>{v}</Text><Text dimColor>{`  ${num(xs.length)}`}</Text></Text>)
      for (const x of xs) {
        const others = l.values.filter(o => o !== v)
        const place = placeWords(x.ref)
        rows.push(
          <Box key={`lb-x:${x.ref}`} flexDirection="column" marginLeft={4}>
            <Box flexDirection="row" columnGap={2}>
              <Box flexShrink={1}>{ctx.link(e as unknown as ResolveInput, `lx:${x.ref}`, [[{ s: '↗ ', fg: LINK }, { s: place, fg: LINK, u: true }]], [{ y: 0, x0: 0, x1: 2 + width(place), row: false, run: () => ctx.openRef(x.ref) }], Math.min(cols - 4, 2 + width(place)))}</Box>
              <Box flexGrow={1} />
              {/* the controls, or what the analyst did, one block against R (rule 25) */}
              {x.analyst ? <Text dimColor>{x.was && x.was !== v ? '✓ set by you' : '✓ agreed'}</Text> : null}
              {x.analyst ? null : <Button key={`lb-agree:${x.ref}`} label="agree" plain onPress={() => void labelVerdict(ctx, l.slug, x.ref, v)} />}
              {x.analyst ? null : (
                <Box key={`lb-dis:${x.ref}`} flexDirection="row" columnGap={2} flexWrap="wrap">
                  <Text dimColor>it is</Text>
                  {others.map(o => (
                    <Button key={`lb-set:${x.ref}:${o}`} label={clip(o, 24)} plain onPress={() => void labelVerdict(ctx, l.slug, x.ref, o)} />
                  ))}
                </Box>
              )}
            </Box>
            <Text italic wrap="wrap">{`"${clip(demojibake(x.text).replace(/\s+/g, ' ').trim(), Math.max(120, (cols - 4) * 3 - 2))}"`}</Text>
            {x.rationale && !(x.analyst && x.was && x.was !== v) ? <Text dimColor wrap="wrap">{`why  ${clip(x.rationale, cols * 2)}`}</Text> : null}
          </Box>,
        )
      }
    }
  }
  // the cards that read the label: its own label card, and every card whose script read it
  const cards = [...new Set([...l.cards, ...(await cardsReading(ctx, l.slug))])].slice(0, 8)
  rows.push(toggleRow(cardKey, 'cards', cards.length))
  keys.push({ key: 'cards', hotkey: 'c', onPress: () => void flip(cardKey)() })
  if (opened.includes(cardKey)) {
    for (const id of cards) {
      const card = await ctx.loadCard(id)
      if (card) rows.push(<Box key={`lb-card:${id}`} flexDirection="row" marginLeft={2}><Button key={`lb-card-open:${id}`} label={`${clip(card.question, Math.max(20, cols - 6))} ›`} plain onPress={() => void ctx.openCard(id)} /></Box>)
    }
    if (!cards.length) rows.push(<Text key="lb-cards-none" dimColor>{'  none'}</Text>)
  }
  // the bottom: run it on the sample or on every record (stop while it runs), its problems in red under them
  const runSample = () => save({}, sample)
  const runAll = () => save({}, 0)
  const stop = () => running && running_(l.slug)?.abort()
  rows.push(ruleEl(els, cols, 'lb-rule2'))
  rows.push(
    controlsEl(els, running ? [<Button key="lb-stop" label="stop" plain onPress={stop} />] : [<Button key="lb-sample" label="run on the sample" plain onPress={runSample} />, <Button key="lb-all" label={`run on all ${num(l.total || 0)}`} plain onPress={runAll} />], 'lb-controls')!,
  )
  if (l.state === 'error') rows.push(<Text key="lb-err" color={COLORS.problem} wrap="wrap">{`× ${l.why ?? 'failed'}`}</Text>)
  for (const err of l.errors) rows.push(<Text key={`lb-e:${err}`} color={COLORS.problem} wrap="wrap">{`! ${err}`}</Text>)
  if (running) keys.push({ key: 'stop', hotkey: 's', onPress: stop })
  else keys.push({ key: 'sample', hotkey: 'r', onPress: runSample })
  keys.push({ key: 'list', hotkey: 'l', onPress: () => void ctx.openHarness('labels', 'Labels') }, { key: 'close', hotkey: 'x', onPress: () => void ctx.closePanel() })
  rows.push(hintsEl(els, [running ? 's to stop' : 'Enter to save and run', 'e for examples', 'c for cards', 'b to go back', 'x to close'], cols))
  const hk = hiddenKeys(ctx, e, keys)
  if (hk) rows.unshift(hk)
  return <Box flexDirection="column">{rows}</Box>
}

/** The cards of this folder whose script read the label (tcard's label(name)), newest last. */
async function cardsReading(ctx: HarnessCtx, slug: string): Promise<string[]> {
  const { cwd } = await ctx.where()
  const out: string[] = []
  for (const name of (await ctx.list(`${cwd}/${ctx.home}/cards`).catch(() => [] as string[])).sort()) {
    if (!name.endsWith('.json')) continue
    const id = name.replace(/\.json$/, '')
    const card = await ctx.loadCard(id)
    if (card?.labels?.some(x => x.slug === slug) || (card?.kind === 'label' && card.label?.slug === slug)) out.push(id)
  }
  return out
}

/** A label's run that is going on, which its `stop` aborts. */
function running_(slug: string): AbortController | undefined {
  return running.get(slug)
}

function specFromLabel(l: ChatLabel): LabelSpec {
  return { name: l.name, kind: l.kind as LabelSpec['kind'], definition: l.definition, values: l.values, paths: l.paths, field: l.field, ...(l.within ? { within: l.within } : {}) }
}

/** A run the analyst started from the panel (apply to all, an edited definition): main is told what it found. */
async function rerun(ctx: HarnessCtx, l: ChatLabel, patch: Partial<LabelSpec>, limit = l.trial ? l.limit : 0): Promise<void> {
  const { cwd } = await ctx.where()
  let spec = { ...specFromLabel(l), ...patch }
  try {
    const saved = JSON.parse(await ctx.read(`${cwd}/${ctx.home}/labels/${l.slug}/spec.json`)) as LabelSpec
    spec = { ...saved, ...patch }
  } catch {
    // the state's copy
  }
  const f = await runLabel(ctx, spec, limit)
  if ('error' in f && f.error) {
    ctx.toast(`label "${l.name}": ${clip(f.error, 100)}`)
    return
  }
  const done = f as Finished
  await ctx.noteMain(`thimble-cc-mod: the analyst ${patch.definition && patch.definition !== l.definition ? `changed the definition of the label "${l.name}" to "${clip(patch.definition, 300)}" and ran it` : `applied the label "${l.name}"`} on ${done.trial ? `a sample of ${num(done.labeled)}` : `all ${num(done.labeled)}`} records: ${spec.values.map(v => `${v} ${num(done.counts[v] ?? 0)}`).join(', ')}. Its cards: ${done.cards.map(c => `[[card:${c}]]`).join(' ')}.`)
}

/** The analyst judged one record, in the panel or on the label card: agreed with its value (`value` its own) or set
 *  another. Kept as the label's verdict (labels.py), the counts and the label card made again with the same examples,
 *  main told. */
export async function labelVerdict(ctx: HarnessCtx, slug: string, ref: string, value: string): Promise<void> {
  const l = await ensureLabel(ctx, slug)
  if (!l) {
    ctx.toast(`no label ${slug} in this folder`)
    return
  }
  const before = l.examples.find(x => x.ref === ref)?.value
  const got = await helper(ctx, ['verdict', l.slug, ref, value])
  if (got.error) {
    ctx.toast(`could not set it: ${clip(String(got.error), 100)}`)
    return
  }
  const f = got as unknown as Finished
  await ctx.setLabel({ ...l, counts: f.counts, examples: f.examples, labeled: f.labeled, cards: f.cards })
  await ctx.cardsChanged(f.cards)
  const counts = l.values.map(v => `${v} ${num(f.counts[v] ?? 0)}`).join(', ')
  await ctx.noteMain(
    before === value
      ? `thimble-cc-mod: the analyst agreed that ${ref} is "${value}" in the label "${l.name}".`
      : `thimble-cc-mod: the analyst set ${ref} to "${value}" in the label "${l.name}"${before ? ` (it was "${before}")` : ''}; its counts are now ${counts}.`,
  )
}

/** A label in the state, one an earlier session made read back from its files first. */
async function ensureLabel(ctx: HarnessCtx, slug: string): Promise<ChatLabel | undefined> {
  const have = await ctx.label(slug)
  if (have) return have
  const got = await helper(ctx, ['show', slug])
  if (got.error) return undefined
  const f = got as unknown as Finished & { spec: LabelSpec }
  const sp = f.spec
  const l: ChatLabel = { slug, name: sp.name, kind: sp.kind, definition: sp.definition, values: sp.values, paths: sp.paths, field: sp.field ?? '', ...(sp.within ? { within: sp.within } : {}), state: 'ready', trial: f.trial, limit: f.trial ? f.labeled : 0, total: f.total, labeled: f.labeled, counts: f.counts, examples: f.examples, cards: await labelCards(ctx, slug), errors: f.errors ?? [], ...(f.status ? { status: f.status } : {}), created: 0 }
  await ctx.setLabel(l)
  return l
}

/** The label card of a label made in an earlier session: the card its script writes (label-<slug>.py). */
async function labelCards(ctx: HarnessCtx, slug: string): Promise<string[]> {
  const { cwd } = await ctx.where()
  const out: string[] = []
  for (const name of await ctx.list(`${cwd}/${ctx.home}/cards`).catch(() => [] as string[])) {
    const id = name.replace(/\.json$/, '')
    if (!name.endsWith('.json') || out.length >= 2) continue
    const card = await ctx.loadCard(id)
    if (card?.kind === 'label' && card.label?.slug === slug) out.push(id)
  }
  return out
}

// the labels list's row the keys chose
let labelPick = ''

/** The labels of this folder (views/SPEC.md, "The label panel", the labels list): its title and count; under the
 *  rule, one row per label (its glyph, its name, its kind and last run dim at R), `❯` and the accent on the row the
 *  keys chose; under the second rule the field `describe a new label`, whose words go to main, which makes the label
 *  with a trial. */
export async function drawLabels(e: PaneEvent, ctx: HarnessCtx): Promise<RenderElement> {
  const { Box, Text, Button, Input } = ctx.els(e as unknown as ResolveInput)
  const els = { Box, Text, Button }
  const list = await allLabels(ctx)
  const cols = Math.max(30, e.props.bodyColumns)
  const rows: RenderElement[] = [...headerEls(els, { title: 'Labels', cols, sub: subLine([`${list.length} label${list.length === 1 ? '' : 's'}`]) })]
  const lines: Line[] = []
  const hits: { y: number; x0: number; x1: number; row: boolean; run: () => Promise<void> | void }[] = []
  const pick = list.find(x => x.slug === labelPick)?.slug ?? list[0]?.slug ?? ''
  for (const x of list) {
    const n = Object.values(x.counts).reduce((a, b) => a + b, 0)
    const run = x.scope === 'trial' ? `a sample of ${num(n)}` : `all ${num(n)}`
    hits.push({ y: lines.length, x0: MARGIN_W, x1: cols + MARGIN_W, row: true, run: () => void openLabel(ctx, x.slug) })
    lines.push(pointed(spread([{ s: '●' }, { s: ' ' }, { s: x.name }], [{ s: `${x.kind} · ${run}`, fg: COLORS.dim }], cols), x.slug === pick))
  }
  if (!list.length) lines.push(pointed([{ s: '  ' }, { s: 'none', fg: COLORS.dim }], false))
  const step = (d: number) => {
    const at = list.findIndex(x => x.slug === pick)
    labelPick = list[Math.max(0, Math.min(list.length - 1, at + d))]?.slug ?? ''
    return ctx.openHarness('labels', 'Labels')
  }
  rows.push(ctx.link(e as unknown as ResolveInput, marginKey('labels-list'), lines, hits, cols + MARGIN_W, k => (k === 'up' || k === 'k' ? step(-1) : k === 'down' || k === 'j' ? step(1) : (k === 'return' || k === 'enter') && pick ? void openLabel(ctx, pick) : undefined)))
  // each label a press away by its key too, for a surface that draws no Client: no row of its own
  rows.unshift(
    <Box key="label-presses" width={0} height={0} flexShrink={0} overflow="hidden" flexDirection="row">
      {list.map(x => <Button key={`lbs-open:${x.slug}`} label={x.name} plain onPress={() => void openLabel(ctx, x.slug)} />)}
    </Box>,
  )
  // a new label in the analyst's words: main makes it with the label tool and tries it on a sample
  rows.push(ruleEl(els, cols, 'lbs-rule2'))
  rows.push(
    <Box key="lbs-new" flexDirection="row">
      <Text dimColor>{'describe a new label  '}</Text>
      <Box flexGrow={1} flexShrink={1}>
        <Input key="lbs-describe" submitLabel="make it" onSubmit={v => void (v.trim() ? ctx.submit(`Make a label with the label tool and try it on a sample of 30: ${v.trim()}`) : undefined)} />
      </Box>
    </Box>,
  )
  rows.push(hintsEl(els, ['↑↓ to choose', 'Enter to open', 'x to close'], cols))
  const hk = hiddenKeys(ctx, e, [...list.slice(0, 9).map((x, i) => ({ key: `l${i}`, hotkey: String(i + 1), onPress: () => void openLabel(ctx, x.slug) })), { key: 'close', hotkey: 'x', onPress: () => void ctx.closePanel() }])
  if (hk) rows.unshift(hk)
  return <Box flexDirection="column">{rows}</Box>
}

type RegEntry = { slug: string; name: string; kind: string; scope: string; counts: Record<string, number>; spec: string; labels: string[]; paths: string[]; field?: string; rows?: string }

async function allLabels(ctx: HarnessCtx): Promise<RegEntry[]> {
  const { cwd } = await ctx.where()
  try {
    const reg = JSON.parse(await ctx.read(`${cwd}/${ctx.home}/labels.json`)) as RegEntry[]
    return Array.isArray(reg) ? reg.filter(x => x && typeof x.slug === 'string').reverse() : []
  } catch {
    return []
  }
}

/** A label of this folder in the panel, one an earlier session made read back from its files first. */
export async function openLabel(ctx: HarnessCtx, slug: string): Promise<boolean> {
  const l = await ensureLabel(ctx, slug)
  if (!l) return false
  await ctx.setLabelOpen(slug)
  await ctx.openHarness('label', `Label: ${clip(l.name, 40)}`)
  return true
}

/** The list of labels, or one label by its name (/thimble-label list, /thimble-label open <name>). */
export async function labelsCommand(ctx: HarnessCtx, args: string): Promise<{ text: string }> {
  const want = args.trim()
  if (want) {
    const list = await allLabels(ctx)
    const hit = list.find(x => x.slug === labelSlug(want) || x.name.toLowerCase() === want.toLowerCase()) ?? list.find(x => x.name.toLowerCase().includes(want.toLowerCase()))
    if (hit && (await openLabel(ctx, hit.slug))) return { text: `opened the label "${hit.name}"` }
    return { text: `no label "${want}"` }
  }
  await ctx.openHarness('labels', 'Labels')
  const n = (await allLabels(ctx)).length
  return { text: `${n} label${n === 1 ? '' : 's'}` }
}

/** /thimble-label: the labels (nothing, or `list`), one opened (`open <name>`, or a label's name alone), or a label
 *  defined and run with the label tool's arguments (a label of this folder named with only a trial size or --all runs
 *  again as it was defined; named with some of its parts, those parts change). The run goes on in the panel, and main
 *  is told its counts when it ends. */
export async function labelCommand(ctx: HarnessCtx, args: string): Promise<{ text: string }> {
  const got = parseLabelArgs(args)
  if ('error' in got) return { text: got.error }
  if (got.op === 'list') return labelsCommand(ctx, '')
  if (got.op === 'open') return labelsCommand(ctx, got.name)
  const x = got.input
  const name = x.name ?? ''
  const { cwd } = await ctx.where()
  let saved: Record<string, unknown> | undefined
  try {
    saved = JSON.parse(await ctx.read(`${cwd}/${ctx.home}/labels/${labelSlug(name)}/spec.json`)) as Record<string, unknown>
  } catch {
    saved = undefined
  }
  if (namesOnly(x) && !x.limit && !got.all) {
    const opened = await labelsCommand(ctx, name)
    return /^opened/.test(opened.text) ? opened : { text: `no label "${name}" in this folder; a new one needs kind, definition and paths, as /thimble-label ${name} kind=prompt definition="…" paths=…` }
  }
  if (namesOnly(x) && !saved) return { text: `no label "${name}" in this folder; a new one needs kind, definition and paths, as /thimble-label ${name} kind=prompt definition="…" paths=…` }
  const { limit: _limit, ...parts } = x
  const spec = specOf({ ...(saved ?? {}), ...parts, name: typeof saved?.name === 'string' ? saved.name : name })
  if (typeof spec === 'string') return { text: `${spec}. /thimble-label takes ${LABEL_USAGE}` }
  const limit = x.limit ?? 0
  const slug = labelSlug(spec.name)
  await ctx.setLabelOpen(slug)
  await ctx.openHarness('label', `Label: ${clip(spec.name, 40)}`)
  const was = saved ? specOf(saved) : undefined
  void runLabel(ctx, spec, limit).then(
    async f => {
      if ('error' in f && f.error) {
        ctx.toast(`label "${spec.name}": ${clip(f.error, 100)}`)
        return
      }
      const done = f as Finished
      const how = !was || typeof was === 'string' ? `defined the label "${spec.name}" (${spec.kind}: "${clip(spec.definition, 300)}" over ${spec.paths.join(', ')}) with /thimble-label and ran it` : sameSpec(was, spec) ? `ran the label "${spec.name}" again with /thimble-label` : `changed the label "${spec.name}" with /thimble-label (now ${spec.kind}: "${clip(spec.definition, 300)}" over ${spec.paths.join(', ')}) and ran it`
      await ctx.noteMain(`thimble-cc-mod: the analyst ${how} on ${done.trial ? `a sample of ${num(done.labeled)}` : `all ${num(done.labeled)}`} records: ${spec.values.map(v => `${v} ${num(done.counts[v] ?? 0)}`).join(', ')}. Its cards: ${done.cards.map(c => `[[card:${c}]]`).join(' ')}.`)
    },
    (err: unknown) => ctx.toast(`label "${spec.name}": ${clip(String(err), 100)}`),
  )
  return { text: labelLine({ ...spec, ...(spec.within ? { within: spec.within } : {}), ...(limit ? { limit } : {}) }, true) }
}
