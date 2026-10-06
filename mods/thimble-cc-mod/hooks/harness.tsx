// The analysis harness: what the agents read of the corpus (coverage), a labeling tool like thimble's apply_label,
// and /thimble-orient, an orientation run as a fork whose coverage is checked before it may end.
//
// - Coverage. Every tool result of main and of every subagent (session.append) is handed to helper/coverage.py, which
//   decides which files and records it showed or scanned (helper/pyaudit notes the files Python opens). The row above
//   the prompt says it in one line ("read 2 of 4 files · 0.4% of records · 1 never opened"), /thimble-coverage and
//   its "details" open the panel (each file, what was read of it, and what was never opened), main gets the line
//   with each prompt, and when main ends a turn on an answer that speaks for the corpus as a whole while a kind of
//   file was never opened, the mod sends it what it missed, once per prompt of the analyst's: as context main reads
//   and the analyst does not see, while main's chat shows one dim line (register.tsx sendCheck).
// - Labels. Main's `label` tool defines a category over the records of some files (a prompt, a regex or a code
//   predicate), tries it on a sample or applies it to all, and answers with the counts, examples of each value and
//   two cards. A prompt label's records are judged by model calls in batches ($.model.complete, thimble's labels
//   prompt); a regex or code label runs in helper/labels.py. The panel shows the label: its definition, counts,
//   examples (the analyst can set a record's value, which wins and teaches the next run), "apply to all" and an
//   edit field. Labels are kept in .thimble-cc-mod/labels.json, where the views read them.
// - The orientation. /thimble-orient [brief] starts a fork with prompt/orient.md as a report writer, so the panel shows
//   it working and then draws its document. Its tool results carry the count's line while files remain unopened;
//   when it ends with a file unopened, a kind of file with no record read or no document, a second fork
//   (prompt/orient-again.md) reads what it missed and revises the document; then the mod adds a section of what was
//   read, each range a citation, before the document is shown.
//
// register.tsx hands this module what it shares (HarnessCtx, built on ReportCtx) and calls it from its hooks.
import type { MatchedEvent, ModelCompleteRequest, ModelCompleteResult, RenderElement, ResolveInput } from 'claude-code'

import type { ChatCoverage, ChatLabel, ChatLabelExample, ChatReport } from '../types'
import { clip } from './lib'
import { demojibake, placeWords, valueColour } from './draw'
import { COLORS } from './paint'
import type { ReportCtx } from './reports'
import { slugOf } from './report'
import { withGuide } from './threads'
import { LABEL_USAGE, ORIENT_DEFAULTS, labelInputOf, labelLine, namesOnly, orientLine, orientOptsOf, parseLabelArgs, parseOrientArgs } from './commands'
import type { OrientOpts } from './commands'
import { startReport } from './reports'

type PaneEvent = MatchedEvent<'ui.render', { component: 'Pane'; requestId: string }>
type AboveEvent = MatchedEvent<'ui.render', { component: 'AbovePrompt' }>

/** What register.tsx shares with the harness, bound to the hook's `$` (register.tsx harnessCtx). */
export type HarnessCtx = ReportCtx & {
  /** `run` in the sandbox of the mod's own scripts (register.tsx boxRun), for the label runs that run code */
  boxed: ReportCtx['run']
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
  const r = await ctx.run(['python3', `${root}/helper/coverage.py`, 'summary', '--cwd', cwd, '--session', session, ...agents.flatMap(a => ['--agent', a])], { cwd, timeoutMs: 120000 })
  if (r.exitCode !== 0) return null
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

/** What main is sent after an answer that speaks for the corpus as a whole while a kind of file was never opened, or
 *  had no record read (only counted over by code), or null when nothing calls for it: a short answer with no
 *  citation, card or heading never does. */
export function critiqueOf(s: CoverageSummary, answer: string): string | null {
  return checkOf(s, answer)?.text ?? null
}

/** The check critiqueOf words for main, and the one line main's chat shows of it ("events.jsonl and labels.jsonl never
 *  opened · pages.jsonl only counted"), or null. */
export function checkOf(s: CoverageSummary, answer: string): { text: string; line: string } | null {
  const substantial = answer.length > 400 || /\[\[/.test(answer) || /^##\s/m.test(answer)
  if (!substantial || !GENERAL.test(answer) || !s.totals.files) return null
  const missed = new Set(s.kinds.filter(k => k.untouched === k.files).map(k => k.kind))
  const unread = new Set(s.kinds.filter(k => !missed.has(k.kind) && k.records > 0 && k.records_seen === 0).map(k => k.kind))
  if (!missed.size && !unread.size) return null
  const untouched = s.files.filter(f => f.state === 'untouched')
  const counted = s.files.filter(f => f.state === 'scanned' && unread.has(kindOf(f.file)))
  const name = (f: CoverageFile) => `${f.file} (${f.records !== null ? `${num(f.records)} records` : `${num(f.size)} bytes`})`
  const list = (fs: CoverageFile[]) => `${fs.slice(0, 8).map(name).join(', ')}${fs.length > 8 ? `, and ${fs.length - 8} more` : ''}`
  const parts = [`Coverage check from thimble-cc-mod: this session has ${s.line}.`]
  if (missed.size) parts.push(`No call opened ${missed.size === 1 ? 'this kind of file' : `these ${missed.size} kinds of file`}: ${list(untouched)}.`)
  if (unread.size) parts.push(`Code counted over ${unread.size === 1 ? 'this kind of file' : `these ${unread.size} kinds of file`}, but no call showed you any of ${unread.size === 1 ? 'its' : 'their'} records: ${list(counted)}.`)
  parts.push(
    'Your answer speaks for the corpus as a whole. Before you finish, read a few records of each from its start, middle and end, and count over the files no call opened, then revise the answer where they change it, or say in it which files and how much of them it rests on. `python3 {{helper}}/coverage.py` lists what was read of each file.',
  )
  const line = [missed.size ? `${fileWords(untouched)} never opened` : '', unread.size ? `${fileWords(counted)} only counted` : ''].filter(Boolean).join(' · ')
  return { text: parts.join(' '), line }
}

/** Files by name in a line: "a, b and c", or the first two and how many more. */
export function fileWords(fs: readonly { file: string }[]): string {
  const names = fs.map(f => f.file)
  if (names.length <= 3) return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '')
  return `${names.slice(0, 2).join(', ')} and ${num(names.length - 2)} more`
}

/** A file's kind, as helper/coverage.py kind_of masks it: ids and numbers in its path replaced. */
export function kindOf(file: string): string {
  return file.replace(/(?=[0-9a-f]*\d)[0-9a-f]{8,}/gi, '*').replace(/\d+/g, '#')
}

/** What the orientation is told when it tries to end too soon, or null: a file nothing opened, a kind of text file
 *  with no record read, or its document not written. */
export function orientGaps(s: CoverageSummary, written: boolean, file: string): string | null {
  const untouched = s.files.filter(f => f.state === 'untouched')
  const unread = s.kinds.filter(k => k.records > 0 && k.records_seen === 0)
  const out: string[] = []
  if (!written) out.push(`You have not written the document to ${file}.`)
  if (untouched.length) out.push(`No call has opened ${untouched.length === 1 ? 'this file' : `these ${untouched.length} files`}: ${untouched.slice(0, 12).map(f => f.file).join(', ')}${untouched.length > 12 ? ', …' : ''}.`)
  if (unread.length) out.push(`You have read no record of ${unread.length === 1 ? 'this kind of file' : 'these kinds of file'} yourself, only counted over ${unread.length === 1 ? 'it' : 'them'}: ${unread.slice(0, 8).map(k => k.kind).join(', ')}.`)
  if (!out.length) return null
  return [`thimble-cc-mod coverage check before the orientation ends (${s.line}):`, ...out, 'Read a sample of each (its start, middle and end) or count over it with a script, revise the document and its cards where what you find changes them, then end.'].join(' ')
}

/** The line main gets with each prompt: what this session has read, and the files nothing opened. */
export async function coverageContext(ctx: HarnessCtx): Promise<string> {
  const c = await ctx.coverage()
  if (!c || c.files === 0) return ''
  return `thimble-cc-mod coverage so far in this session: ${c.line} (of ${num(c.records)} records in ${c.files} files). \`python3 {{helper}}/coverage.py\` lists each file.`
}

/** The one line above the prompt, once anything was read: the count, and "details" for the panel. */
export async function coverageRow(ctx: HarnessCtx, e: AboveEvent): Promise<RenderElement | null> {
  const c = await ctx.coverage()
  if (!c || c.read + c.scanned === 0) return null
  const { Box, Text, Button } = ctx.els(e as unknown as ResolveInput)
  const parts = c.line.split(' · ')
  // as the rows above the prompt draw: the label dim at column 2, the value at column 12, the control after a gutter
  return (
    <Box key="coverage-row" flexDirection="row">
      <Box width={12} flexShrink={0}>
        <Text dimColor>{'  coverage'}</Text>
      </Box>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          {parts.map((p, i) => (
            <Text key={`cov-${i}`} {...(/only counted/.test(p) ? { dimColor: true } : {})}>
              {`${i ? ' · ' : ''}${p}`}
            </Text>
          ))}
        </Text>
      </Box>
      <Text>{'  '}</Text>
      <Button key="coverage-details" label="details ›" plain onPress={() => void ctx.openHarness('coverage', 'Coverage')} />
    </Box>
  )
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
  if (covDetail.at !== at || !covDetail.data) covDetail = { at, data: await coverageSummary(ctx) }
  return covDetail.data
}

/** The coverage panel: its title row with the line dim and `read what was missed ›` against the right edge; under the
 *  rule, a row per file, those nothing opened first: its state (● read, ○ not), its name, a bar of what was read on a
 *  track, its records and the share read against the right edge; a dim secondary row of the lines read. */
export async function drawCoverage(e: PaneEvent, ctx: HarnessCtx): Promise<RenderElement> {
  const { Box, Text, Button } = ctx.els(e as unknown as ResolveInput)
  const s = await coverageDetail(ctx)
  const cols = Math.max(30, e.props.bodyColumns)
  const gaps = s ? s.files.filter(f => f.state !== 'read').map(f => f.file) : []
  const askMissed = () =>
    void ctx.thread({
      label: 'the files no answer has read',
      context: `thimble-cc-mod's coverage count of this session: ${s?.line ?? ''}. Files with no record read: ${gaps.slice(0, 30).join(', ')}.\nRead a sample of each (start, middle, end), say what each holds and whether it changes any answer so far.`,
    })
  const rows: RenderElement[] = [
    <Box key="cov-title" flexDirection="row">
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          <Text>Coverage</Text>
          <Text dimColor>{`  ${s ? s.line : "what this session's agents read of the corpus"}`}</Text>
        </Text>
      </Box>
      <Box flexGrow={1} />
      {gaps.length ? <Button key="cov-ask" label="read what was missed ›" plain onPress={askMissed} /> : null}
    </Box>,
    <Text key="cov-rule" color={COLORS.rule}>{'─'.repeat(cols)}</Text>,
  ]
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
      const judged = f.judged ? ` · ${num(f.judged)} judged by a label` : ''
      const what = f.state === 'untouched' ? 'never opened' : f.state === 'scanned' ? `counted by code, no record read${judged}` : `lines ${rangeWords(f.ranges, 4)}${judged}`
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
    if (s.kinds.length > 1 && s.kinds.length < s.files.length) {
      rows.push(<Text key="cov-kinds-gap"> </Text>)
      rows.push(<Text key="cov-kinds-t">By kind of file</Text>)
      for (const k of s.kinds.slice(0, 20)) rows.push(<Text key={`cov-k:${k.kind}`} dimColor wrap="truncate-end">{`  ${k.kind}  ${k.read} read · ${k.scanned} counted · ${k.untouched} never opened of ${k.files}`}</Text>)
    }
  }
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
  return { text: (await ctx.coverage())?.line ?? 'nothing read yet' }
}

// ------------------------------------------------------------------------------------------------ the check after a turn

// Claude Code here does not hand a hooks module the classic Stop event (checked live on 2.1.290: neither classic.Stop
// nor classic.UserPromptSubmit reaches one), so the check runs at main's turn.complete, and main answers it in a turn
// of its own (register.tsx sendCheck says how it reaches main). Once a prompt of the analyst's: the turn it starts is
// never checked again.
let checking = true // /thimble-coverage check on|off
let followUp = false // the next turn of main answers the check

/** At the end of main's turn: the check (its text for main and its line for main's chat) when the answer speaks for
 *  the whole corpus while a kind of file was never opened, else null. The turn that answers a check is not checked. */
export async function coverageAfterTurn(ctx: HarnessCtx, answer: string): Promise<{ text: string; line: string } | null> {
  if (followUp) {
    followUp = false
    return null
  }
  if (!checking || !answer.trim()) return null
  const s = await coverageSummary(ctx)
  if (!s) return null
  const check = checkOf(s, answer)
  if (!check) return null
  followUp = true
  const { root } = await ctx.where()
  return { ...check, text: check.text.replace('{{helper}}', `${root}/helper`) }
}

/** /thimble-coverage check on|off. */
export function setChecking(on: boolean): void {
  checking = on
}

// ------------------------------------------------------------------------------------------------ the orientation

/** An orientation's round: its report, the analyst's request and switches, the coverage rounds it had, whether the
 *  critique ran, and the count's line it was last told. */
type Orient = { slug: string; file: string; brief: string; opts: OrientOpts; rounds: number; critiqued: boolean; noted: string }

const orients = new Map<string, Orient>() // an orientation's agent -> its round
let starting = false // an orientation asked for whose first fork has not started yet
const ORIENT_ROUNDS = 1 // follow-up rounds an orientation gets for what it left unread
const AGAIN = ' · reading what it missed'
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
  const o: Orient = { slug: a.report, file: r?.file ?? `${ctx.home}/reports/${a.report}.md`, brief, opts: { brief, ...ORIENT_DEFAULTS, ...(r?.orient ?? {}) }, rounds: a.label.endsWith(AGAIN) ? 1 : 0, critiqued: a.label.endsWith(CRITIQUE), noted: '' }
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
  'Call it when the analyst asks for an orientation, or for an overview of the whole corpus they have not seen yet, with their focus as `brief`. Set a switch only when the analyst names it, such as "without a report" or "no views"; a switch left out keeps thimble\'s Start default (all on). One orientation runs at a time.',
].join(' ')
export const ORIENT_SCHEMA = {
  type: 'object',
  properties: {
    brief: { type: 'string', description: "what the analyst wants the orientation to focus on, in their words; empty for the whole corpus" },
    deck: { type: 'boolean', description: 'the document holds five to eight cards (default true); false: a document without cards' },
    views: { type: 'boolean', description: 'it proposes up to four views, which are built in the background (default true)' },
    critique: { type: 'boolean', description: 'a reviewer who did not do the analysis checks the document against the records and revises it (default true)' },
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
        orients.set(s.agentId, { slug, file: r.file, brief, opts, rounds: 0, critiqued: false, noted: '' })
        await ctx.setAgent(s.agentId, { kind: 'report', label, report: slug })
        await ctx.setReport({ ...((await ctx.report(slug)) ?? r), agentId: s.agentId })
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
  orients.set(sp.agentId, { ...o, ...next, noted: '' })
  await ctx.setAgent(sp.agentId, { kind: 'report', label, report: o.slug })
  const r = await ctx.report(o.slug)
  if (r) await ctx.setReport({ ...r, agentId: sp.agentId, partial })
  return true
}

/** An orientation's round ended. With gaps (a file unopened, a kind of file with no record read, no document) and a
 *  round left, a follow-up fork reads what it missed and revises the document; then, when the critique is on, a fork
 *  that did not do the analysis reviews the document and revises it; while one runs the report stays "writing"
 *  (true). Else the section of what was read is added, the writer starts when the report is on, and the reports
 *  module may show the document (false). Claude Code here hands a hooks module no classic SubagentStop, which would
 *  have kept the orientation itself going. */
export async function orientEnded(ctx: HarnessCtx, agentId: string, reason: string): Promise<boolean> {
  const o = await orientOf(ctx, agentId)
  if (!o) return false
  orients.delete(agentId)
  const { cwd, root } = await ctx.where()
  const written = await ctx.read(`${cwd}/${o.file}`).then(t => t.trim().length > 0, () => false)
  const s = await coverageSummary(ctx)
  const gaps = s && reason === 'answer' ? orientGaps(s, written, o.file) : null
  const values: Record<string, string> = { gaps: gaps ?? '', file: o.file, brief: o.brief || '(none: the whole corpus)', helper: `${root}/helper`, slug: o.slug }
  const on = { deck: o.opts.deck, views: o.opts.views, critique: o.opts.critique, report: o.opts.report }
  if (gaps && o.rounds < ORIENT_ROUNDS && !o.critiqued) {
    const prompt = withGuide(await ctx.guide(), fillPrompt(await ctx.read(`${root}/prompt/orient-again.md`), on, values))
    if (await orientRound(ctx, o, prompt, AGAIN, 'reading the files the first round missed', { rounds: o.rounds + 1 })) return true
  }
  if (o.opts.critique && !o.critiqued && written && reason === 'answer') {
    const prompt = withGuide(await ctx.guide(), fillPrompt(await ctx.read(`${root}/prompt/orient-critique.md`), on, values))
    if (await orientRound(ctx, o, prompt, CRITIQUE, 'a reviewer checks the document against the records', { critiqued: true })) return true
  }
  if (written && s) {
    const text = await ctx.read(`${cwd}/${o.file}`).catch(() => '')
    if (text.trim() && !/^## What the orientation read/m.test(text)) await ctx.write(`${cwd}/${o.file}`, `${text.trimEnd()}\n\n${coverageSection(s)}`)
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

/** A tool result of an orientation, with the count's line after it when the line changed, so it sees what it has not
 *  opened while it works. */
export async function orientNote<M extends { content: unknown }>(ctx: HarnessCtx, agentId: string | undefined, door: string, msg: M): Promise<M> {
  if (door !== 'tool-result' || !Array.isArray(msg.content)) return msg
  const o = await orientOf(ctx, agentId)
  if (!o) return msg
  const c = await ctx.coverage()
  if (!c || !c.untouched || c.line === o.noted) return msg
  o.noted = c.line
  const note = `thimble-cc-mod coverage so far: ${c.line}${c.unopened.length ? `; never opened: ${c.unopened.join(', ')}` : ''}.`
  const blocks = msg.content as { type?: string; content?: unknown }[]
  const i = blocks.findIndex(b => b.type === 'tool_result')
  if (i < 0) return msg
  const b = blocks[i]!
  const parts = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : Array.isArray(b.content) ? (b.content as unknown[]) : []
  const out = blocks.slice()
  out[i] = { ...b, content: [...parts, { type: 'text', text: note }] }
  return { ...msg, content: out }
}

/** The section of what an orientation read, from the count, each read range a citation of its lines. */
export function coverageSection(s: CoverageSummary): string {
  const lines = ['## What the orientation read', '', `> [!NOTE] thimble-cc-mod's count of this session: ${s.line}, ${num(s.totals.records_seen)} of ${num(s.totals.records)} records seen in a call's output.`, '']
  const order = { untouched: 0, scanned: 1, read: 2 } as const
  const files = [...s.files].sort((a, b) => order[a.state] - order[b.state] || a.file.localeCompare(b.file))
  lines.push('<details><summary>Each file</summary>', '')
  for (const f of files.slice(0, 60)) {
    const recs = f.records !== null ? `${num(f.records)} records` : `${num(f.size)} bytes`
    const what =
      f.state === 'untouched'
        ? 'never opened'
        : f.state === 'scanned'
          ? 'counted by code, no record read'
          : `read ${num(f.seen)} (${pct(f.seen, f.records ?? 0)}), such as ${f.ranges
              .slice(0, 3)
              .map(([a = 1, b = 1]) => `[[${f.file}#L${a}${b !== a ? `-L${b}` : ''}]]`)
              .join(' ')}`
    lines.push(`- \`${f.file}\`, ${recs}: ${what}`)
  }
  if (files.length > 60) lines.push(`- … ${files.length - 60} more files`)
  lines.push('', '</details>', '')
  return lines.join('\n')
}

// ------------------------------------------------------------------------------------------------ labels

export const LABEL_TOOL = 'mcp__thimble-cc-mod__label'
export const LABEL_DESCRIPTION = [
  "thimble-cc-mod's labeling tool: define a category over the records of some files and apply it to each record, as thimble's apply_label does. The analyst sees the label in the panel (its definition, counts and examples of each value) and can correct it.",
  'A record is a line of a text file (a JSON line is read as its object) or a row of a CSV file. kind "regex": a Python pattern searched in each record (its field when `field` is given); a match takes the first value, any other record the last. kind "code": Python defining label(unit) that returns (value, confidence), where unit is the JSON record\'s dict, a CSV row\'s dict or {"text": line}. kind "prompt": a model reads each record against `definition`, for a category that takes reading for meaning.',
  'Use it whenever you sort records into categories, instead of a regex or keyword test inside a script. Try a new label with `limit` (about 30 records, spread over the files), read its examples, fix the definition, then run it again without `limit`.',
  "It answers with the count of each value, examples, and a label card (the count of each value, and records the analyst can agree or disagree with in place) to embed and cite. A card script reads a label's values with tcard's label(name), and its cards then show the label. To run a label of this folder again, such as on every record after a trial or after the analyst corrected records, give only its name (and limit for a trial): records whose value it kept are not read again.",
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
  if (f.card_output) lines.push('', `The label's card, made by ${f.script}, shows the counts and the first examples, which the analyst can agree or disagree with in place:`, f.card_output.trim())
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

/** The label panel: the title row is the label's name with its controls against the right edge, how it was run dim
 *  under it; under the rule, the definition as prose at A2; the values' bars, parts of the whole on tracks (the
 *  catch-all's dim), each with its count and its share dim; `card` and the card's question with `›`; under the second
 *  rule, the records grouped by value, each group under a heading; the field that edits the definition. */
export async function drawLabel(e: PaneEvent, ctx: HarnessCtx): Promise<RenderElement> {
  const { Box, Text, Button, Input } = ctx.els(e as unknown as ResolveInput)
  const slug = await ctx.labelOpen()
  const l = slug ? await ctx.label(slug) : undefined
  const cols = Math.max(30, e.props.bodyColumns)
  if (!l) return <Text dimColor>none</Text>
  const rows: RenderElement[] = []
  const how = l.kind === 'prompt' ? 'a model reads each record' : l.kind === 'regex' ? 'a regex matches each record' : 'code decides each record'
  const keys: { key: string; hotkey: string; onPress: () => void }[] = []
  const controls: RenderElement[] = []
  if (l.state === 'running') {
    controls.push(<Button key="lb-stop" label="stop" plain onPress={() => running.get(l.slug)?.abort()} />)
    keys.push({ key: 'stop', hotkey: 's', onPress: () => running.get(l.slug)?.abort() })
  }
  if (l.state !== 'running' && l.trial) {
    controls.push(<Button key="lb-all" label={`apply to all ${num(l.total)}`} plain onPress={() => void rerun(ctx, l, {}, 0)} />)
    keys.push({ key: 'all', hotkey: 'a', onPress: () => void rerun(ctx, l, {}, 0) })
  }
  controls.push(<Button key="lb-list" label="all labels ›" plain onPress={() => void ctx.openHarness('labels', 'Labels')} />)
  keys.push({ key: 'list', hotkey: 'l', onPress: () => void ctx.openHarness('labels', 'Labels') }, { key: 'close', hotkey: 'x', onPress: () => void ctx.closePanel() })
  rows.push(
    <Box key="lb-title" flexDirection="row">
      <Box flexShrink={1}>
        <Text wrap="truncate-end">{l.name}</Text>
      </Box>
      <Box flexGrow={1} />
      <Box flexShrink={0} flexDirection="row" columnGap={2}>
        {controls}
      </Box>
    </Box>,
  )
  const scope = l.state === 'running' ? `◌ labeling ${num(l.labeled)} of ${num(l.limit > 0 && l.total ? Math.min(l.limit, l.total) : l.total)}` : l.trial ? `a trial on ${num(l.labeled)} of ${num(l.total)} records` : `all ${num(l.labeled)} records`
  rows.push(<Text key="lb-scope" dimColor wrap="wrap">{`${l.kind} · ${how} · ${scope} · ${l.paths.join(', ')}${l.field ? ` (field ${l.field})` : ''}${l.within ? `, among those "${l.within.label}" gave ${l.within.value ?? 'its first value'}` : ''}`}</Text>)
  rows.push(<Text key="lb-rule" color={COLORS.rule}>{'─'.repeat(cols)}</Text>)
  // the definition as prose at A2 (code as text, its comments dim)
  const measure = Math.min(72, cols - 2)
  if (l.kind === 'code') {
    const code = l.definition.split('\n')
    code.slice(0, 14).forEach((ln, i) => {
      const at = ln.indexOf('#')
      rows.push(
        <Text key={`lb-def:${i}`} wrap="truncate-end">
          <Text>{`  ${at < 0 ? ln || ' ' : ln.slice(0, at)}`}</Text>
          {at >= 0 ? <Text dimColor>{ln.slice(at)}</Text> : null}
        </Text>,
      )
    })
    if (code.length > 14) rows.push(<Text key="lb-def-more" dimColor>{`  … ${code.length - 14} more`}</Text>)
  } else {
    rows.push(
      <Box key="lb-def" paddingLeft={2} width={measure + 2}>
        <Text wrap="wrap">{clip(l.definition, 600)}</Text>
      </Box>,
    )
  }
  if (l.state === 'error') rows.push(<Text key="lb-err" color={COLORS.problem} wrap="wrap">{`× ${l.why ?? 'failed'}`}</Text>)
  // what the run recovered from, one dim line; what it could not, one line each in red
  if (l.status) rows.push(<Text key="lb-status" dimColor wrap="wrap">{l.status}</Text>)
  for (const err of l.errors) rows.push(<Text key={`lb-e:${err}`} color={COLORS.problem} wrap="wrap">{`! ${err}`}</Text>)
  rows.push(<Text key="lb-gap"> </Text>)
  const total = l.values.reduce((a, v) => a + (l.counts[v] ?? 0), 0)
  const vw = Math.min(Math.max(12, Math.floor(cols / 3)), Math.max(...l.values.map(v => v.length)))
  const counts = l.values.map(v => num(l.counts[v] ?? 0))
  const cw = Math.max(...counts.map(c => c.length))
  // the track takes what the names and the numbers leave, so the shares end on R (rule 4)
  // ● and a space, the name and a gutter, the bar, a gutter and the count, a gutter and the share (5)
  const barW = Math.max(8, cols - 2 - vw - 2 - 2 - cw - 7)
  l.values.forEach((v, i) => {
    const n = l.counts[v] ?? 0
    const w = total ? Math.round((barW * n) / total) : 0
    const colour = valueColour(l.values, v)
    rows.push(
      <Text key={`lb-c:${v}`} wrap="truncate-end">
        <Text {...(colour && colour !== COLORS.dim ? { color: colour } : { dimColor: true })}>{'● '}</Text>
        <Text>{`${clip(v, vw).padEnd(vw)}  `}</Text>
        <Text {...(colour && colour !== COLORS.dim ? { color: colour } : { dimColor: true })}>{'█'.repeat(w)}</Text>
        <Text color={COLORS.rule}>{'─'.repeat(barW - w)}</Text>
        <Text>{`  ${counts[i]!.padStart(cw)}`}</Text>
        <Text dimColor>{total ? `  ${pct(n, total).padStart(5)}` : ''}</Text>
      </Text>,
    )
  })
  // the label's card by its question, which opens it (its script one press further)
  for (const id of l.cards.slice(0, 2)) {
    const card = await ctx.loadCard(id)
    if (card) rows.push(
      <Box key={`lb-card:${id}`} flexDirection="row">
        <Text dimColor>{'card  '}</Text>
        <Button key={`lb-card-open:${id}`} label={`${clip(card.question, Math.max(20, cols - 10))} ›`} plain onPress={() => void ctx.openCard(id)} />
      </Box>,
    )
  }
  rows.push(<Text key="lb-rule2" color={COLORS.rule}>{'─'.repeat(cols)}</Text>)
  let firstGroup = true
  for (const v of l.values) {
    const xs = l.examples.filter(x => x.value === v)
    if (!xs.length) continue
    if (!firstGroup) rows.push(<Text key={`lb-gap:${v}`}> </Text>)
    firstGroup = false
    rows.push(<Text key={`lb-h:${v}`}><Text color={valueColour(l.values, v)}>{'● '}</Text><Text>{v}</Text><Text dimColor>{`  ${num(xs.length)}`}</Text></Text>)
    for (const x of xs) {
      const others = l.values.filter(o => o !== v)
      rows.push(
        <Box key={`lb-x:${x.ref}`} flexDirection="column" marginLeft={2}>
          <Box flexDirection="row" columnGap={2}>
            <Box flexDirection="row" flexShrink={1}>
              <Button key={`lb-open:${x.ref}`} label="↗" plain onPress={() => void ctx.openRef(x.ref)} />
              <Text> </Text>
              <Text underline wrap="truncate-end">{placeWords(x.ref)}</Text>
            </Box>
            {/* the controls, or what the analyst did, one block against R (rule 25) */}
            <Box flexGrow={1} />
            {x.analyst ? <Text dimColor>{x.was && x.was !== v ? '✓ set by you' : '✓ agreed'}</Text> : null}
            {x.analyst ? null : <Button key={`lb-agree:${x.ref}`} label="agree" plain onPress={() => void labelVerdict(ctx, l.slug, x.ref, v)} />}
            {x.analyst ? null : others.length === 1 ? (
              <Button key={`lb-set:${x.ref}:${others[0]}`} label="disagree" plain onPress={() => void labelVerdict(ctx, l.slug, x.ref, others[0]!)} />
            ) : (
              <Box key={`lb-dis:${x.ref}`} flexDirection="row" columnGap={2} flexWrap="wrap">
                <Text dimColor>it is</Text>
                {others.map(o => (
                  <Button key={`lb-set:${x.ref}:${o}`} label={clip(o, 24)} plain onPress={() => void labelVerdict(ctx, l.slug, x.ref, o)} />
                ))}
              </Box>
            )}
          </Box>
          <Box width={Math.min(72, cols - 2)}>
            <Text italic wrap="wrap">{clip(demojibake(x.text), Math.max(80, cols * 2))}</Text>
          </Box>
          {x.rationale && !(x.analyst && x.was && x.was !== v) ? (
            <Box width={Math.min(72, cols - 2)}>
              <Text dimColor wrap="wrap">{`why  ${clip(x.rationale, cols * 2)}`}</Text>
            </Box>
          ) : null}
        </Box>,
      )
    }
  }
  if (l.state !== 'running') {
    rows.push(<Text key="lb-gap2"> </Text>)
    rows.push(
      <Box key="lb-edit-row" flexDirection="row">
        <Text dimColor>{'definition  '}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Input key={`lb-edit:${l.slug}`} value={l.definition} submitLabel={l.trial ? 'try again' : 'apply again'} onSubmit={v => void rerun(ctx, l, { definition: v.trim() || l.definition })} />
        </Box>
      </Box>,
    )
  }
  const hk = hiddenKeys(ctx, e, keys)
  if (hk) rows.unshift(hk)
  return <Box flexDirection="column">{rows}</Box>
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

/** The labels of this folder, from .thimble-cc-mod/labels.json: its title row and count; under the rule, each label
 *  an item, its name at A2 and how it ran and its counts dim under it; a press opens one. */
export async function drawLabels(e: PaneEvent, ctx: HarnessCtx): Promise<RenderElement> {
  const { Box, Text, Button } = ctx.els(e as unknown as ResolveInput)
  const list = await allLabels(ctx)
  const cols = Math.max(30, e.props.bodyColumns)
  const rows: RenderElement[] = [<Text key="lbs-t"><Text>Labels</Text><Text dimColor>{`  ${list.length}`}</Text></Text>, <Text key="lbs-rule" color={COLORS.rule}>{'─'.repeat(cols)}</Text>]
  if (!list.length) rows.push(<Text key="lbs-none" dimColor>{'  none'}</Text>)
  list.forEach(x => {
    rows.push(
      <Box key={`lbs:${x.slug}`} flexDirection="column">
        <Box flexDirection="row">
          <Text>{'  '}</Text>
          <Button key={`lbs-open:${x.slug}`} label={clip(x.name, cols - 4)} plain onPress={() => void openLabel(ctx, x.slug)} />
        </Box>
        <Text dimColor wrap="truncate-end">{`  ${x.kind} · ${x.scope === 'trial' ? 'trial' : 'all records'} · ${Object.entries(x.counts).map(([v, n]) => `${v} ${num(n)}`).join(' · ')}`}</Text>
      </Box>,
    )
  })
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
  return { text: `${(await allLabels(ctx)).length} labels` }
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
