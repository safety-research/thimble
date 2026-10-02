// thimble-chat: a single-agent thimble inside Claude Code. No server, no browser.
//
// - Prompting: prompt/chat.md rides with the first prompt of a conversation as context (managed settings on this
//   machine bypass a user plugin's prompt.compose). It tells main to answer card shaped or report shaped, numbers from
//   code, every number cited.
// - Cards: main's Python writes a card with helper/tcard.py (.thimble-chat/cards/<id>.json); a reply line holding only
//   [[card:<id>]] is drawn as the card's panel there, between the reply's text, by the Client card.tsx. A card is one
//   of five typed specs; one that does not validate is drawn as an error, and main is asked to fix it.
// - Citations: every [[...]] of a reply is a chip coloured by what helper/resolve.py found at the ref (para.tsx).
//   A click opens the citation panel (the cited lines, highlighted), which can ask main for a verification script and
//   then runs it; the chip shows the outcome.
// - Direct manipulation: a card's params re-run its script; rerun, star, hide, edit the takeaway, ask a side thread.
// - Side threads (threads.tsx): a subagent answers out of main's chat; its result is offered back as one line.
// - Bash results: each output is saved (.thimble-chat/calls/<id>.json) and main is told its ref, so it can cite a line.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, ResolveInput } from 'claude-code'

import type { ChatNote, ChatRun, ChatThread, ChatVerdict, ChatVerify } from '../types'
import { COLORS, blockLayout, cardLayout, cut, statusColor } from './draw'
import type { CardData, CardMeta, ChipView } from './draw'
import { chipLabel, cid, citations, clip, embeddedCards, forMain, fromMod, needsDrawing, parseReply, scriptResult, sentenceOf, shownMatches, takeawayAfter, threadBody, unframed, validateCard, valueIn } from './lib'
import type { Citation } from './lib'
import { paintLines } from './paint'
import { forkPrompt, freshPrompt, lastTurn, threadFile } from './threads'

type Dollar = EngineInterface

const VERDICTS = { plugin: 'thimble-chat', key: 'verdicts' } as const
const VERIFY = { plugin: 'thimble-chat', key: 'verify' } as const
const NOTES = { plugin: 'thimble-chat', key: 'notes' } as const
const RUNS = { plugin: 'thimble-chat', key: 'runs' } as const
const THREADS = { plugin: 'thimble-chat', key: 'threads' } as const
const ENDS = { plugin: 'thimble-chat', key: 'ends' } as const
const openA = atom({ plugin: 'thimble-chat', key: 'open' } as const, '')
const turnA = atom({ plugin: 'thimble-chat', key: 'turn' } as const, null)
const hiddenA = atom({ plugin: 'thimble-chat', key: 'hidden' } as const, '')
const pendingA = atom({ plugin: 'thimble-chat', key: 'pending' } as const, [])
const paneCardA = atom({ plugin: 'thimble-chat', key: 'paneCard' } as const, '')
const paneModeA = atom({ plugin: 'thimble-chat', key: 'paneMode' } as const, '')
const pickedA = atom({ plugin: 'thimble-chat', key: 'picked' } as const, '')
const hoverA = atom({ plugin: 'thimble-chat', key: 'hover' } as const, '')
const editA = atom({ plugin: 'thimble-chat', key: 'edit' } as const, null)
const bandA = atom({ plugin: 'thimble-chat', key: 'band' } as const, false)
const threadA = atom({ plugin: 'thimble-chat', key: 'thread' } as const, '')
const threadListA = atom({ plugin: 'thimble-chat', key: 'threadList' } as const, [])

const CITE_PANE = 'thimble-cite'
const CARD_PANE = 'thimble-card'
const EDIT_PANE = 'thimble-edit'
const THREAD_PANE = 'thimble-thread'
const HOME = '.thimble-chat'
const CARD_MAX_COLS = 120
const GUIDE_MARK = '# thimble-chat\n'
const FIX_MARK = 'thimble-chat found problems'
const STATUS_WORDS: Record<string, string> = {
  ok: 'resolves, and the value is there',
  differs: 'resolves, but the value is not there',
  missing: 'does not resolve',
  unchecked: 'not checked',
  pending: 'not checked yet',
}

// ------------------------------------------------------------------------------------------------ module state

let guide = ''
let debug = false
let root = ''
let cwd = ''
const known = new Map<string, Citation>() // every citation seen, by id
const replyOf = new Map<string, string>() // a citation's id -> the reply text it was seen in
const cardReply = new Map<string, string>() // a card's id -> the reply text that embeds it
const cards = new Map<string, { mtime: number; data: CardData | null; error: string }>()
const pointerLog: string[] = []
const byAgent = new Map<string, string>() // a side thread's subagent id -> the thread's id

async function paths($: Dollar): Promise<void> {
  if (!root) root = $.plugin.root
  if (!cwd) cwd = await $.session.cwd()
}

/** The guidance for main (prompt/chat.md), read once; the system prompt can be composed before session.start ends. */
async function ensureGuide($: Dollar): Promise<string> {
  if (guide) return guide
  await paths($)
  debug = Boolean(await $.env.get('THIMBLE_CHAT_DEBUG'))
  try {
    guide = (await $.fs.read(`${root}/prompt/chat.md`)).replaceAll('{{helper}}', `${root}/helper`)
  } catch {
    guide = ''
  }
  return guide
}

/** A card file, read again when it changed; `error` says why it cannot be drawn (missing, not JSON, off its spec). */
async function cardFile($: Dollar, id: string): Promise<{ data: CardData | null; error: string }> {
  await paths($)
  const file = `${cwd}/${HOME}/cards/${id}.json`
  let mtime = 0
  try {
    const st = await $.fs.stat(file)
    mtime = Number((st as { mtimeMs?: number }).mtimeMs ?? 0)
  } catch {
    return { data: null, error: `no card ${id} (${HOME}/cards/${id}.json)` }
  }
  const hit = cards.get(id)
  if (hit && hit.mtime === mtime) return hit
  let got: { mtime: number; data: CardData | null; error: string }
  try {
    const raw = JSON.parse(await $.fs.read(file)) as unknown
    const why = validateCard(raw, id)
    got = why ? { mtime, data: null, error: `card ${id} does not validate: ${why}` } : { mtime, data: raw as CardData, error: '' }
  } catch {
    got = { mtime, data: null, error: `card ${id}: the file is not JSON` }
  }
  cards.set(id, got)
  return got
}

async function loadCard($: Dollar, id: string): Promise<CardData | null> {
  return (await cardFile($, id)).data
}

// ------------------------------------------------------------------------------------------------ card notes

async function noteOf($: Dollar, id: string): Promise<ChatNote> {
  return (await $.state.get({ ...NOTES, id })).value ?? {}
}

async function setNote($: Dollar, id: string, patch: Partial<ChatNote>): Promise<ChatNote> {
  await paths($)
  const note = { ...(await noteOf($, id)), ...patch }
  await $.state.set({ ...NOTES, id }, note)
  try {
    await $.fs.write(`${cwd}/${HOME}/notes/${id}.json`, JSON.stringify(note, null, 1))
  } catch {
    // the note stays in the session
  }
  return note
}

async function loadNotes($: Dollar): Promise<void> {
  await paths($)
  let names: string[] = []
  try {
    names = (await $.fs.list(`${cwd}/${HOME}/notes`)).map(x => (typeof x === 'string' ? x : (x as { name: string }).name))
  } catch {
    return
  }
  for (const name of names) {
    const m = /^([A-Za-z0-9_-]+)\.json$/.exec(name.split('/').at(-1) ?? '')
    if (!m) continue
    try {
      await $.state.set({ ...NOTES, id: m[1]! }, JSON.parse(await $.fs.read(`${cwd}/${HOME}/notes/${m[1]}.json`)) as ChatNote)
    } catch {
      // a broken note is skipped
    }
  }
}

async function metaOf($: Dollar, id: string): Promise<CardMeta> {
  const note = await noteOf($, id)
  const run = (await $.state.get({ ...RUNS, id })).value
  // a Client's props are plain data: no undefined values
  const meta: CardMeta = {}
  if (note.starred) meta.starred = true
  if (note.hidden) meta.hidden = true
  if (note.takeaway) meta.edited = true
  if (run?.busy) meta.busy = run.busy
  if (run?.error) meta.error = run.error
  return meta
}

// ------------------------------------------------------------------------------------------------ checking citations

const queue = new Map<string, Citation>()
let flushing = false

function remember(cs: Citation[], text?: string): void {
  for (const c of cs) {
    const id = cid(c.raw)
    known.set(id, c)
    if (text && !replyOf.has(id)) replyOf.set(id, text)
  }
}

/** Check citations with helper/resolve.py, one process for the batch, and keep each verdict in state. */
async function check($: Dollar, cs: Citation[]): Promise<void> {
  if (cs.length === 0) return
  await paths($)
  const items = cs.map(c => ({ id: cid(c.raw), ref: c.ref, display: c.display }))
  try {
    const r = await $.process.run(['python3', `${root}/helper/resolve.py`], {
      cwd,
      stdin: JSON.stringify({ cwd, items, around: 6 }),
      timeoutMs: 20000,
    })
    if (r.exitCode !== 0) {
      $.ui.log(`thimble-chat: the resolver failed: ${r.stderr.trim().split('\n').at(-1) ?? ''}`)
      return
    }
    const out = JSON.parse(r.stdout) as (Omit<ChatVerdict, 'raw' | 'display' | 'id'> & { id: string })[]
    for (const v of out) {
      const c = known.get(v.id) ?? cs.find(x => cid(x.raw) === v.id)
      if (!c) continue
      const window = (v.window ?? []).map(w => ({ ...w, text: w.text.length > 1200 ? `${w.text.slice(0, 1199)}…` : w.text }))
      await $.state.set({ ...VERDICTS, id: v.id }, { ...v, window, id: v.id, raw: c.raw, ref: c.ref, display: c.display })
    }
  } catch (err) {
    $.ui.log(`thimble-chat: could not check citations: ${String(err).slice(0, 120)}`)
  }
}

/** Queue citations for a check soon after. A render may not write state, and a timer set from a render runs in the
 *  render's dispatch, so a timer started at session.start flushes the queue (flushQueue). */
function enqueue($: Dollar, cs: Citation[]): void {
  for (const c of cs) queue.set(cid(c.raw), c)
}

async function flushQueue($: Dollar): Promise<void> {
  if (flushing || queue.size === 0) return
  flushing = true
  const batch = [...queue.values()]
  queue.clear()
  try {
    await check($, batch)
  } finally {
    flushing = false
  }
}

/** What is wrong with a reply, for main to fix: cards it embeds that cannot be drawn, citations that fail. */
async function problemsOf($: Dollar, text: string): Promise<string[]> {
  const out: string[] = []
  for (const id of embeddedCards(text)) {
    const f = await cardFile($, id)
    if (f.error) out.push(f.error)
  }
  const cs = citations(text)
  remember(cs, text)
  await check($, cs)
  for (const c of cs) {
    const v = (await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value
    if (v?.status === 'missing') out.push(`${c.raw} does not resolve: ${v.why}`)
    else if (v?.status === 'differs') out.push(`${c.raw}: ${v.why}`)
  }
  return out
}

// ------------------------------------------------------------------------------------------------ verification scripts

function scriptPath(id: string): string {
  return `${HOME}/verify/v-${id}.py`
}

function verifyPrompt(c: Citation, v: ChatVerdict | undefined, reply: string, script: string): string {
  const where =
    v?.kind === 'value'
      ? `row "${v.row}" of column "${v.column}" of card:${v.card}`
      : v?.kind === 'call'
        ? `line ${v.start} of the output of call:${v.call}`
        : v?.file
          ? `${v.file}${v.start ? ` line ${v.start}` : ''}`
          : c.ref
  const sentence = sentenceOf(reply, c.raw) || c.raw
  return [
    `thimble-chat: the analyst asks for a verification script of ${c.raw} (${where}), from your sentence "${clip(sentence, 300)}"`,
    `Write it at ${script}, following "Verification scripts" in thimble-chat's guidance.`,
  ].join('\n')
}

async function askVerify($: Dollar, id: string): Promise<void> {
  const c = known.get(id)
  if (!c) return
  const v = (await $.state.get({ ...VERDICTS, id })).value
  const script = scriptPath(id)
  const run: ChatVerify = { id, state: 'asked', script, expected: c.display }
  await $.state.set({ ...VERIFY, id }, run)
  await update($, pendingA, list => [...(list ?? []).filter(x => x !== id), id])
  await $.prompt.submit({ text: verifyPrompt(c, v, replyOf.get(id) ?? '', script) })
}

/** Run a citation's verification script (never main's copy of its output) and record what it printed. */
async function runVerify($: Dollar, id: string): Promise<void> {
  await paths($)
  const prev = (await $.state.get({ ...VERIFY, id })).value
  const c = known.get(id)
  const script = prev?.script ?? scriptPath(id)
  const expected = prev?.expected ?? c?.display ?? null
  let source = ''
  try {
    source = await $.fs.read(`${cwd}/${script}`)
  } catch {
    await $.state.set({ ...VERIFY, id }, { id, state: 'missing', script, expected })
    return
  }
  await $.state.set({ ...VERIFY, id }, { id, state: 'running', script, expected, source: source.slice(0, 9000) })
  try {
    const r = await $.process.run(['python3', script], { cwd, timeoutMs: 180000 })
    const result = scriptResult(r.stdout)
    const ok = r.exitCode === 0 && result !== null && (expected === null || shownMatches(expected, result) || valueIn(expected, result))
    await $.state.set({ ...VERIFY, id }, {
      id,
      script,
      expected,
      source: source.slice(0, 9000),
      stdout: r.stdout.slice(-4000),
      stderr: r.stderr.slice(-2000),
      exitCode: r.exitCode,
      result,
      ranAt: await $.clock.now(),
      state: r.exitCode !== 0 || result === null ? 'error' : ok ? 'verified' : 'refuted',
    })
  } catch (err) {
    await $.state.set({ ...VERIFY, id }, { id, state: 'error', script, expected, source: source.slice(0, 9000), stderr: String(err).slice(0, 500) })
  }
}

function verifyMark(run: ChatVerify | undefined): string {
  if (!run) return ''
  return { verified: ' ✓', refuted: ' ✗', error: ' !', asked: ' …', running: ' …', missing: ' ?' }[run.state] ?? ''
}

function verifyWords(run: ChatVerify | undefined): string {
  if (!run) return ''
  switch (run.state) {
    case 'verified':
      return `script recomputed ${run.result}`
    case 'refuted':
      return `script recomputed ${run.result}, not ${run.expected}`
    case 'error':
      return 'script failed'
    case 'asked':
      return 'script requested'
    case 'running':
      return 'script running'
    case 'missing':
      return 'no script written'
    default:
      return ''
  }
}

// ------------------------------------------------------------------------------------------------ card scripts

/** Run a card's script again (a param picked, or "rerun"): only that card is written, under its own id. */
async function rerunCard($: Dollar, id: string, change?: { name: string; value: string }): Promise<void> {
  await paths($)
  const card = await loadCard($, id)
  const script = card?.source?.script
  const prev = (await $.state.get({ ...RUNS, id })).value ?? { rev: 0 }
  if (!card || !script) {
    $.ui.toast(`card ${id} has no script to run`)
    return
  }
  if (prev.busy) return
  const values: Record<string, string | number> = {}
  for (const p of card.params ?? []) values[p.name] = p.value
  if (change) values[change.name] = change.value
  await $.state.set({ ...RUNS, id }, { ...prev, busy: change ? `running with ${change.name} = ${change.value}…` : 'running…', error: undefined })
  try {
    const r = await $.process.run(['python3', script], {
      cwd,
      env: { THIMBLE_CHAT_PARAMS: JSON.stringify(values), THIMBLE_CHAT_ONLY: `${card.source.index ?? 0}:${id}` },
      timeoutMs: 180000,
    })
    const f = await cardFile($, id)
    const error = r.exitCode !== 0 ? `the script exited with ${r.exitCode}: ${r.stderr.trim().split('\n').at(-1) ?? ''}` : f.error
    await $.state.set({ ...RUNS, id }, { rev: prev.rev + 1, error: error || undefined, stdout: r.stdout.slice(-3000), stderr: r.stderr.slice(-2000), exitCode: r.exitCode, at: await $.clock.now() })
  } catch (err) {
    await $.state.set({ ...RUNS, id }, { rev: prev.rev + 1, error: `could not run ${script}: ${String(err).slice(0, 100)}` })
  }
  // the citations of this card are checked again: the reply's numbers may no longer be on it
  const mine = [...known.values()].filter(c => c.ref.startsWith(`card:${id}`))
  if (mine.length) await check($, mine)
}

// ------------------------------------------------------------------------------------------------ side threads

async function saveThread($: Dollar, cwd: string, t: ChatThread): Promise<void> {
  try {
    await $.fs.write(`${cwd}/${t.file}`, threadFile(t))
  } catch {
    // the thread stays in the pane
  }
}

async function setThread($: Dollar, t: ChatThread): Promise<void> {
  await $.state.set({ ...THREADS, id: t.id }, t)
}

async function getThread($: Dollar, id: string): Promise<ChatThread | undefined> {
  return id ? (await $.state.get({ ...THREADS, id })).value : undefined
}

/** Open a side thread about something on the screen; the pane takes the keys, its field asks the first question. */
async function openThread($: Dollar, about: { label: string; context: string; ref?: string }): Promise<string> {
  const id = `t${(await $.clock.now()).toString(36)}`
  const t: ChatThread = { id, label: about.label, ref: about.ref ?? '', context: about.context, agentId: '', engine: '', turns: [], file: `.thimble-chat/threads/${id}.md` }
  await setThread($, t)
  const list = (await read($, threadListA)) ?? []
  await $.state.set({ plugin: 'thimble-chat', key: 'threadList' }, [...list, id].slice(-20))
  await $.state.set({ plugin: 'thimble-chat', key: 'thread' }, id)
  await openPane($, { id: THREAD_PANE, title: 'Side thread', focus: true, closeOnEscape: true })
  return id
}

/** Ask the thread's subagent a question: the first starts it, a follow-up is sent to it. */
async function askThread($: Dollar, id: string, q: string, guide: string): Promise<void> {
  const t0 = await getThread($, id)
  if (!t0 || !q.trim()) return
  if (t0.turns.at(-1)?.state === 'running') {
    $.ui.toast('the side thread is still answering')
    return
  }
  const t: ChatThread = { ...t0, turns: [...t0.turns, { q: q.trim(), a: '', state: 'running', tools: 0, partial: '' }] }
  await setThread($, t)
  // Each question starts a fresh fork that carries the exchange so far. A follow-up sent to the finished subagent
  // ($.session.send) resumes it, but its end then reaches main as a task notification, and main answers it in its
  // chat; a fork started by $.agent.spawn ends without one.
  const description = `side thread: ${clip(t.label, 40)}`
  let engine = 'fork'
  let r = await $.agent.spawn({ prompt: forkPrompt(t, q.trim()), description, subagentType: 'fork' }).catch((err: unknown) => ({ deny: String(err) }))
  if (r.deny !== undefined || !('agentId' in r) || !r.agentId) {
    engine = 'general-purpose'
    r = await $.agent
      .spawn({ prompt: freshPrompt(t, q.trim(), guide), description, subagentType: 'general-purpose' })
      .catch((err: unknown) => ({ deny: String(err) }))
  }
  if (r.deny !== undefined || !('agentId' in r) || !r.agentId) {
    await setThread($, lastTurn(t, { state: 'error', a: `could not start a subagent: ${r.deny ?? 'no id'}` }))
    return
  }
  byAgent.set(r.agentId, id)
  await setThread($, { ...t, agentId: r.agentId, engine })
}

/** A subagent's row: a thread's progress (its tool calls and latest text). Called by register.tsx's one
 *  session.append hook (an event takes one hook per matcher). */
async function threadAppend($: Dollar, agentId: string | undefined, door: string, content: unknown): Promise<void> {
  const tid = agentId ? byAgent.get(agentId) : undefined
  if (!tid || door !== 'response' || !Array.isArray(content)) return
  const blocks = content as { type?: string; text?: string }[]
  const tools = blocks.filter(b => b.type === 'tool_use').length
  const text = blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
  const t = await getThread($, tid)
  const cur = t?.turns.at(-1)
  if (t && cur?.state === 'running' && (tools || text)) {
    await setThread($, lastTurn(t, { tools: cur.tools + tools, partial: text ? clip(text, 300) : cur.partial }))
  }
}

/** A subagent's turn.complete: a thread's answer, saved to its file. Returns the answer's text, or null when the
 *  subagent was not a thread's. */
async function threadComplete($: Dollar, cwd: string, agentId: string, reason: string, answer: string): Promise<string | null> {
  const tid = byAgent.get(agentId)
  if (!tid) return null
  const t = await getThread($, tid)
  if (!t) return null
  const text = reason === 'answer' ? answer : `${answer || ''}\n(the subagent ended: ${reason})`.trim()
  const done = lastTurn(t, { a: text, state: reason === 'answer' ? 'done' : 'error' })
  await setThread($, done)
  await saveThread($, cwd, done)
  // the ring moves from the question field to "offer to main", so its hotkey (m) works; a click or Tab reaches the field
  if (reason === 'answer' && forMain(text)) void $.ui.focus({ requestId: THREAD_PANE, key: 'main' }).catch(() => undefined)
  $.ui.toast(`the side thread on ${clip(t.label, 40)} answered`)
  return text
}

// ------------------------------------------------------------------------------------------------ chips

/** How a citation in the prompt is painted: a grey chip over its characters. */
function chipDecoration(raw: string, start = 0): { start: number; end: number; backgroundColor: string; color: string } {
  return { start, end: start + raw.length, backgroundColor: '#30363d', color: '#e6edf3' }
}

async function chipView($: Dollar, c: Citation): Promise<{ view: ChipView; id: string }> {
  const id = cid(c.raw)
  const v = (await $.state.get({ ...VERDICTS, id })).value
  const run = (await $.state.get({ ...VERIFY, id })).value
  const status = v?.status ?? 'pending'
  const tip = [c.ref, v ? v.why : 'checking…', verifyWords(run), 'click: open · right-click: to the prompt'].filter(Boolean).join(' · ')
  return { id, view: { label: chipLabel(c), status: run?.state === 'refuted' ? 'missing' : status, mark: verifyMark(run), tip } }
}

// ------------------------------------------------------------------------------------------------ drawing a reply

/** A reply's text with the analyst's edits: an edited takeaway replaces the paragraph it was written as. */
async function withEdits($: Dollar, text: string): Promise<string> {
  let out = text
  for (const id of embeddedCards(text)) {
    const note = await noteOf($, id)
    if (note.takeaway && note.original && out.includes(note.original)) out = out.replace(note.original, `${note.takeaway} ✎`)
  }
  return out
}

/** A reply's blocks as thimble-chat draws them: Markdown as the engine would, cards as panels, paragraphs that hold
 *  citations as chips. Interactive (Clients) on the terminal and desktop, static elsewhere. */
async function drawReply($: Dollar, e: ResolveInput, text: string, width: number, prefix = ''): Promise<RenderElement[]> {
  const { Box, Text, Markdown } = $.ui.resolve(e)
  const live = e.surface === 'terminal' || e.surface === 'desktop'
  const cols = Math.max(30, width)
  const out: RenderElement[] = []
  const blocks = parseReply(text)
  let n = 0
  const push = (el: RenderElement) => out.push(blocks[n - 1]?.gap ? <Box marginTop={1}>{el}</Box> : el)
  for (const block of blocks) {
    n++
    if (block.type === 'md') {
      push(<Markdown text={block.text} />)
      continue
    }
    if (block.type === 'card') {
      cardReply.set(block.id, text)
      await $.state.get({ ...RUNS, id: block.id }) // a finished run redraws the card
      const f = await cardFile($, block.id)
      if (!f.data) {
        push(<Text color={COLORS.chip.missing} wrap="wrap">{`▍ ${f.error}`}</Text>)
        continue
      }
      const card = f.data
      const meta = await metaOf($, card.id)
      const w = Math.min(cols, CARD_MAX_COLS)
      if (live) {
        const { Client } = $.ui.resolve(e as ResolveInput<'AssistantMessage', 'terminal'>)
        push(<Client key={`${prefix}card-${n}-${card.id}`} module="./card.tsx" width={meta.hidden ? '100%' : w} props={{ card, cols: w, debug, meta }} />)
      } else {
        const lay = cardLayout(card, w - 4, -1)
        push(
          <Box flexDirection="column" borderStyle="round" borderColor={COLORS.rule} paddingX={1} width={w}>
            <Text bold>{cut(card.question, w - 4)}</Text>
            {paintLines(Box, Text, lay.lines)}
          </Box>,
        )
      }
      continue
    }
    const chips: ChipView[] = []
    const ids: string[] = []
    for (const r of block.runs) {
      if (!r.cite) continue
      const { view, id } = await chipView($, r.cite)
      chips.push(view)
      ids.push(id)
    }
    if (live) {
      const { Client } = $.ui.resolve(e as ResolveInput<'AssistantMessage', 'terminal'>)
      push(<Client key={`${prefix}para-${n}`} module="./para.tsx" width="100%" props={{ cols, block, chips, ids, debug }} />)
    } else {
      push(paintLines(Box, Text, blockLayout(block, chips, cols, -1).lines))
    }
  }
  return out
}

// ------------------------------------------------------------------------------------------------ panes

/** Open a pane with the keys. With a draft in the prompt the keys stay there (Claude Code keeps the person's typing),
 *  so the analyst is told to click the pane, which then takes them. */
async function openPane($: Dollar, args: Parameters<Dollar['ui']['open']>[0]): Promise<void> {
  await $.ui.open(args)
  try {
    if ((await $.prompt.read()).text.trim()) $.ui.toast('the prompt holds a draft, so it keeps the keys: click the panel to use its keys')
  } catch {
    // no prompt to read
  }
}

async function openCitation($: Dollar, c: Citation): Promise<void> {
  const id = cid(c.raw)
  remember([c])
  if (!(await $.state.get({ ...VERDICTS, id })).value) enqueue($, [c])
  await $.state.set({ plugin: 'thimble-chat', key: 'open' }, id)
  await openPane($, { id: CITE_PANE, title: 'Citation', focus: true, closeOnEscape: true, columns: 96, rows: 22 })
}

async function openCardPane($: Dollar, id: string, mode: string): Promise<void> {
  await $.state.set({ plugin: 'thimble-chat', key: 'paneCard' }, id)
  await $.state.set({ plugin: 'thimble-chat', key: 'paneMode' }, mode)
  await openPane($, { id: CARD_PANE, title: `card:${id}`, focus: true, closeOnEscape: true, columns: 100 })
}

async function openEdit($: Dollar, id: string): Promise<void> {
  const note = await noteOf($, id)
  const reply = cardReply.get(id) ?? ''
  const original = note.original ?? takeawayAfter(reply, id)
  if (!original && !note.takeaway) {
    $.ui.toast(`no takeaway follows card ${id} in its reply`)
    return
  }
  await $.state.set({ plugin: 'thimble-chat', key: 'edit' }, { card: id, text: note.takeaway ?? original, original })
  await openPane($, { id: EDIT_PANE, title: 'Edit takeaway', focus: true, closeOnEscape: true, holdToasts: true, rows: 8 })
}

async function saveTakeaway($: Dollar, id: string, original: string, text: string): Promise<void> {
  const value = text.trim()
  await $.ui.close({ id: EDIT_PANE })
  if (!value || value === original) {
    await setNote($, id, { takeaway: undefined, original: undefined, editedAt: undefined })
    return
  }
  await setNote($, id, { takeaway: value, original, editedAt: await $.clock.now() })
  const cs = citations(value)
  remember(cs, value)
  enqueue($, cs)
  // main reads the edit with its next request; the analyst sees it in place
  await $.session
    .append({ message: { type: 'user', content: [{ type: 'text', text: `thimble-chat: the analyst edited the takeaway of [[card:${id}]]. It now reads: ${value}` }] } })
    .catch((err: unknown) => $.ui.log(`thimble-chat: could not tell main about the edit: ${String(err).slice(0, 200)}`))
  $.ui.toast('takeaway saved; Claude reads the edit with your next message')
}

function lineRow(els: { Text: (p: object) => RenderElement }, w: { n: number; text: string; hit: boolean; spans?: number[][] }, gutter: number, cols: number): RenderElement {
  const { Text } = els
  const room = Math.max(10, cols - gutter - 3)
  let text = w.text.replace(/\t/g, '  ')
  let spans = w.spans ?? []
  if (text.length > room) {
    const lo = spans.length ? Math.max(0, spans[0]![0]! - Math.floor(room / 3)) : 0
    text = (lo ? '…' : '') + text.slice(lo, lo + room - 2) + '…'
    spans = spans.map(([a, b]) => [a! - lo + (lo ? 1 : 0), b! - lo + (lo ? 1 : 0)])
  }
  const parts: RenderElement[] = []
  let at = 0
  for (const [a, b] of spans.filter(([a, b]) => a! >= 0 && b! <= text.length).sort((x, y) => x[0]! - y[0]!)) {
    if (a! < at) continue
    parts.push(Text({ children: text.slice(at, a) }))
    parts.push(Text({ backgroundColor: '#9e6a03', color: '#ffffff', bold: true, children: text.slice(a, b) }))
    at = b!
  }
  parts.push(Text({ children: text.slice(at) || ' ' }))
  return Text({
    wrap: 'truncate-end',
    children: [
      Text({ color: w.hit ? COLORS.accent : COLORS.dim, children: `${String(w.n).padStart(gutter)} ${w.hit ? '▶' : '│'} ` }),
      Text({ backgroundColor: w.hit ? '#22303c' : undefined, children: parts }),
    ],
  })
}

/** What a side thread about a citation is told: the sentence, the ref and what the place shows. */
async function citationContext($: Dollar, id: string): Promise<{ label: string; context: string; ref: string }> {
  const c = known.get(id)
  const v = (await $.state.get({ ...VERDICTS, id })).value
  const sentence = c ? sentenceOf(replyOf.get(id) ?? '', c.raw) : ''
  const shows = v?.window?.filter(w => w.hit).map(w => w.text).join('\n') ?? v?.value ?? ''
  return {
    ref: c?.raw ?? '',
    label: c ? `the citation ${c.raw}` : 'a citation',
    context: [sentence && `The sentence: "${clip(sentence, 600)}"`, v && `The citation ${STATUS_WORDS[v.status] ?? v.status} (${v.why}).`, shows && `The cited place shows: ${clip(shows, 1500)}`]
      .filter(Boolean)
      .join('\n'),
  }
}

/** What a side thread about a card is told: its question, script, data in brief and the takeaway. */
async function cardContext($: Dollar, id: string): Promise<{ label: string; context: string; ref: string }> {
  const card = await loadCard($, id)
  const note = await noteOf($, id)
  const takeaway = note.takeaway ?? takeawayAfter(cardReply.get(id) ?? '', id)
  const data = card ? clip(JSON.stringify(card.rows ?? card.series ?? card.events ?? card.examples ?? []), 1500) : ''
  return {
    ref: `[[card:${id}]]`,
    label: card ? `the card "${card.question}"` : `card ${id}`,
    context: [
      card?.source?.script && `Made by ${card.source.script}${card.params?.length ? ` with ${card.params.map(p => `${p.name} = ${p.value}`).join(', ')}` : ''}.`,
      data && `Its data (${HOME}/cards/${id}.json): ${data}`,
      takeaway && `Its takeaway in the reply: ${takeaway}`,
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

// ------------------------------------------------------------------------------------------------ register

export const register: Register = on => {
  let turnText: string[] = []
  let turnRows: string[] = [] // the uuids of this turn's text rows in main
  let turnPrompt = ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await ensureGuide($)
    await loadNotes($)
    $.clock.every(150, () => void flushQueue($))
    await $.command.register({ name: 'thimble-card', description: 'Open a thimble-chat card in a pane: /thimble-card <id>' })
    await $.command.register({ name: 'thimble-cite', description: 'Open the panel of a citation of the last reply: /thimble-cite <n>', immediate: true })
    await $.command.register({ name: 'thimble-check', description: 'Check the citations of the last reply again', immediate: true })
    await $.command.register({ name: 'thimble-ask', description: 'Ask a side thread about the last reply, out of the main chat: /thimble-ask <question>', immediate: true })
    await $.command.register({ name: 'thimble-band', description: 'Show or hide the band of the last reply\'s citations above the prompt', immediate: true })
    await $.command.register({ name: 'thimble-chat', description: 'thimble-chat status: the guidance, the cards and files of this folder', immediate: true })
    // a resumed session: the band lists the last reply's citations
    try {
      const rows = await $.session.messages()
      const last: string[] = []
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i]!
        if (r.role === 'user' && r.text.trim() && !r.toolResults?.length) break
        if (r.role === 'assistant' && r.text.trim()) last.unshift(r.text)
      }
      const text = last.join('\n\n')
      const cs = citations(text)
      if (cs.length) {
        remember(cs, text)
        await $.state.set({ plugin: 'thimble-chat', key: 'turn' }, { id: 'resumed', ids: cs.map(c => cid(c.raw)) })
        enqueue($, cs)
      }
    } catch {
      // nothing to resume
    }
    return started
  })

  // The guidance rides along with the first prompt of a conversation, as context the model reads and the analyst does
  // not see. Not as a section of the system prompt (prompt.compose), since managed settings can bypass a user
  // plugin's prompt.compose hook.
  on('prompt.submit', async ($, e, next) => {
    const g = await ensureGuide($)
    if (!g) return next(e)
    let present = false
    try {
      present = (await $.session.messages()).some(r => r.role === 'user' && r.text.includes(GUIDE_MARK))
    } catch {
      present = false
    }
    if (present) return next(e)
    return next({ ...e, context: [...(e.context ?? []), g] })
  })

  // citations typed or put in the prompt are painted as chips there too
  on('prompt.edit', async ($, e, next) => {
    const r = await next(e)
    const decorations = [...r.text.matchAll(/\[\[[^\[\]]+?\]\]/g)].map(m => chipDecoration(m[0], m.index ?? 0))
    return decorations.length ? { ...r, decorations: [...(r.decorations ?? []), ...decorations] } : r
  })

  // ---------------------------------------------------------------------------------------------- Bash outputs

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.tool !== 'Bash' || ran.deny !== undefined || !ran.text || !ran.text.trim()) return ran
    await paths($)
    const short = cid(e.tool_use_id)
    try {
      await $.fs.write(`${cwd}/${HOME}/calls/${short}.json`, JSON.stringify({ id: short, tool_use_id: e.tool_use_id, command: String((e as { command?: unknown }).command ?? ''), output: ran.text }))
    } catch {
      return ran
    }
    const note = `thimble-chat: this output is call:${short}. To cite a line of it, write [[<value>|call:${short}#L<n>]], counting the output's lines from 1.`
    return { ...ran, context: [...(ran.context ?? []), note] }
  })

  // ---------------------------------------------------------------------------------------------- turns

  on('turn.start', async ($, e, next) => {
    turnText = []
    turnRows = []
    turnPrompt = e.text
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId !== undefined) await threadAppend($, e.agentId, e.door, e.message.content)
    if (e.door === 'response' && e.agentId === undefined && Array.isArray(e.message.content)) {
      let has = false
      for (const b of e.message.content as { type?: string; text?: string }[]) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          turnText.push(b.text)
          has = true
        }
      }
      if (has && 'uuid' in stored && typeof stored.uuid === 'string') turnRows.push(stored.uuid)
    }
    return stored
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) {
      await paths($)
      const answer = await threadComplete($, cwd, e.agentId, e.reason, e.answer)
      if (answer) {
        const cs = citations(answer)
        remember(cs, answer)
        enqueue($, cs)
      }
      return done
    }
    const text = turnText.length ? turnText.join('\n\n') : e.answer
    const cs = citations(text)
    remember(cs, text)
    if (cs.length) {
      await check($, cs) // again, at the turn's end: a card may have changed since the block was drawn
      await $.state.set({ plugin: 'thimble-chat', key: 'turn' }, { id: e.turnId, ids: cs.map(c => cid(c.raw)) })
    }
    // the answer as a file the analyst owns, and a summary line under its last row
    const cardsOf = embeddedCards(text)
    if (text.trim() && (cs.length || cardsOf.length) && !fromMod(turnPrompt)) {
      await paths($)
      const stamp = new Date(await $.clock.now()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
      const file = `${HOME}/answers/${stamp}.md`
      try {
        await $.fs.write(`${cwd}/${file}`, `# ${turnPrompt.split('\n')[0] ?? ''}\n\n${text}\n`)
      } catch {
        // the answer stays in the transcript
      }
      const lastRow = turnRows.at(-1)
      if (lastRow) await $.state.set({ ...ENDS, id: lastRow }, { ids: cs.map(c => cid(c.raw)), cards: cardsOf, file })
    }
    // A card that cannot be drawn or a citation that fails goes back to main, once per question: the mod asks for the
    // fix as a prompt of its own (managed settings can bypass a user plugin's classic.Stop, which could block the stop).
    if (text.trim() && !unframed(turnPrompt).startsWith(FIX_MARK)) {
      const problems = await problemsOf($, text)
      if (problems.length) {
        await $.prompt.submit({
          text: [
            `${FIX_MARK} in your last reply, which the analyst sees in red or amber:`,
            ...problems.slice(0, 12).map(p => `- ${p}`),
            'Fix each one: rerun or fix the card\'s script, or cite the value the place shows. Then give only the corrected sentences or cards.',
          ].join('\n'),
        })
      }
    }
    // verification scripts asked of main: run each one main has written
    const pending = (await read($, pendingA)) ?? []
    for (const id of pending) {
      const run = (await $.state.get({ ...VERIFY, id })).value
      if (run?.state !== 'asked') continue
      await paths($)
      if (!(await $.fs.exists(`${cwd}/${run.script}`))) continue
      await update($, pendingA, list => (list ?? []).filter(x => x !== id))
      void runVerify($, id)
    }
    return done
  })

  // ---------------------------------------------------------------------------------------------- the reply

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const end = (await $.state.get({ ...ENDS, id: e.requestId })).value
    if (!needsDrawing(e.props.text) && !end) return next(e)
    const text = await withEdits($, e.props.text)
    const cs = citations(text)
    remember(cs, text)
    const unchecked: Citation[] = []
    for (const c of cs) if (!(await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value) unchecked.push(c)
    if (unchecked.length) enqueue($, unchecked)
    const { Box, Text } = $.ui.resolve(e)
    const out = await drawReply($, e, text, (e.viewport?.columns ?? 100) - 4)
    if (end) {
      // one dim line under the answer: how its citations checked out, and where it is saved
      const counts: Record<string, number> = {}
      for (const id of end.ids) {
        const v = (await $.state.get({ ...VERDICTS, id })).value
        const r = (await $.state.get({ ...VERIFY, id })).value
        const s = r?.state === 'refuted' ? 'missing' : (v?.status ?? 'pending')
        counts[s] = (counts[s] ?? 0) + 1
      }
      const words: [string, string][] = [['ok', 'check'], ['differs', 'value not found'], ['missing', 'do not resolve'], ['unchecked', 'not checked'], ['pending', 'checking']]
      out.push(
        <Box marginTop={1}>
          <Text wrap="truncate-end">
            <Text dimColor>{`${end.ids.length} citation${end.ids.length === 1 ? '' : 's'}: `}</Text>
            {words.filter(([s]) => counts[s]).map(([s, w], i) => <Text color={statusColor(s)}>{`${i ? ' · ' : ''}${counts[s]} ${w}`}</Text>)}
            <Text dimColor>{`${end.cards.length ? ` · ${end.cards.length} card${end.cards.length === 1 ? '' : 's'}` : ''} · saved as ${end.file}`}</Text>
          </Text>
        </Box>,
      )
    }
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text>{e.props.isFirstOfReply ? '⏺' : ' '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {out}
        </Box>
      </Box>
    )
  })

  // the mod's own prompts (a fix request, a verification request) as one dim line; a click shows the whole message
  // (Claude Code 2.1.287 draws a plugin's prompt under its "Prompt from" label without raising this site, so in the
  // terminal the prompts are kept short instead: the rules they rely on are in the guidance.)
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'plugin' } } }, async ($, e, next) => {
    const o = e.props.origin as { kind: string; name?: string }
    if (o.name !== 'thimble-chat') return next(e)
    const text = unframed(e.props.text)
    const lines = text.split('\n')
    const items = lines.filter(l => l.startsWith('- '))
    const fix = text.includes(FIX_MARK)
    const script = /Write it at (\S+?),/.exec(text)?.[1]
    const head = fix
      ? `thimble-chat asked Claude to fix ${items.length} problem${items.length === 1 ? '' : 's'} in the last reply`
      : script
        ? `thimble-chat asked Claude for a verification script: ${script}`
        : `thimble-chat: ${clip((lines[0] ?? '').replace(/^thimble-chat:\s*/, ''), 120)}`
    const live = e.surface === 'terminal' || e.surface === 'desktop'
    if (!live && e.props.isExpanded) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const shown = fix ? items.slice(0, 6) : []
    if (live) {
      const { Client } = $.ui.resolve(e as ResolveInput<'UserMessage', 'terminal'>)
      return <Client key="fold" module="./fold.tsx" width="100%" props={{ head, items: shown, body: text, cols: Math.max(30, (e.viewport?.columns ?? 100) - 4) }} />
    }
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">{`› ${head} · ctrl+o shows the message`}</Text>
        {shown.map(l => <Text color={COLORS.chip.differs} wrap="truncate-end">{`  ${l}`}</Text>)}
      </Box>
    )
  })

  // ---------------------------------------------------------------------------------------------- clicks

  on('ui.message', async ($, e, next) => {
    const d = (e.data ?? {}) as { type?: string; id?: string; cite?: string; open?: string; secondary?: boolean; kind?: string; card?: string; act?: string; name?: string; value?: string; ev?: unknown }
    if (debug && (d.ev || d.type === 'act' || d.type === 'param')) {
      await paths($)
      pointerLog.push(JSON.stringify({ at: await $.clock.now(), component: e.component, module: e.module, ...d }))
      await $.fs.write(`${cwd}/${HOME}/pointer.log`, `${pointerLog.slice(-200).join('\n')}\n`)
    }
    if (d.type === 'pointer') return next(e)
    if (d.type === 'hover') {
      await $.state.set({ plugin: 'thimble-chat', key: 'hover' }, typeof d.id === 'string' ? d.id : '')
      return next(e)
    }
    if ((d.type === 'open' || d.type === 'cite') && typeof d.id === 'string') {
      const c = known.get(d.id)
      if (!c) return next(e)
      if (d.type === 'open') await openCitation($, c)
      else {
        await $.prompt.fill({ text: `${c.raw} `, mode: 'insert', decorations: [chipDecoration(c.raw)] })
        $.ui.toast(`${clip(c.raw, 60)} is in the prompt`)
      }
      return next(e)
    }
    if (d.type === 'card' && typeof d.cite === 'string') {
      const opens = d.kind === 'example' || d.kind === 'timeline'
      const wantsOpen = opens !== Boolean(d.secondary)
      const ref = typeof d.open === 'string' ? d.open : ''
      if (wantsOpen && ref) {
        const m = /^\[\[(?:([^|\]]*)\|)?([^\]]+)\]\]$/.exec(d.cite)
        await openCitation($, m && m[2] === ref ? { raw: d.cite, ref, display: m[1] ?? null } : { raw: `[[${ref}]]`, ref, display: null })
      } else if (d.cite.startsWith('[[')) {
        await $.prompt.fill({ text: `${d.cite} `, mode: 'insert', decorations: [chipDecoration(d.cite)] })
        await $.state.set({ plugin: 'thimble-chat', key: 'picked' }, d.cite)
        $.ui.toast(`${clip(d.cite, 60)} is in the prompt`)
      }
      return next(e)
    }
    if (d.type === 'param' && typeof d.card === 'string' && typeof d.name === 'string' && typeof d.value === 'string') {
      void rerunCard($, d.card, { name: d.name, value: d.value })
      return next(e)
    }
    if (d.type === 'act' && typeof d.card === 'string') {
      const id = d.card
      switch (d.act) {
        case 'script':
          await openCardPane($, id, 'script')
          break
        case 'rerun':
          void rerunCard($, id)
          break
        case 'star': {
          const note = await setNote($, id, { starred: !(await noteOf($, id)).starred })
          $.ui.toast(`card ${id} ${note.starred ? 'starred' : 'unstarred'}`)
          break
        }
        case 'hide':
          await setNote($, id, { hidden: true })
          break
        case 'show':
          await setNote($, id, { hidden: false })
          break
        case 'edit':
          await openEdit($, id)
          break
        case 'ask': {
          const about = await cardContext($, id)
          await $.ui.close({ id: CITE_PANE })
          await openThread($, about)
          break
        }
      }
      return next(e)
    }
    return next(e)
  })

  // ---------------------------------------------------------------------------------------------- citation panel

  on('ui.render', { component: 'Pane', requestId: CITE_PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const id = await read($, openA)
    const v = id ? (await $.state.get({ ...VERDICTS, id })).value : undefined
    // after a reload the module's map is empty; the verdict in state still holds the citation
    const c = id ? (known.get(id) ?? (v ? { raw: v.raw, ref: v.ref, display: v.display } : undefined)) : undefined
    const cols = Math.max(30, e.props.bodyColumns)
    if (!c) return <Text dimColor>No citation open. Click a chip in a reply.</Text>
    const run = (await $.state.get({ ...VERIFY, id })).value
    const status = v?.status ?? 'pending'
    const body: RenderElement[] = []
    body.push(
      <Text wrap="truncate-end">
        <Text backgroundColor={statusColor(status)} color={COLORS.chipFg} bold>{` ${chipLabel(c)}${verifyMark(run)} `}</Text>
        <Text>{`  ${STATUS_WORDS[status] ?? status}`}</Text>
      </Text>,
    )
    body.push(<Text dimColor wrap="truncate-end">{clip(c.raw, cols)}</Text>)
    if (v?.why) body.push(<Text color={status === 'ok' ? COLORS.chip.ok : status === 'pending' ? COLORS.dim : COLORS.accent} wrap="truncate-end">{clip(v.why, cols)}</Text>)
    if (!v) body.push(<Text dimColor>checking…</Text>)
    else if (v.kind === 'value' || v.kind === 'card') {
      const card = v.card ? await loadCard($, v.card) : null
      if (card) {
        body.push(<Text bold wrap="truncate-end">{`card: ${card.question}`}</Text>)
        const lay = cardLayout(card, Math.min(cols - 2, 90), -1, 8)
        // the cited row, marked: bar rows and table rows are one line each
        const rows = lay.lines.map((l, i) => {
          const item = lay.items[card.kind === 'table' ? (i - 2) * (card.columns?.length ?? 1) : i]
          const isHit = v.kind === 'value' && item !== undefined && item.open === c.ref
          return isHit ? l.map(s => ({ ...s, bg: '#22303c' })) : l
        })
        body.push(paintLines(Box, Text, rows))
        body.push(<Text dimColor wrap="truncate-end">{card.source?.script ? `made by ${card.source.script}` : 'no script recorded'}</Text>)
      }
    } else if (v.window.length) {
      const head = v.kind === 'call' ? `output of call:${v.call} · $ ${clip(v.command ?? '', cols - 30)}` : `${v.file}${v.start ? ` · line ${v.start}${v.end && v.end !== v.start ? `-${v.end}` : ''}` : ''}`
      body.push(<Text bold wrap="truncate-end">{head}</Text>)
      const gutter = Math.max(...v.window.map(w => String(w.n).length))
      body.push(<Box flexDirection="column">{v.window.map(w => lineRow({ Text } as never, w, gutter, cols))}</Box>)
    }

    // verification, and a side thread about this citation
    const canVerify = c.display !== null
    // the thread pane replaces this one, so it shows and takes the keys (a second pane would open behind as a tab)
    const ask = (
      <Button
        key="ask"
        label="ask about this"
        hotkey="a"
        onPress={async () => {
          const about = await citationContext($, id)
          await $.ui.close({ id: CITE_PANE })
          await openThread($, about)
        }}
      />
    )
    const close = <Button key="close" label="close" hotkey="x" role="dismiss" onPress={() => void $.ui.close({ id: CITE_PANE })} />
    body.push(<Text dimColor>{'─'.repeat(Math.min(cols, 80))}</Text>)
    if (!run) {
      body.push(
        canVerify ? (
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={2}>
              <Button key="verify" label="write a verification script" hotkey="w" variant="primary" onPress={() => void askVerify($, id)} />
              {ask}
              {close}
            </Box>
            <Text dimColor wrap="wrap">A verification script: Claude writes a standalone script that recomputes this value from the raw files, without the answer's code; thimble-chat runs it and shows the result here. Ask about this: a side thread, out of the main chat.</Text>
          </Box>
        ) : (
          <Box flexDirection="row" columnGap={2}>
            <Text dimColor>This citation shows no value to recompute.</Text>
            {ask}
            {close}
          </Box>
        ),
      )
    } else {
      const color = run.state === 'verified' ? COLORS.chip.ok : run.state === 'refuted' || run.state === 'error' ? COLORS.chip.missing : COLORS.dim
      const words: Record<string, string> = {
        asked: `Claude is writing ${run.script} …`,
        running: `running ${run.script} …`,
        missing: `${run.script} was not written`,
        verified: `✓ the script recomputed ${run.result}, as cited`,
        refuted: `✗ the script recomputed ${run.result}, the reply cites ${run.expected}`,
        error: `! the script ${run.exitCode ? `exited with ${run.exitCode}` : 'printed no RESULT line'}`,
      }
      body.push(<Text color={color} bold wrap="truncate-end">{words[run.state] ?? run.state}</Text>)
      if (run.source) {
        body.push(<Text dimColor wrap="truncate-end">{run.script}</Text>)
        body.push(<Code source={run.source.slice(0, 6000)} language="python" startLine={1} wrap="truncate-end" />)
      }
      if (run.stdout || run.stderr) {
        body.push(<Text dimColor>output</Text>)
        const tail = `${run.stdout ?? ''}${run.stderr ? `\n${run.stderr}` : ''}`.trim().split('\n').slice(-12)
        body.push(<Box flexDirection="column">{tail.map(l => <Text wrap="truncate-end">{l || ' '}</Text>)}</Box>)
      }
      body.push(
        <Box flexDirection="row" columnGap={2}>
          {run.state !== 'asked' && run.state !== 'running' ? <Button key="rerun" label="run it again" hotkey="r" onPress={() => void runVerify($, id)} /> : null}
          {run.state === 'missing' || run.state === 'error' ? <Button key="again" label="ask again" hotkey="w" onPress={() => void askVerify($, id)} /> : null}
          {ask}
          {close}
        </Box>,
      )
    }
    return <Box flexDirection="column">{body}</Box>
  })

  // ---------------------------------------------------------------------------------------------- edit pane

  on('ui.render', { component: 'Pane', requestId: EDIT_PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>Editing needs a surface with text fields.</Text>
    }
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const ed = await read($, editA)
    if (!ed) return <Text dimColor>Nothing to edit.</Text>
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>{`takeaway of card:${ed.card}`}</Text>
          <Text dimColor> · Enter saves · Esc cancels · citations stay as [[value|ref]] and are checked again</Text>
        </Text>
        <Input key="takeaway" value={ed.text} autoFocus submitLabel="save" onSubmit={v => void saveTakeaway($, ed.card, ed.original, v)} />
        <Box flexDirection="row" columnGap={2}>
          <Button key="restore" label="restore the reply's text" onPress={() => void saveTakeaway($, ed.card, ed.original, ed.original)} />
          <Button key="cancel" label="cancel" role="dismiss" onPress={() => void $.ui.close({ id: EDIT_PANE })} />
        </Box>
      </Box>
    )
  })

  // ---------------------------------------------------------------------------------------------- side thread pane

  on('ui.render', { component: 'Pane', requestId: THREAD_PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>Side threads need a surface with text fields.</Text>
    }
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const t = await getThread($, await read($, threadA))
    const cols = Math.max(30, e.props.bodyColumns - 1)
    if (!t) return <Text dimColor>No side thread. Click "? ask" on a card, or "ask about this" on a citation.</Text>
    const g = await ensureGuide($)
    const body: RenderElement[] = []
    body.push(
      <Text wrap="truncate-end">
        <Text dimColor>side thread about </Text>
        <Text bold>{clip(t.label, cols - 20)}</Text>
      </Text>,
    )
    if (t.context) body.push(<Text dimColor wrap="truncate-end">{clip(t.context.split('\n')[0] ?? '', cols)}</Text>)
    body.push(<Text dimColor>{'─'.repeat(Math.min(cols, 80))}</Text>)
    let k = 0
    for (const turn of t.turns) {
      k++
      body.push(<Text color={COLORS.accent} bold wrap="wrap">{`› ${turn.q}`}</Text>)
      if (turn.state === 'running') {
        body.push(<Text dimColor wrap="truncate-end">{`working · ${turn.tools} tool call${turn.tools === 1 ? '' : 's'}${turn.partial ? ` · ${clip(turn.partial, cols - 30)}` : ''}`}</Text>)
      } else if (turn.state === 'error') {
        body.push(<Text color={COLORS.chip.missing} wrap="wrap">{turn.a}</Text>)
      } else {
        body.push(<Box flexDirection="column">{await drawReply($, e, threadBody(turn.a), cols, `t${k}-`)}</Box>)
      }
      body.push(<Text> </Text>)
    }
    const last = t.turns.at(-1)
    const answered = t.turns.filter(x => x.state === 'done')
    const line = answered.length ? forMain(answered.at(-1)!.a) : ''
    if (line) body.push(<Text dimColor wrap="truncate-end">{`for main: ${clip(line, cols - 10)}`}</Text>)
    body.push(
      <Input
        key="ask"
        {...(t.turns.length === 0 ? { autoFocus: true as const } : {})}
        label="ask"
        placeholder={t.turns.length ? 'a follow-up (Enter sends it to this thread)' : `ask about ${clip(t.label, 40)} (Enter)`}
        submitLabel="ask"
        onSubmit={v => void askThread($, t.id, v, g)}
      />,
    )
    body.push(
      <Box flexDirection="row" columnGap={2}>
        {line ? (
          <Button
            key="main"
            label="offer to main"
            hotkey="m"
            variant="primary"
            onPress={() => {
              const lead = 'Side thread on '
              const about = t.ref || clip(t.label, 60)
              void $.prompt
                .fill({ text: `${lead}${about}: ${line} `, mode: 'insert', decorations: t.ref ? [chipDecoration(t.ref, lead.length)] : [] })
                .then(() => $.ui.toast("the side thread's line is in the prompt"))
            }}
          />
        ) : null}
        <Button key="close" label="close" hotkey="x" role="dismiss" onPress={() => void $.ui.close({ id: THREAD_PANE })} />
        <Text dimColor>{last?.state === 'running' ? 'answering…' : t.engine ? `${t.engine} subagent · ${t.file}` : ''}</Text>
      </Box>,
    )
    return <Box flexDirection="column">{body}</Box>
  })

  // ---------------------------------------------------------------------------------------------- band (opt-in)

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view.agentId || !(await read($, bandA))) return next(e)
    const turn = await read($, turnA)
    if (!turn || turn.ids.length === 0 || (await read($, hiddenA)) === turn.id) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const views: { id: string; c: Citation; status: string; mark: string }[] = []
    for (const id of turn.ids) {
      const c = known.get(id)
      if (!c) continue
      const v = (await $.state.get({ ...VERDICTS, id })).value
      const run = (await $.state.get({ ...VERIFY, id })).value
      views.push({ id, c, status: run?.state === 'refuted' ? 'missing' : (v?.status ?? 'pending'), mark: verifyMark(run) })
    }
    const counts = ['ok', 'differs', 'missing'].map(s => [s, views.filter(x => x.status === s).length] as const).filter(([, k]) => k > 0)
    const words: Record<string, string> = { ok: 'resolve', differs: 'value not found', missing: 'do not resolve' }
    const hoverId = await read($, hoverA)
    const hc = hoverId ? known.get(hoverId) : undefined
    const hv = hoverId ? (await $.state.get({ ...VERDICTS, id: hoverId })).value : undefined
    const hr = hoverId ? (await $.state.get({ ...VERIFY, id: hoverId })).value : undefined
    const readout = hc ? (
      <Text wrap="truncate-end">
        <Text backgroundColor={statusColor(hr?.state === 'refuted' ? 'missing' : (hv?.status ?? 'pending'))} color={COLORS.chipFg} bold>{` ${chipLabel(hc)}${verifyMark(hr)} `}</Text>
        <Text>{` ${hc.ref}`}</Text>
        <Text dimColor>{`  ${[hv?.why ?? 'checking…', verifyWords(hr)].filter(Boolean).join(' · ')} · click: open · right-click: put in the prompt`}</Text>
      </Text>
    ) : (
      // the row stays when nothing is hovered, so the band keeps its height and the transcript does not move under the pointer
      <Text dimColor wrap="truncate-end">hover a chip to read its ref · click opens it · right-click puts it in the prompt · a digit in the empty prompt opens that citation</Text>
    )
    return (
      <Box flexDirection="column">
        {readout}
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          <Text bold>thimble-chat</Text>
          {counts.map(([s, k]) => (
            <Text color={statusColor(s)}>{`● ${k} ${words[s]}`}</Text>
          ))}
          <Text dimColor>· open:</Text>
          {views.slice(0, 9).map((x, i) => (
            <Box flexDirection="row">
              <Text color={statusColor(x.status)}>●</Text>
              <Button key={`c${i}`} label={`${cut(chipLabel(x.c), 14)}${x.mark}`} hotkey={String(i + 1)} plain onPress={() => void openCitation($, x.c)} />
            </Box>
          ))}
          <Button key="hide" label="hide" plain dimColor onPress={() => update($, hiddenA, () => turn.id)} />
        </Box>
      </Box>
    )
  })

  // ---------------------------------------------------------------------------------------------- commands

  on('command.run', { command: 'thimble-cite' }, async ($, e) => {
    const turn = await read($, turnA)
    const n = Number.parseInt(e.args.trim() || '1', 10)
    const id = turn?.ids[n - 1]
    const c = id ? known.get(id) : undefined
    if (!c) return { text: `the last reply has ${turn?.ids.length ?? 0} citations` }
    await openCitation($, c)
    return { text: `opened ${c.raw}` }
  })

  on('command.run', { command: 'thimble-band' }, async $ => {
    const on_ = !(await read($, bandA))
    await $.state.set({ plugin: 'thimble-chat', key: 'band' }, on_)
    await $.state.set({ plugin: 'thimble-chat', key: 'hidden' }, '')
    return { text: `the citation band is ${on_ ? 'on (digits 1-9 in the empty prompt open a citation)' : 'off'}` }
  })

  on('command.run', { command: 'thimble-ask' }, async ($, e) => {
    const q = e.args.trim()
    const turn = await read($, turnA)
    const firstId = turn?.ids[0]
    const reply = firstId ? (replyOf.get(firstId) ?? '') : ''
    const id = await openThread($, { label: 'the last answer', context: reply ? `The last answer in the main conversation:\n${clip(reply, 3000)}` : '' })
    if (q) void askThread($, id, q, await ensureGuide($))
    return { text: `side thread opened${q ? `: ${q}` : ''}` }
  })

  on('command.run', { command: 'thimble-chat' }, async $ => {
    await paths($)
    const g = await ensureGuide($)
    const present = (await $.session.messages()).some(r => r.role === 'user' && r.text.includes(GUIDE_MARK))
    const count = async (dir: string) => {
      try {
        return (await $.fs.list(`${cwd}/${HOME}/${dir}`)).length
      } catch {
        return 0
      }
    }
    return {
      text: [
        `plugin folder: ${root}`,
        `guidance: ${g ? `${g.length} characters, ${present ? 'in this conversation' : 'goes with the next prompt'}` : 'not loaded'}`,
        `in ${cwd}/${HOME}: ${await count('cards')} cards, ${await count('answers')} answers, ${await count('threads')} side threads, ${await count('verify')} verification scripts`,
      ].join('\n'),
    }
  })

  on('command.run', { command: 'thimble-check' }, async $ => {
    const turn = await read($, turnA)
    const cs = (turn?.ids ?? []).map(id => known.get(id)).filter((c): c is Citation => Boolean(c))
    await check($, cs)
    const vs = await Promise.all(cs.map(async c => (await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value))
    const ok = vs.filter(v => v?.status === 'ok').length
    return { text: `${ok} of ${cs.length} citations resolve with their value` }
  })

  on('command.run', { command: 'thimble-card' }, async ($, e) => {
    const id = e.args.trim().replace(/^\[\[|\]\]$/g, '').replace(/^card:/, '')
    if (!id) return { text: 'usage: /thimble-card <id>' }
    const card = await loadCard($, id)
    if (!card) return { text: `no card ${id} in ${HOME}/cards` }
    await openCardPane($, id, '')
    return { text: `card:${id} is open in a pane. Hover to read a value, click to cite it.` }
  })

  // the card pane: the card at the pane's width, and in script mode its script and last run
  on('ui.render', { component: 'Pane', requestId: CARD_PANE }, async ($, e) => {
    const id = await read($, paneCardA)
    const mode = await read($, paneModeA)
    const card = id ? await loadCard($, id) : null
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>The interactive card needs the terminal or the desktop app.</Text>
    }
    const { Box, Text, Client, Code, Button } = $.ui.resolve(e)
    if (!card) return <Text dimColor>No card open. /thimble-card &lt;id&gt;</Text>
    const w = Math.max(30, e.props.bodyColumns - 1)
    const picked = await read($, pickedA)
    const meta = await metaOf($, card.id)
    const run: ChatRun | undefined = (await $.state.get({ ...RUNS, id: card.id })).value
    const cardEl = <Client key={`pane-${id}`} module="./card.tsx" width={w} props={{ card, cols: w, plotRows: 16, debug, meta, pane: true }} />
    const body: RenderElement[] = mode === 'script' && card.source?.script ? [] : [cardEl]
    if (mode === 'script' && card.source?.script) {
      // the script first, with its buttons on top, so they show however tall the card is; the card below
      await paths($)
      let source = ''
      try {
        source = await $.fs.read(`${cwd}/${card.source.script}`)
      } catch {
        source = `(cannot read ${card.source.script})`
      }
      body.push(
        <Box flexDirection="row" columnGap={2}>
          <Button key="rerun" label={meta.busy ? 'running…' : 'run it again'} hotkey="r" variant="primary" onPress={() => void rerunCard($, card.id)} />
          <Button key="close" label="close" hotkey="x" role="dismiss" onPress={() => void $.ui.close({ id: CARD_PANE })} />
          <Text dimColor>{run?.exitCode !== undefined ? `last run: exit ${run.exitCode}` : ''}</Text>
        </Box>,
      )
      body.push(<Text wrap="truncate-end"><Text bold>{card.source.script}</Text><Text dimColor>{`  edit it in your editor, then run it again here${card.source.sha1 ? ` · sha1 ${card.source.sha1} when the card was made` : ''}`}</Text></Text>)
      body.push(<Code source={source.slice(0, 9000)} language="python" startLine={1} wrap="truncate-end" />)
      if (run?.exitCode !== undefined) {
        body.push(<Text dimColor>{`output of the last run (exit ${run.exitCode})`}</Text>)
        const tail = `${run.stdout ?? ''}${run.stderr ? `\n${run.stderr}` : ''}`.trim().split('\n').slice(-8)
        body.push(<Box flexDirection="column">{tail.map(l => <Text wrap="truncate-end">{l || ' '}</Text>)}</Box>)
      }
      body.push(cardEl)
    } else {
      body.push(<Text dimColor wrap="truncate-end">{picked ? `last cited: ${picked}` : 'Esc returns the keys to the prompt'}</Text>)
    }
    return <Box flexDirection="column">{body}</Box>
  })
}

