// thimble-cc-mod: a single-agent thimble inside Claude Code. No server, no browser.
//
// - Prompting: prompt/chat.md rides with the first prompt of a conversation as context (managed settings on this
//   machine bypass a user plugin's prompt.compose). It tells main to answer card shaped or report shaped, numbers from
//   code, every number cited.
// - Cards: main's Python writes a card with helper/tcard.py (.thimble-cc-mod/cards/<id>.json); a reply line holding only
//   [[card:<id>]] is drawn as the card's panel there, between the reply's text, by the Client card.tsx. A card is one
//   of six typed specs; one that does not validate is drawn as an error, and a fix round corrects it. The helper
//   writes cards to the session's folder (THIMBLE_CC_MOD_ROOT, set at session.start), wherever the script runs.
// - Citations: every [[...]] of a reply is drawn as a link (para.tsx, cite.ts), red when helper/resolve.py finds the
//   ref missing or without its value. The citation panel shows the cited lines, highlighted.
// - Fix rounds: when a reply has red citations or a card that cannot be drawn, a forked subagent corrects them, out of
//   main's chat; each corrected sentence replaces the old one in place, unmarked, and main is told in a note it reads
//   but the analyst does not see. A red citation shows a spinner while the fork works, and ✗ when the fix failed.
// - Verification scripts: a forked subagent writes a standalone script that recomputes a cited value; the mod runs it
//   and marks the citation ✓, or ✗ and red. A spinner shows meanwhile. The panel shows the script and its output.
// - Gestures (gestures.tsx): every target (card, mark, sentence, citation, row, record, node) takes the same clicks;
//   a right-click opens the menu of every action.
// - Side threads (threads.tsx): a subagent answers out of main's chat; its result is offered back as one line. Every
//   row a subagent of the mod causes in main's chat is drawn as one dim line.
// - Bash results: each output is saved (.thimble-cc-mod/calls/<id>.json) and main is told its ref, so it can cite a line.
// - While a reply streams, the engine is handed its text with each citation as a Markdown link and each card's embed
//   line as a placeholder (turn.step), so no raw [[...]] shows; the row is stored as the model wrote it (session.append).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, ResolveInput } from 'claude-code'

import type { ChatAgent, ChatCorrection, ChatEnd, ChatFixItem, ChatRow, ChatRun, ChatThread, ChatVerdict, ChatVerify } from '../types'
import { answerFile, applyCorrections, blockClaims, blockLayout, capLine, chipLook, chipSegs, chipState, citeLabel, claimsIn, fixItems, fixPrompt, fixedCard, paraLayout, parseFix, plainCites, quoteSpan, quotedWords, settleFix, streamLink, streamStep, streaming, verifyFailed, wrapAround } from './cite'
import type { ChipView, Claim, Problem, StreamLook, Streaming } from './cite'
import { cardLayout, cut } from './draw'
import type { CardData, CardMeta, Line } from './draw'
import { chipLabel, cid, citations, clip, embeddedCards, forMain, fromMod, inlineRuns, needsDrawing, parseReply, scriptResult, shownMatches, takeawayAfter, threadBody, validateCard, valueIn } from './lib'
import type { Citation } from './lib'
import { COLORS, paintLine, paintLines } from './paint'
import { cardOf, citationOf, citeText, menuItems, placeOf, targetLabel } from './gestures'
import type { Act, Gesture, PointerEv, Sent, Target } from './gestures'
import { MOD_AGENT, fixName, forkPrompt, freshPrompt, lastTurn, threadFile, threadName, verifyName, withGuide } from './threads'

type Dollar = EngineInterface

const VERDICTS = { plugin: 'thimble-cc-mod', key: 'verdicts' } as const
const VERIFY = { plugin: 'thimble-cc-mod', key: 'verify' } as const
const RUNS = { plugin: 'thimble-cc-mod', key: 'runs' } as const
const THREADS = { plugin: 'thimble-cc-mod', key: 'threads' } as const
const ENDS = { plugin: 'thimble-cc-mod', key: 'ends' } as const
const FIXES = { plugin: 'thimble-cc-mod', key: 'fixes' } as const
const AGENTS = { plugin: 'thimble-cc-mod', key: 'agents' } as const
const CORRECTIONS = { plugin: 'thimble-cc-mod', key: 'corrections' } as const
const openA = atom({ plugin: 'thimble-cc-mod', key: 'open' } as const, '')
const turnA = atom({ plugin: 'thimble-cc-mod', key: 'turn' } as const, null)
const hiddenA = atom({ plugin: 'thimble-cc-mod', key: 'hidden' } as const, '')
const correctionsA = atom(CORRECTIONS, [])
const paneCardA = atom({ plugin: 'thimble-cc-mod', key: 'paneCard' } as const, '')
const paneModeA = atom({ plugin: 'thimble-cc-mod', key: 'paneMode' } as const, '')
const pickedA = atom({ plugin: 'thimble-cc-mod', key: 'picked' } as const, '')
const hoverA = atom({ plugin: 'thimble-cc-mod', key: 'hover' } as const, '')
const bandA = atom({ plugin: 'thimble-cc-mod', key: 'band' } as const, false)
const threadA = atom({ plugin: 'thimble-cc-mod', key: 'thread' } as const, '')
const threadListA = atom({ plugin: 'thimble-cc-mod', key: 'threadList' } as const, [])
const menuA = atom({ plugin: 'thimble-cc-mod', key: 'menu' } as const, null)

const CITE_PANE = 'thimble-cite'
const CARD_PANE = 'thimble-card'
const THREAD_PANE = 'thimble-thread'
const MENU_PANE = 'thimble-menu'
const HOME = '.thimble-cc-mod'
const CARD_MAX_COLS = 120
const GUIDE_MARK = '# thimble-cc-mod\n'
const STATUS_WORDS: Record<string, string> = {
  ok: 'the value is at the place',
  differs: 'the place resolves, but the value is not there',
  missing: 'the place does not resolve',
  unchecked: 'the place resolves; the value is not checked',
  pending: 'not checked yet',
}

/** What the citation panel's head says of a citation: what its place shows, then what its verification found, so it
 *  agrees with the link's colour and mark. A citation without a value only resolves or not. */
function statusWords(c: Citation, status: string, run: ChatVerify | undefined): string {
  const place = status === 'ok' && c.display === null ? 'the place resolves' : (STATUS_WORDS[status] ?? status)
  if (!run) return place
  if (run.state === 'verified') return `${place}, and the verification recomputed it`
  if (run.state === 'refuted') return `${place}, but the verification recomputed ${run.result}`
  if (run.state === 'asked' || run.state === 'running') return `${place}; verifying…`
  return `${place}, but the verification failed`
}

// ------------------------------------------------------------------------------------------------ module state

let guide = ''
let debug = false
let root = ''
let cwd = ''
const known = new Map<string, Citation>() // every citation seen, by id
const claimMap = new Map<string, Claim>() // every claim drawn or checked, by its key
const quotes = new Map<string, string>() // a record's citation id -> the quoted passage of the example opened
let lastReply = '' // main's last reply, for /thimble-ask
const cardReply = new Map<string, string>() // a card's id -> the reply text that embeds it
const cards = new Map<string, { mtime: number; data: CardData | null; error: string; why: string }>()
const mouseLog: string[] = []
const seen = new Map<string, number>() // a gestures module instance -> the last gesture it sent that was handled
let lastCards: string[] = [] // the cards of main's last reply that embeds any, in order

async function paths($: Dollar): Promise<void> {
  if (!root) root = $.plugin.root
  if (!cwd) cwd = await $.session.cwd()
}

/** The guidance for main (prompt/chat.md), read once; the system prompt can be composed before session.start ends. */
async function ensureGuide($: Dollar): Promise<string> {
  if (guide) return guide
  await paths($)
  try {
    guide = (await $.fs.read(`${root}/prompt/chat.md`)).replaceAll('{{helper}}', `${root}/helper`)
  } catch {
    guide = ''
  }
  return guide
}

type CardFile = { data: CardData | null; error: string; why: string }

/** A card file, read again when it changed. `error` says why it cannot be drawn (missing, not JSON, off its spec) for
 *  main, with the card's id; `why` says it for the analyst, without the id. */
async function cardFile($: Dollar, id: string): Promise<CardFile> {
  await paths($)
  const file = `${cwd}/${HOME}/cards/${id}.json`
  let mtime = 0
  try {
    const st = await $.fs.stat(file)
    mtime = Number((st as { mtimeMs?: number }).mtimeMs ?? 0)
  } catch {
    return { data: null, error: `no card ${id} (${HOME}/cards/${id}.json)`, why: 'its card file was not written' }
  }
  const hit = cards.get(id)
  if (hit && hit.mtime === mtime) return hit
  let got: CardFile & { mtime: number }
  try {
    const raw = JSON.parse(await $.fs.read(file)) as unknown
    const why = validateCard(raw, id)
    got = why ? { mtime, data: null, error: `card ${id} does not validate: ${why}`, why } : { mtime, data: raw as CardData, error: '', why: '' }
  } catch {
    got = { mtime, data: null, error: `card ${id}: the file is not JSON`, why: 'its card file is not JSON' }
  }
  cards.set(id, got)
  return got
}

async function loadCard($: Dollar, id: string): Promise<CardData | null> {
  return (await cardFile($, id)).data
}

// ------------------------------------------------------------------------------------------------ card runs

async function metaOf($: Dollar, id: string): Promise<CardMeta> {
  const run = (await $.state.get({ ...RUNS, id })).value
  // a Client's props are plain data: no undefined values
  const meta: CardMeta = {}
  if (run?.busy) meta.busy = run.busy
  if (run?.error) meta.error = run.error
  return meta
}

// ------------------------------------------------------------------------------------------------ checking citations

const queue = new Map<string, Citation>()
let flushing = false

function remember(cs: Citation[]): void {
  for (const c of cs) known.set(cid(c.raw), c)
}

function rememberClaims(cls: Claim[]): void {
  for (const cl of cls) claimMap.set(cl.key, cl)
  remember(cls.map(cl => cl.c))
}

/** The citation a panel or a verification is keyed by: a claim's, or a citation's own (a mark's, a record's). */
function citeOf(key: string): Citation | undefined {
  return claimMap.get(key)?.c ?? known.get(key)
}

const CARD_OF = /^card:([A-Za-z0-9_-]+)/

/** The param values a card shows, as JSON, to compare with the ones its replies were written for. */
function paramsKey(card: CardData | null | undefined): string {
  return JSON.stringify(Object.fromEntries((card?.params ?? []).map(p => [p.name, String(p.value)])))
}

/** While the analyst's pick shows another choice of a card than its replies were written for: which, in words. */
async function otherChoice($: Dollar, ref: string): Promise<string> {
  const id = CARD_OF.exec(ref)?.[1]
  const run = id ? (await $.state.get({ ...RUNS, id })).value : undefined
  if (!id || !run?.written) return ''
  const now = (await loadCard($, id))?.params ?? []
  let was: Record<string, string> = {}
  try {
    was = JSON.parse(run.written) as Record<string, string>
  } catch {
    return ''
  }
  const diff = now.filter(p => p.name in was && String(p.value) !== was[p.name])
  if (!diff.length) return ''
  return `written for ${diff.map(p => `${p.name} = ${was[p.name]}`).join(', ')}; the card now shows ${diff.map(p => `${p.name} = ${p.value}`).join(', ')}`
}

/** Check citations with helper/resolve.py, one process for the batch, and keep each verdict in state. A citation of a
 *  card that shows another choice than its reply was written for keeps its verdict, unless `force` (a reply written
 *  now is checked against what the card shows now). */
async function check($: Dollar, all: Citation[], force = false): Promise<void> {
  const cs: Citation[] = []
  for (const c of all) if (force || !c.ref.startsWith('card:') || !(await otherChoice($, c.ref))) cs.push(c)
  if (cs.length === 0) return
  await paths($)
  const items = cs.map(c => ({ id: cid(c.raw), ref: c.ref, display: c.display, quote: quotes.get(cid(c.raw)) }))
  try {
    const r = await $.process.run(['python3', `${root}/helper/resolve.py`], {
      cwd,
      stdin: JSON.stringify({ cwd, items, around: 6 }),
      timeoutMs: 20000,
    })
    if (r.exitCode !== 0) {
      $.ui.log(`thimble-cc-mod: the resolver failed: ${r.stderr.trim().split('\n').at(-1) ?? ''}`)
      return
    }
    const out = JSON.parse(r.stdout) as (Omit<ChatVerdict, 'raw' | 'display' | 'id'> & { id: string })[]
    for (const v of out) {
      const c = known.get(v.id) ?? cs.find(x => cid(x.raw) === v.id)
      if (!c) continue
      const window = (v.window ?? []).map(w => capLine(w))
      await $.state.set({ ...VERDICTS, id: v.id }, { ...v, window, id: v.id, raw: c.raw, ref: c.ref, display: c.display })
    }
  } catch (err) {
    $.ui.log(`thimble-cc-mod: could not check citations: ${String(err).slice(0, 120)}`)
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

/** What is wrong with a reply, for a fix round: cards it embeds that cannot be drawn, citations that fail. */
async function problemsOf($: Dollar, text: string): Promise<Problem[]> {
  const out: Problem[] = []
  for (const id of embeddedCards(text)) {
    const f = await cardFile($, id)
    if (f.error) out.push({ card: id, why: f.error })
  }
  const cs = citations(text)
  remember(cs)
  await check($, cs, true)
  for (const c of cs) {
    const v = (await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value
    if (v?.status === 'missing') out.push({ cite: c, why: `does not resolve: ${v.why}` })
    else if (v?.status === 'differs') out.push({ cite: c, why: v.why })
  }
  return out
}

// ------------------------------------------------------------------------------------------------ the mod's subagents

/** Start a subagent of the mod, named `desc` (threads.tsx): a fork of main, or where a fork is refused a
 *  general-purpose one given `fresh`. */
async function spawnSub($: Dollar, prompt: string, desc: string, fresh: string): Promise<{ agentId: string; engine: string } | { deny: string }> {
  let engine = 'fork'
  let r = await $.agent.spawn({ prompt, description: desc, subagentType: 'fork' }).catch((err: unknown) => ({ deny: String(err) }))
  if (r.deny !== undefined || !('agentId' in r) || !r.agentId) {
    engine = 'general-purpose'
    r = await $.agent.spawn({ prompt: fresh, description: desc, subagentType: 'general-purpose' }).catch((err: unknown) => ({ deny: String(err) }))
  }
  if (r.deny !== undefined || !('agentId' in r) || !r.agentId) return { deny: r.deny ?? 'no id' }
  return { agentId: r.agentId, engine }
}

async function agentOf($: Dollar, agentId: string | undefined): Promise<ChatAgent | undefined> {
  return agentId ? (await $.state.get({ ...AGENTS, id: agentId })).value : undefined
}

/** A note main reads with its next request and the analyst does not see, so its context matches the screen. */
async function noteMain($: Dollar, text: string): Promise<void> {
  await $.session
    .append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    .catch((err: unknown) => $.ui.log(`thimble-cc-mod: could not leave main a note: ${String(err).slice(0, 200)}`))
}

// ------------------------------------------------------------------------------------------------ fix rounds

function fixKey(it: ChatFixItem): string[] {
  return it.card ? [`card-${it.card}`] : (it.keys ?? [])
}

async function setFix($: Dollar, items: ChatFixItem[], state: string, why?: string): Promise<void> {
  for (const it of items) for (const id of fixKey(it)) await $.state.set({ ...FIXES, id }, why ? { state, why } : { state })
}

/** A reply's problems go to a forked subagent, out of main's chat; its citations spin until it answers. `rows` are the
 *  turn's text rows, so each passage's citations are known by their claims and its correction by its row. */
async function startFix($: Dollar, text: string, rows: ChatRow[], endRow: string, end: ChatEnd | undefined): Promise<void> {
  const problems = await problemsOf($, text)
  if (!problems.length) return
  const items = fixItems(text, problems)
  for (const it of items) {
    if (it.card) continue
    it.keys = rows.filter(r => r.text.includes(it.old)).flatMap(r => claimsIn(r.text, r.id).filter(cl => it.cites.includes(cl.c.raw)).map(cl => cl.key))
  }
  await setFix($, items, 'fixing')
  const prompt = fixPrompt(items)
  const label = fixName(items)
  const r = await spawnSub($, prompt, label, withGuide(await ensureGuide($), `${prompt}\n\nThe reply:\n${text}`))
  if ('deny' in r) {
    await setFix($, items, 'failed', `could not start a subagent: ${r.deny}`)
    return
  }
  await $.state.set({ ...AGENTS, id: r.agentId }, { kind: 'fix', label, items, reply: text, endRow, rows, ...(end ? { end } : {}) })
}

/** The fix round answered: each corrected sentence that now checks replaces the old one; the others stay red, ✗. */
async function fixComplete($: Dollar, a: ChatAgent, reason: string, answer: string): Promise<void> {
  const items = a.items ?? []
  const got = reason === 'answer' ? parseFix(answer, items.length) : items.map(() => ({ ok: false as const, why: `the fix ended: ${reason}` }))
  const fresh = got.flatMap(g => (g.ok ? citations(g.text) : []))
  remember(fresh)
  await check($, fresh, true)
  const verdicts = new Map<string, ChatVerdict | undefined>()
  for (const c of fresh) verdicts.set(c.raw, (await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value)
  const cardErrors = new Map<string, string>()
  for (let i = 0; i < items.length; i++) {
    const id = items[i]!.card ? fixedCard(items[i]!, got[i]!) : ''
    if (id) cardErrors.set(id, (await cardFile($, id)).error)
  }
  const out = settleFix(items, got, raw => verdicts.get(raw), id => cardErrors.get(id) ?? '', a.reply)
  for (let i = 0; i < items.length; i++) {
    const st = out.states[i]!
    await setFix($, [items[i]!], st.state, st.why)
  }
  const at = await $.clock.now()
  // each correction is for the row its passage stands in, and is drawn there only
  const rows = a.rows ?? []
  const made: ChatCorrection[] = out.corrections.map(c => ({ ...c, at, row: rows.find(r => r.text.includes(c.old))?.id ?? a.endRow ?? '' }))
  const notes = out.notes
  // a card's script may have changed values the reply cites
  const fixedRows = rows.map(r => ({ id: r.id, text: applyCorrections(r.text, made, r.id) }))
  const cls = fixedRows.flatMap(r => claimsIn(r.text, r.id))
  rememberClaims(cls)
  await check($, cls.map(cl => cl.c).filter(c => c.ref.startsWith('card:')), true)
  if (made.length) {
    const all = await update($, correctionsA, list => [...(list ?? []), ...made].slice(-200))
    await paths($)
    await $.fs.write(`${cwd}/${HOME}/corrections.json`, JSON.stringify(all, null, 1)).catch(() => undefined)
    // the answer file is written again from the answer as written and its corrections, whatever state was lost
    const end = (a.endRow ? (await $.state.get({ ...ENDS, id: a.endRow })).value : undefined) ?? a.end
    if (end) {
      await $.fs.write(`${cwd}/${end.file}`, answerFile(end, all)).catch(() => undefined)
      if (a.endRow) await $.state.set({ ...ENDS, id: a.endRow }, end)
    }
    const turn = await read($, turnA)
    if (turn && turn.ids.some(id => fixKeysOf(items).has(id))) await $.state.set({ plugin: 'thimble-cc-mod', key: 'turn' }, { ...turn, ids: cls.map(cl => cl.key) })
  }
  if (notes.length) await noteMain($, ['thimble-cc-mod checked your last reply, and a subagent worked on its problems; the analyst sees the result in place:', ...notes.map(n => `- ${n}`)].join('\n'))
}

function fixKeysOf(items: ChatFixItem[]): Set<string> {
  return new Set(items.flatMap(fixKey))
}

async function loadCorrections($: Dollar): Promise<void> {
  if ((await read($, correctionsA))?.length) return
  await paths($)
  try {
    const list = JSON.parse(await $.fs.read(`${cwd}/${HOME}/corrections.json`)) as ChatCorrection[]
    // a correction without the row it was made for cannot be put back in the right answer
    if (Array.isArray(list)) await $.state.set(CORRECTIONS, list.filter(c => typeof c?.old === 'string' && typeof c?.new === 'string' && typeof c?.row === 'string' && c.row !== ''))
  } catch {
    // no corrections in this folder
  }
}

// ------------------------------------------------------------------------------------------------ verification scripts

function scriptPath(id: string): string {
  return `${HOME}/verify/v-${id}.py`
}

function verifyPrompt(c: Citation, v: ChatVerdict | undefined, sentence: string, script: string): string {
  const where =
    v?.kind === 'value'
      ? `row "${v.row}" of column "${v.column}" of card:${v.card}`
      : v?.kind === 'call'
        ? `line ${v.start} of the output of call:${v.call}`
        : v?.file
          ? `${v.file}${v.start ? ` line ${v.start}` : ''}`
          : c.ref
  return [
    `thimble-cc-mod: the analyst asks for a verification script of ${c.raw} (${where}), from the sentence "${clip(sentence || c.raw, 300)}". Recompute what that sentence claims.`,
    `Write it at ${script}, following "Verification scripts" in thimble-cc-mod's guidance, run it once, and reply in one sentence with what it recomputed.`,
  ].join('\n')
}

/** A forked subagent writes the verification script of a claim (`id`: its key; a mark's or a record's citation id), out
 *  of main's chat; its end runs the script. */
async function askVerify($: Dollar, id: string): Promise<void> {
  const c = citeOf(id)
  if (!c) return
  const v = (await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value
  const script = scriptPath(id)
  await $.state.set({ ...VERIFY, id }, { id, state: 'asked', script, expected: c.display })
  const prompt = verifyPrompt(c, v, claimMap.get(id)?.sentence ?? '', script)
  const label = verifyName(chipLabel(c))
  const r = await spawnSub($, prompt, label, withGuide(await ensureGuide($), prompt))
  if ('deny' in r) {
    await $.state.set({ ...VERIFY, id }, { id, state: 'error', script, expected: c.display, stderr: `could not start a subagent: ${r.deny}` })
    return
  }
  await $.state.set({ ...AGENTS, id: r.agentId }, { kind: 'verify', label, cite: id })
}

/** The verification's subagent ended: the mod runs the script it wrote (never the subagent's copy of its output). */
async function verifyComplete($: Dollar, a: ChatAgent, answer: string): Promise<void> {
  const id = a.cite ?? ''
  const prev = (await $.state.get({ ...VERIFY, id })).value
  if (!prev) return
  await paths($)
  if (await $.fs.exists(`${cwd}/${prev.script}`)) await runVerify($, id)
  else await $.state.set({ ...VERIFY, id }, { ...prev, state: 'missing', stderr: clip(answer, 500) })
}

/** Run a citation's verification script (never main's copy of its output) and record what it printed. */
async function runVerify($: Dollar, id: string): Promise<void> {
  await paths($)
  const prev = (await $.state.get({ ...VERIFY, id })).value
  const c = citeOf(id)
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
    if (r.exitCode === 0 && result !== null && c) {
      const sentence = claimMap.get(id)?.sentence
      await noteMain($, `thimble-cc-mod: the verification script ${script} recomputed ${result} for ${c.raw}${sentence ? ` in "${clip(sentence, 200)}"` : ''}${expected === null ? '' : ok ? ', which matches' : `, not ${expected}`}.`)
    }
  } catch (err) {
    await $.state.set({ ...VERIFY, id }, { id, state: 'error', script, expected, source: source.slice(0, 9000), stderr: String(err).slice(0, 500) })
  }
}

/** Why a verification that ended in `error` failed: it crashed, printed no result, or never started. */
function verifyError(run: ChatVerify): string {
  const last = (run.stderr ?? '').trim().split('\n').at(-1) ?? ''
  if (!run.source) return `failed: ${clip(run.stderr || 'the script could not be read', 300)}`
  if (run.exitCode === undefined) return `crashed: ${run.script} could not run${last ? ` (${clip(last, 160)})` : ''}`
  if (run.exitCode !== 0) return `crashed: ${run.script} exited with ${run.exitCode}${last ? ` (${clip(last, 160)})` : ''}`
  return `failed: ${run.script} printed no RESULT line`
}

function verifyWords(run: ChatVerify | undefined): string {
  if (!run) return ''
  switch (run.state) {
    case 'verified':
      return `script recomputed ${run.result}`
    case 'refuted':
      return `script recomputed ${run.result}, not ${run.expected}`
    case 'error':
      return run.source ? 'script crashed' : 'script failed to start'
    case 'asked':
      return 'script being written'
    case 'running':
      return 'script running'
    case 'missing':
      return 'script not written'
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
    $.ui.toast('this card has no script to run')
    return
  }
  if (prev.busy) return
  const values: Record<string, string | number> = {}
  for (const p of card.params ?? []) values[p.name] = p.value
  if (change) values[change.name] = change.value
  // a choice changes what the card shows, not what its replies claimed: they keep the choice they were written for
  const written = prev.written ?? (change ? paramsKey(card) : undefined)
  const keep = written ? { written } : {}
  await $.state.set({ ...RUNS, id }, { ...prev, ...keep, busy: change ? `running with ${change.name} = ${change.value}…` : 'running…', error: undefined })
  try {
    const r = await $.process.run(['python3', script], {
      cwd,
      env: { THIMBLE_CC_MOD_PARAMS: JSON.stringify(values), THIMBLE_CC_MOD_ONLY: `${card.source.index ?? 0}:${id}`, THIMBLE_CC_MOD_ROOT: cwd },
      timeoutMs: 180000,
    })
    const f = await cardFile($, id)
    const error = r.exitCode !== 0 ? `the script exited with ${r.exitCode}: ${r.stderr.trim().split('\n').at(-1) ?? ''}` : f.error
    // back at the choice the replies were written for, the card is theirs again
    const still = written && paramsKey(f.data) !== written ? { written } : {}
    await $.state.set({ ...RUNS, id }, { rev: prev.rev + 1, ...still, error: error || undefined, stdout: r.stdout.slice(-3000), stderr: r.stderr.slice(-2000), exitCode: r.exitCode, at: await $.clock.now() })
  } catch (err) {
    await $.state.set({ ...RUNS, id }, { rev: prev.rev + 1, ...keep, error: `could not run ${script}: ${String(err).slice(0, 100)}` })
  }
  // the citations of this card are checked again (the script may have changed its values), but not while the card
  // shows another choice than they were written for (check keeps their verdicts then)
  const mine = [...known.values()].filter(c => c.ref.startsWith(`card:${id}#`) || c.ref === `card:${id}`)
  if (mine.length) await check($, mine)
}

/** What a card's script printed, without the card helper's lines for main (where the card went, how to embed and cite
 *  it): the analyst reads the script's own output. */
function scriptOutput(stdout: string): string {
  const out: string[] = []
  let listing = false
  for (const line of stdout.split('\n')) {
    if (/^thimble-cc-mod(?: card |:)|^controls on the card: |^embed it on a line of its own: /.test(line)) {
      listing = false
      continue
    }
    if (/^cite its (?:values|records) as:$/.test(line)) {
      listing = true
      continue
    }
    if (listing && /^ {2}(?:\[\[|\.\.\. \d+ more)/.test(line)) continue
    listing = false
    out.push(line)
  }
  return out.join('\n')
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
  const t: ChatThread = { id, label: about.label, ref: about.ref ?? '', context: about.context, agentId: '', engine: '', turns: [], file: `.thimble-cc-mod/threads/${id}.md` }
  await setThread($, t)
  const list = (await read($, threadListA)) ?? []
  await $.state.set({ plugin: 'thimble-cc-mod', key: 'threadList' }, [...list, id].slice(-20))
  await $.state.set({ plugin: 'thimble-cc-mod', key: 'thread' }, id)
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
  const label = threadName(q)
  const r = await spawnSub($, forkPrompt(t, q.trim()), label, freshPrompt(t, q.trim(), guide))
  if ('deny' in r) {
    await setThread($, lastTurn(t, { state: 'error', a: `could not start a subagent: ${r.deny}` }))
    return
  }
  await $.state.set({ ...AGENTS, id: r.agentId }, { kind: 'thread', label, thread: id })
  await setThread($, { ...t, agentId: r.agentId, engine: r.engine })
}

/** A subagent's row: a thread's progress (its tool calls and latest text). Called by register.tsx's one
 *  session.append hook (an event takes one hook per matcher). */
async function threadAppend($: Dollar, agentId: string | undefined, door: string, content: unknown): Promise<void> {
  if (door !== 'response' || !Array.isArray(content)) return
  const tid = (await agentOf($, agentId))?.thread
  if (!tid) return
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
  const tid = (await agentOf($, agentId))?.thread
  if (!tid) return null
  const t = await getThread($, tid)
  if (!t) return null
  const text = reason === 'answer' ? answer : `${answer || ''}\n(the subagent ended: ${reason})`.trim()
  const done = lastTurn(t, { a: text, state: reason === 'answer' ? 'done' : 'error' })
  await setThread($, done)
  await saveThread($, cwd, done)
  // the ring stays on the question field, so a follow-up typed next goes to this thread (with the ring on a button,
  // typing goes to main's prompt); Tab or a click reaches "offer to main"
  $.ui.toast(`the side thread on ${clip(plainCites(t.label), 40)} answered`)
  return text
}

// ------------------------------------------------------------------------------------------------ chips

/** How a citation in the prompt is painted: as a link, like the reply's. */
function chipDecoration(raw: string, start = 0): { start: number; end: number; underline: boolean; color: string } {
  return { start, end: start + raw.length, underline: true, color: COLORS.link }
}

/** What a citation's fix round says while it runs, or after it failed on a citation that is still red. */
function fixNote(status: string | undefined, fix: { state: string; why?: string } | undefined): string {
  const st = chipState(status, fix?.state)
  if (st === 'fixing') return 'being fixed…'
  if (st === 'failed') return `the fix failed: ${plainWhy(fix?.why ?? 'no reason given')}`
  return ''
}

/** A card by its question, never its id. */
function cardName(id: string): string {
  const q = cards.get(id)?.data?.question
  return q ? `card "${clip(q, 40)}"` : 'the card'
}

/** A ref as the analyst reads it: a card's place by the card's question and a command's output by its line, never an
 *  id; any other place as written. */
function placeName(ref: string): string {
  const m = /^card:([A-Za-z0-9_-]+)(?:#(.*))?$/.exec(ref)
  if (m) return m[2] ? `${cardName(m[1]!)} · ${m[2]}` : cardName(m[1]!)
  const call = /^call:[A-Za-z0-9_-]+(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(ref)
  if (call) return `a command's output${call[1] ? ` · line ${call[1]}${call[2] ? `-${call[2]}` : ''}` : ''}`
  return ref
}

/** A pasted citation of card `id` as its pane names it: the value and its place on the card; '' for any other. */
function citedOnCard(raw: string, id: string): string {
  const c = citations(raw)[0]
  const m = c && /^card:([A-Za-z0-9_-]+)(?:#(.*))?$/.exec(c.ref)
  if (!c || m?.[1] !== id) return ''
  const place = m[2] ? m[2].replace('/', ' ') : 'the card'
  return c.display !== null ? `${c.display} · ${place}` : place
}

/** A reason as the analyst reads it: citations as their shown words, a card by its question, a command's output
 *  without its id. */
function plainWhy(why: string): string {
  return plainCites(why)
    .replace(/\bcard[: ]([A-Za-z0-9_-]+)/g, (m, id: string) => (cards.has(id) || /^[0-9a-f]{6}$/.test(id) ? cardName(id) : m))
    .replace(/\bcall[: ](?=[a-z]*\d)[0-9a-z]{3,8}\b/g, 'the command')
    .replace(new RegExp(`${HOME.replace('.', '\\.')}/cards/[A-Za-z0-9_-]+\\.json`, 'g'), 'its card file')
}

async function chipView($: Dollar, cl: Claim): Promise<ChipView> {
  const c = cl.c
  const v = (await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value
  const run = (await $.state.get({ ...VERIFY, id: cl.key })).value
  const fix = (await $.state.get({ ...FIXES, id: cl.key })).value
  const look = chipLook(v?.status, fix?.state, run?.state)
  const why = look.state === 'link' && v?.status !== 'ok' ? '' : plainWhy(v?.why ?? '')
  const tip = [placeName(c.ref), why, await otherChoice($, c.ref), fixNote(v?.status, fix), verifyWords(run)].filter(Boolean).join(' · ')
  return { label: citeLabel(c), ...look, tip }
}

/** A line of text as segments, each citation as a link (its shown words, underlined), the rest styled `base`. */
function linkSegs(text: string, base: Omit<Line[number], 's'>): Line {
  return inlineRuns(text.replace(/\s+/g, ' ')).map(r => (r.cite ? { s: citeLabel(r.cite), fg: COLORS.link, u: true } : { ...base, s: r.text }))
}

// ------------------------------------------------------------------------------------------------ drawing a reply

/** A reply's blocks as thimble-cc-mod draws them: Markdown as the engine would, cards as panels, paragraphs that hold
 *  citations as chips. Interactive (Clients) on the terminal and desktop, static elsewhere. `answer` names the answer
 *  (a row's uuid, a side thread's turn): each citation is checked as the claim of its sentence in it. */
async function drawReply($: Dollar, e: ResolveInput, text: string, width: number, answer: string, prefix = ''): Promise<RenderElement[]> {
  const { Box, Text, Markdown } = $.ui.resolve(e)
  const live = e.surface === 'terminal' || e.surface === 'desktop'
  const cols = Math.max(30, width)
  const out: RenderElement[] = []
  const blocks = parseReply(text)
  const menu = live ? ((await read($, menuA)) ?? null) : null // the target of an open menu, lit where it is drawn
  let n = 0
  let order = 0 // the card's place among the reply's cards, its name for the analyst ("Card 2")
  const push = (el: RenderElement) => out.push(blocks[n - 1]?.gap ? <Box marginTop={1}>{el}</Box> : el)
  for (const block of blocks) {
    n++
    if (block.type === 'md') {
      if (live) {
        // a Client, so a plain paragraph takes the gestures too
        const { Client } = $.ui.resolve(e as ResolveInput<'AssistantMessage', 'terminal'>)
        push(<Client key={`${prefix}md-${n}`} module="./gestures.tsx" width="100%" props={{ text: block.text, menu }} />)
      } else push(<Markdown text={block.text} />)
      continue
    }
    if (block.type === 'card') {
      order++
      cardReply.set(block.id, text)
      await $.state.get({ ...RUNS, id: block.id }) // a finished run redraws the card
      const f = await cardFile($, block.id)
      if (!f.data) {
        const fix = (await $.state.get({ ...FIXES, id: `card-${block.id}` })).value
        const more = fix?.state === 'fixing' ? ' · being fixed…' : fix?.state === 'failed' ? ' ✗' : ''
        push(<Text color={COLORS.problem} wrap="wrap">{`▍ Card ${order} cannot be drawn: ${f.why}${more}`}</Text>)
        continue
      }
      const card = f.data
      const meta = await metaOf($, card.id)
      const w = Math.min(cols, CARD_MAX_COLS)
      if (live) {
        const { Client } = $.ui.resolve(e as ResolveInput<'AssistantMessage', 'terminal'>)
        push(<Client key={`${prefix}card-${n}-${card.id}`} module="./card.tsx" width={w} props={{ card, cols: w, debug, meta, menu }} />)
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
    const raws: string[] = []
    const cls = blockClaims(block, answer)
    rememberClaims(cls)
    for (const cl of cls) {
      chips.push(await chipView($, cl))
      ids.push(cl.key)
      raws.push(cl.c.raw)
    }
    if (live) {
      const { Client } = $.ui.resolve(e as ResolveInput<'AssistantMessage', 'terminal'>)
      push(<Client key={`${prefix}para-${n}`} module="./para.tsx" width="100%" props={{ cols, block, chips, ids, raws, menu }} />)
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

/** Open the citation panel on a claim (`key`), or on a citation of its own (a mark's, a record's, with the passage the
 *  example quotes). */
async function openCitation($: Dollar, c: Citation, key?: string, quote?: string): Promise<void> {
  const id = cid(c.raw)
  remember([c])
  if (quote) quotes.set(id, quote)
  else quotes.delete(id)
  if (!(await $.state.get({ ...VERDICTS, id })).value) enqueue($, [c])
  await $.state.set({ plugin: 'thimble-cc-mod', key: 'open' }, key && claimMap.has(key) ? key : id)
  await openPane($, { id: CITE_PANE, title: 'Citation', focus: true, closeOnEscape: true, columns: 96, rows: 22 })
}

/** The citation pane and the card pane take turns: one opened while the other holds the keys opens behind it as a
 *  tab, and the click seems to do nothing. */
async function openPlace($: Dollar, c: Citation, key?: string, quote?: string): Promise<void> {
  await $.ui.close({ id: CARD_PANE })
  await openCitation($, c, key, quote)
}

async function openCardPane($: Dollar, id: string, mode: string): Promise<void> {
  await $.ui.close({ id: CITE_PANE })
  const card = await loadCard($, id)
  await $.state.set({ plugin: 'thimble-cc-mod', key: 'paneCard' }, id)
  await $.state.set({ plugin: 'thimble-cc-mod', key: 'paneMode' }, mode)
  await openPane($, { id: CARD_PANE, title: clip(card?.question ?? 'Card', 60), focus: true, closeOnEscape: true, columns: 100 })
}

/** A cited line wrapped in at most `rows` rows around its highlight (the shown value, or the passage the example
 *  quotes), the gutter numbering its first row. */
function wrappedRows(els: { Text: (p: object) => RenderElement }, w: { n: number; text: string; spans?: number[][] }, quote: string, gutter: number, cols: number, rows: number): RenderElement[] {
  const { Text } = els
  const room = Math.max(10, cols - gutter - 3)
  const text = w.text.replace(/\t/g, '  ')
  const first = w.spans?.[0]
  const span: [number, number] | null = quote ? quoteSpan(text, quote) : first ? [first[0]!, first[1]!] : null
  return wrapAround(text, span, room, rows).map((r, i) =>
    Text({
      children: [
        Text({ color: COLORS.accent, children: `${i === 0 ? String(w.n).padStart(gutter) : ' '.repeat(gutter)} ${i === 0 ? '▶' : '│'} ` }),
        Text({ children: r.hi ? r.text.slice(0, r.hi[0]) : r.text || ' ' }),
        ...(r.hi ? [Text({ backgroundColor: COLORS.highlight, bold: true, children: r.text.slice(r.hi[0], r.hi[1]) }), Text({ children: r.text.slice(r.hi[1]) })] : []),
      ],
    }),
  )
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
    parts.push(Text({ backgroundColor: COLORS.highlight, bold: true, children: text.slice(a, b) }))
    at = b!
  }
  parts.push(Text({ children: text.slice(at) || ' ' }))
  return Text({
    wrap: 'truncate-end',
    children: [
      Text({ color: w.hit ? COLORS.accent : COLORS.dim, children: `${String(w.n).padStart(gutter)} ${w.hit ? '▶' : '│'} ` }),
      Text({ backgroundColor: w.hit ? COLORS.cursor : undefined, children: parts }),
    ],
  })
}

/** What a side thread about a citation (a claim's key, or a citation's id) is told: the sentence, the ref and what the
 *  place shows. */
async function citationContext($: Dollar, key: string): Promise<{ label: string; context: string; ref: string }> {
  const c = citeOf(key)
  const v = c ? (await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value : undefined
  const sentence = claimMap.get(key)?.sentence ?? ''
  const shows = v?.window?.filter(w => w.hit).map(w => w.text).join('\n') ?? v?.value ?? ''
  return {
    ref: c?.raw ?? '',
    label: c ? `the citation ${c.raw}` : 'a citation',
    context: [sentence && `The sentence: "${clip(sentence, 600)}"`, v && `Checked: ${STATUS_WORDS[v.status] ?? v.status} (${v.why}).`, shows && `The cited place shows: ${clip(shows, 1500)}`]
      .filter(Boolean)
      .join('\n'),
  }
}

/** What a side thread about a card is told: its question, script, data in brief and the takeaway. */
async function cardContext($: Dollar, id: string): Promise<{ label: string; context: string; ref: string }> {
  const card = await loadCard($, id)
  const takeaway = takeawayAfter(cardReply.get(id) ?? '', id)
  const data = card ? clip(JSON.stringify(card.rows ?? card.series ?? card.events ?? card.examples ?? (card.nodes ? { nodes: card.nodes, edges: card.edges } : [])), 1500) : ''
  return {
    ref: `[[card:${id}]]`,
    label: card ? `the card "${card.question}"` : 'a card',
    context: [
      card?.source?.script && `Made by ${card.source.script}${card.params?.length ? ` with ${card.params.map(p => `${p.name} = ${p.value}`).join(', ')}` : ''}.`,
      data && `Its data (${HOME}/cards/${id}.json): ${data}`,
      takeaway && `Its takeaway in the reply: ${takeaway}`,
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

// ------------------------------------------------------------------------------------------------ gestures

const DEBUG_FLAG = `${HOME}/debug`
const OFF = /^(|0|off|false|no)$/i

/** The mouse log is on when .thimble-cc-mod/debug says so (/thimble-cc-mod debug on|off writes it), else when
 *  THIMBLE_CC_MOD_DEBUG is set. */
async function loadDebug($: Dollar): Promise<void> {
  await paths($)
  let flag: string | undefined
  try {
    flag = (await $.fs.read(`${cwd}/${DEBUG_FLAG}`)).trim()
  } catch {
    flag = undefined
  }
  const env = flag === undefined ? ((await $.env.get('THIMBLE_CC_MOD_DEBUG').catch(() => undefined)) ?? '').trim() : ''
  debug = !OFF.test(flag ?? env)
}

let logFailed = false

/** Append a line to .thimble-cc-mod/mouse.log; the first failure is said once in the transcript. */
async function writeMouseLog($: Dollar, line: string): Promise<void> {
  await paths($)
  mouseLog.push(line)
  try {
    await $.fs.write(`${cwd}/${HOME}/mouse.log`, `${mouseLog.slice(-500).join('\n')}\n`)
  } catch (err) {
    if (!logFailed) $.ui.log(`thimble-cc-mod: could not write ${HOME}/mouse.log: ${String(err).slice(0, 160)}`)
    logFailed = true
  }
}

/** One line of the mouse log: a press or release a Client saw, and what it made. */
async function logMouse($: Dollar, module: string, g: Sent): Promise<void> {
  const ev: Partial<PointerEv> = g.ev ?? {}
  const mods = (['shift', 'ctrl', 'alt'] as const).filter(k => ev[k]).join('+') || 'none'
  const at = new Date(await $.clock.now()).toISOString()
  await writeMouseLog($, JSON.stringify({ at, event: ev.type, button: ev.button, mods, gesture: g.gesture ?? 'none', target: g.target ? `${g.target.kind}: ${targetLabel(g.target)}` : '', module }))
}

async function onGesture($: Dollar, g: Gesture, t: Target, ev?: PointerEv): Promise<void> {
  if (g === 'menu') {
    // the press chose the open menu's target; a release that the menu's pane moved onto another target does not change it
    if (ev?.type === 'release' && (await read($, menuA))) return
    await openMenu($, t)
  } else if (g === 'cite') await act($, 'cite', t)
  else if (g === 'thread') await act($, 'thread', t)
  else if (g === 'primary') {
    const c = placeOf(t)
    if (c) await openPlace($, c, t.claim, await quoteOf($, t))
    else if (t.kind === 'card' && cardOf(t)) await openCardPane($, cardOf(t), t.script ? 'script' : '')
  }
}

/** The passage an example card quotes from the record a target names. */
async function quoteOf($: Dollar, t: Target): Promise<string | undefined> {
  if (t.kind !== 'record' || !t.cardId) return undefined
  const card = await loadCard($, t.cardId)
  return card?.examples?.find(x => x.ref === t.ref)?.quote || undefined
}

let menuWatch: { cancel: () => void } | null = null

/** Open the menu of a target. The target stays in state while the menu is open, so the reply lights it (drawReply hands
 *  it to each Client as `menu`), and is cleared once the menu closes, by a choice or Esc. */
async function openMenu($: Dollar, t: Target): Promise<void> {
  await $.state.set({ plugin: 'thimble-cc-mod', key: 'menu' }, t)
  await $.ui.open({ id: MENU_PANE, title: 'Actions', focus: true, closeOnEscape: true, rows: menuItems(t).length + 1, columns: 34 })
  menuWatch?.cancel()
  const watch = $.clock.every(250, () => {
    void (async () => {
      let open = true
      try {
        open = (await $.ui.panes()).some(p => p.id === MENU_PANE)
      } catch {
        watch.cancel()
        return
      }
      if (open) return
      watch.cancel()
      if (menuWatch === watch) menuWatch = null
      await $.state.set({ plugin: 'thimble-cc-mod', key: 'menu' }, null)
    })()
  })
  menuWatch = watch
}

/** What a side thread about a target is told. */
async function aboutTarget($: Dollar, t: Target): Promise<{ label: string; context: string; ref?: string }> {
  const card = cardOf(t)
  const c = citationOf(t)
  if (t.kind === 'card' && card) return cardContext($, card)
  if (t.kind === 'citation' && c) {
    remember([c])
    return citationContext($, t.claim && claimMap.has(t.claim) ? t.claim : cid(c.raw))
  }
  if (t.kind === 'sentence' || !c) {
    const s = (t.text ?? '').trim()
    return { label: `the passage "${clip(plainCites(s), 48)}"`, context: s ? `The passage of the reply: "${clip(s, 1500)}"` : '' }
  }
  const base = card ? await cardContext($, card) : null
  return {
    ref: c.raw,
    label: `${targetLabel(t)}${base ? ` on ${base.label}` : ''}`,
    context: [`The analyst points at ${c.raw}.`, base?.context].filter(Boolean).join('\n'),
  }
}

/** One action on a target, from a gesture or the menu. */
async function act($: Dollar, what: Act, t: Target): Promise<void> {
  const card = cardOf(t)
  switch (what) {
    case 'open': {
      const c = placeOf(t)
      if (c) await openPlace($, c, t.claim, await quoteOf($, t))
      return
    }
    case 'cite': {
      const text = citeText(t)
      if (!text) return
      await $.prompt.fill({ text: `${text} `, mode: 'insert', decorations: text.startsWith('[[') ? [chipDecoration(text)] : [] })
      if (text.startsWith('[[')) await $.state.set({ plugin: 'thimble-cc-mod', key: 'picked' }, text)
      return
    }
    case 'thread': {
      const about = await aboutTarget($, t)
      await $.ui.close({ id: CITE_PANE })
      await openThread($, about)
      return
    }
    case 'verify': {
      const c = citationOf(t)
      if (!c || c.display === null) return
      const id = cid(c.raw)
      remember([c])
      if (!(await $.state.get({ ...VERDICTS, id })).value) enqueue($, [c])
      // a reply's citation is verified as the claim of its sentence in its answer, never as another answer's
      await askVerify($, t.claim && claimMap.has(t.claim) ? t.claim : id)
      // a mark has no chip of its own to show the outcome: the citation panel does
      if (t.kind !== 'citation') await openPlace($, c, undefined, await quoteOf($, t))
      return
    }
    case 'script':
      if (card) await openCardPane($, card, 'script')
      return
    case 'rerun':
      if (card) void rerunCard($, card)
      return
  }
}

// ------------------------------------------------------------------------------------------------ while a reply streams

const asWritten = new Map<string, string>() // a text block as the engine was handed it while it streamed -> as written

/** The file a citation's place is in, as a file: URL, the target of its link while the reply streams. */
function placeUrl(ref: string): string {
  const [base = ''] = ref.split('#', 1)
  const m = /^(card|call):([A-Za-z0-9_-]+)$/.exec(base)
  const file = m ? `${cwd}/${HOME}/${m[1]}s/${m[2]}.json` : base.startsWith('/') ? base : `${cwd}/${base}`
  return `file://${encodeURI(file).replace(/[()]/g, ch => `%${ch.charCodeAt(0).toString(16)}`)}`
}

/** How a streaming reply shows citations and card lines; the cards' questions are read before (`questions`). */
function streamLook(questions: Map<string, string>): StreamLook {
  return {
    link: c => streamLink(c, placeUrl(c.ref)),
    card: id => {
      const q = questions.get(id)
      return `▍ *${q ? q.replace(/[\\[\]*_`<>]/g, m => `\\${m}`) : 'drawing the card…'}*`
    },
  }
}

/** The text rows of a turn in main, split at each tool call: the last part holds the answer. */
type Part = { rows: ChatRow[] }

/** The part of a turn that is its answer: the last one that cites or embeds a card, else the last one. Earlier parts
 *  are what main wrote while it worked ("Reading the files…"). */
function answerPart(parts: Part[]): Part | undefined {
  const full = parts.filter(p => p.rows.some(r => r.text.trim()))
  return [...full].reverse().find(p => needsDrawing(p.rows.map(r => r.text).join('\n\n'))) ?? full.at(-1)
}

// ------------------------------------------------------------------------------------------------ register

export const register: Register = on => {
  let turnParts: Part[] = [{ rows: [] }] // this turn's text rows in main (their uuids and text), by part
  let turnPrompt = ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await ensureGuide($)
    await loadDebug($)
    // the card helper writes cards here, wherever a script runs: every Bash command and process started after inherits it
    await $.env.set('THIMBLE_CC_MOD_ROOT', cwd).catch((err: unknown) => $.ui.log(`thimble-cc-mod: could not set THIMBLE_CC_MOD_ROOT: ${String(err).slice(0, 120)}`))
    await loadCorrections($)
    $.clock.every(150, () => void flushQueue($))
    await $.command.register({ name: 'thimble-card', description: 'Open a card of the last reply in a pane: /thimble-card <n>' })
    await $.command.register({ name: 'thimble-cite', description: 'Open the panel of a citation of the last reply: /thimble-cite <n>', immediate: true })
    await $.command.register({ name: 'thimble-check', description: 'Check the citations of the last reply again', immediate: true })
    await $.command.register({ name: 'thimble-ask', description: 'Ask a side thread about the last reply, out of the main chat: /thimble-ask <question>', immediate: true })
    await $.command.register({ name: 'thimble-band', description: 'Show or hide the band of the last reply\'s citations above the prompt', immediate: true })
    await $.command.register({ name: 'thimble-cc-mod', description: 'thimble-cc-mod status; /thimble-cc-mod debug on|off writes the mouse log or stops it', immediate: true })
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
      lastReply = text
      if (embeddedCards(text).length) lastCards = embeddedCards(text)
      // the rows' uuids are not listed: the band's claims are the resumed answer's own
      const cls = claimsIn(text, 'resumed')
      if (cls.length) {
        rememberClaims(cls)
        await $.state.set({ plugin: 'thimble-cc-mod', key: 'turn' }, { id: 'resumed', ids: cls.map(cl => cl.key) })
        enqueue($, cls.map(cl => cl.c))
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
    // a subagent of the mod that ends with a notification to main: main would answer it in its chat
    if (e.origin.kind === 'task-notification') {
      const mine = (await $.agent.list().catch(() => [])).filter(a => a.spawnedBy === 'thimble-cc-mod')
      if (mine.some(a => e.text.includes(a.id))) return { drop: 'thimble-cc-mod: a subagent of the mod finished' }
    }
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
    const note = `thimble-cc-mod: this output is call:${short}. To cite a line of it, write [[<value>|call:${short}#L<n>]], counting the output's lines from 1.`
    return { ...ran, context: [...(ran.context ?? []), note] }
  })

  // ---------------------------------------------------------------------------------------------- turns

  on('turn.start', async ($, e, next) => {
    turnParts = [{ rows: [] }]
    turnPrompt = e.text
    return next(e)
  })

  // main's reply as it streams: citations as links and card lines as placeholders, never their raw spelling
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    await paths($)
    const blocks = new Map<number, Streaming>()
    const questions = new Map<string, string>()
    const look = streamLook(questions)
    const end = (i: number, st: Streaming) => {
      const out = streamStep(st, '', true, look)
      if (st.shown !== st.raw) {
        asWritten.set(st.shown, st.raw)
        if (asWritten.size > 50) asWritten.delete(asWritten.keys().next().value!)
      }
      return out ? [{ kind: 'text' as const, index: i, text: out }] : []
    }
    for await (const ch of next(e)) {
      if (ch.kind === 'text') {
        const st = blocks.get(ch.index) ?? streaming()
        blocks.set(ch.index, st)
        for (const m of `${st.raw.slice(st.done)}${ch.text}`.matchAll(/\[\[card:([A-Za-z0-9_-]+)\]\]/g)) {
          if (!questions.has(m[1]!)) questions.set(m[1]!, (await cardFile($, m[1]!)).data?.question ?? '')
        }
        const out = streamStep(st, ch.text, false, look)
        if (out === ch.text) yield ch
        else if (out) yield { ...ch, text: out }
        continue
      }
      // a block ends before anything else of the response passes: what it held back is handed over
      for (const [i, st] of blocks) yield* end(i, st)
      blocks.clear()
      yield ch
    }
    for (const [i, st] of blocks) yield* end(i, st)
  })

  on('session.append', async ($, e, next) => {
    let msg = e.message
    if (e.door === 'response' && e.agentId === undefined && Array.isArray(msg.content)) {
      // a block of main's reply is stored as the model wrote it, not as it showed while it streamed
      const shown = msg.content as { type?: string; text?: string }[]
      const blocks = shown.map(b => (b.type === 'text' && typeof b.text === 'string' && asWritten.has(b.text) ? { ...b, text: asWritten.get(b.text)! } : b))
      if (blocks.some((b, i) => b !== shown[i])) msg = { ...msg, content: blocks as typeof msg.content }
      const texts = blocks.flatMap(b => (b.type === 'text' && typeof b.text === 'string' && b.text.trim() ? [b.text] : []))
      if (texts.length) turnParts.at(-1)!.rows.push({ id: e.uuid, text: texts.join('\n\n') })
      if (blocks.some(b => b.type === 'tool_use')) turnParts.push({ rows: [] })
    }
    const stored = await next(msg === e.message ? e : { ...e, message: msg })
    if (e.agentId !== undefined) await threadAppend($, e.agentId, e.door, e.message.content)
    return stored
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) {
      await paths($)
      const a = await agentOf($, e.agentId)
      if (a?.kind === 'fix') {
        await fixComplete($, a, e.reason, e.answer)
        return done
      }
      if (a?.kind === 'verify') {
        await verifyComplete($, a, e.answer)
        return done
      }
      const answer = await threadComplete($, cwd, e.agentId, e.reason, e.answer)
      if (answer) {
        const cs = citations(answer)
        remember(cs)
        enqueue($, cs)
      }
      return done
    }
    const rows = turnParts.flatMap(p => p.rows)
    const text = rows.length ? rows.map(r => r.text).join('\n\n') : e.answer
    lastReply = text
    const cls = rows.flatMap(r => claimsIn(r.text, r.id))
    rememberClaims(cls)
    const cs = citations(text)
    remember(cs)
    if (cs.length) {
      await check($, cs, true) // again, at the turn's end: a card may have changed since the block was drawn
      await $.state.set({ plugin: 'thimble-cc-mod', key: 'turn' }, { id: e.turnId, ids: cls.map(cl => cl.key) })
    }
    // the answer (not what main wrote while it worked) as a file the analyst owns, and a summary line under its last row
    const part = answerPart(turnParts)
    const answer = part ? part.rows.map(r => r.text).join('\n\n') : e.answer
    const answerCites = citations(answer)
    const cardsOf = embeddedCards(answer)
    if (embeddedCards(text).length) lastCards = embeddedCards(text)
    const lastRow = part?.rows.at(-1)?.id ?? ''
    let end: ChatEnd | undefined
    if (answer.trim() && (answerCites.length || cardsOf.length) && !fromMod(turnPrompt)) {
      await paths($)
      const stamp = new Date(await $.clock.now()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
      end = { rows: part?.rows.length ? part.rows : [{ id: lastRow, text: answer }], cards: cardsOf, file: `${HOME}/answers/${stamp}.md`, head: turnPrompt.split('\n')[0] ?? '' }
      try {
        await $.fs.write(`${cwd}/${end.file}`, `# ${end.head}\n\n${answer}\n`)
      } catch {
        // the answer stays in the transcript
      }
      if (lastRow) await $.state.set({ ...ENDS, id: lastRow }, end)
    }
    // a card that cannot be drawn or a citation that fails goes to a fix round, out of main's chat
    if (text.trim() && !fromMod(turnPrompt)) await startFix($, text, rows, lastRow, end)
    return done
  })

  // ---------------------------------------------------------------------------------------------- the reply

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const end = (await $.state.get({ ...ENDS, id: e.requestId })).value
    if (!needsDrawing(e.props.text) && !end) return next(e)
    // only the corrections made for this row: the same sentence in another answer is that answer's own
    const corrections = (await read($, correctionsA)) ?? []
    const text = applyCorrections(e.props.text, corrections, e.requestId)
    const cs = citations(text)
    remember(cs)
    const unchecked: Citation[] = []
    for (const c of cs) if (!(await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value) unchecked.push(c)
    if (unchecked.length) enqueue($, unchecked)
    const { Box, Text } = $.ui.resolve(e)
    const out = await drawReply($, e, text, (e.viewport?.columns ?? 100) - 4, e.requestId)
    if (end) {
      // one dim line under the answer: its citations and cards, where it is saved, and the problems left, counted from
      // the answer's rows as drawn now (their corrections in place)
      const left = { problem: 0, fixing: 0, failed: 0, link: 0 }
      const cls = new Map<string, Claim>()
      for (const r of end.rows) for (const cl of claimsIn(applyCorrections(r.text, corrections, r.id), r.id)) cls.set(cl.key, cl)
      for (const cl of cls.values()) {
        const v = (await $.state.get({ ...VERDICTS, id: cid(cl.c.raw) })).value
        const f = (await $.state.get({ ...FIXES, id: cl.key })).value
        const r = (await $.state.get({ ...VERIFY, id: cl.key })).value
        left[chipState(v?.status, f?.state, r?.state)]++
      }
      const red = left.problem + left.failed
      const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
      out.push(
        <Box marginTop={1}>
          <Text wrap="truncate-end">
            <Text dimColor>{[plural(cls.size, 'citation'), ...(end.cards.length ? [plural(end.cards.length, 'card')] : []), `saved as ${end.file}`].join(' · ')}</Text>
            {left.fixing ? <Text dimColor>{` · fixing ${left.fixing}…`}</Text> : null}
            {red ? <Text color={COLORS.problem}>{` · ${plural(red, 'problem')}`}</Text> : null}
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

  // a row of main's chat a subagent of the mod causes (its notification, its Agent row): one dim line
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'task-notification' } } }, async ($, e, next) => {
    const a = await agentOf($, e.props.task?.id)
    if (!a && !MOD_AGENT.test(e.props.text)) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor wrap="truncate-end">{`› ${a?.label ?? 'a thimble-cc-mod subagent'} · finished`}</Text>
  })

  on('ui.render', { component: 'ToolUse', props: { tool: 'Agent' } }, async ($, e, next) => {
    const d = (e.props.input as { description?: unknown } | undefined)?.description
    if (typeof d !== 'string' || !MOD_AGENT.test(d)) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor wrap="truncate-end">{`› ${d}${e.props.isRunning ? ' …' : ''}`}</Text>
  })

  // ---------------------------------------------------------------------------------------------- clicks

  on('ui.message', async ($, e, next) => {
    const d = (e.data ?? {}) as { type?: string; id?: string; card?: string; act?: string; name?: string; value?: string; ev?: unknown; origin?: string; gestures?: unknown }
    // every post of a Client that uses hooks/gestures.tsx carries its recent gestures; each is handled once
    if (Array.isArray(d.gestures) && typeof d.origin === 'string') {
      const last = seen.get(d.origin) ?? 0
      const fresh = (d.gestures as Sent[]).filter(g => typeof g?.seq === 'number' && g.seq > last)
      if (fresh.length) seen.set(d.origin, Math.max(...fresh.map(g => g.seq)))
      for (const g of fresh) {
        if (debug) await logMouse($, e.module, g)
        if (g.gesture && g.target) await onGesture($, g.gesture, g.target, g.ev)
      }
    } else if (debug && (d.ev || d.type === 'act' || d.type === 'param')) {
      await writeMouseLog($, JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), module: e.module, ...d }))
    }
    if (d.type === 'pointer' || d.type === 'gesture') return next(e)
    if (d.type === 'hover') {
      await $.state.set({ plugin: 'thimble-cc-mod', key: 'hover' }, typeof d.id === 'string' ? d.id : '')
      return next(e)
    }
    if (d.type === 'param' && typeof d.card === 'string' && typeof d.name === 'string' && typeof d.value === 'string') {
      void rerunCard($, d.card, { name: d.name, value: d.value })
      return next(e)
    }
    return next(e)
  })

  // ---------------------------------------------------------------------------------------------- citation panel

  on('ui.render', { component: 'Pane', requestId: CITE_PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    // `id` keys the claim's fix and verification (a citation's own id for a mark or a record); the verdict is the
    // citation's, whatever sentence holds it
    const id = await read($, openA)
    const own = id ? (await $.state.get({ ...VERDICTS, id })).value : undefined
    // after a reload the module's maps are empty; the verdict in state still holds a citation opened by its own id
    const c = id ? (citeOf(id) ?? (own ? { raw: own.raw, ref: own.ref, display: own.display } : undefined)) : undefined
    const cols = Math.max(30, e.props.bodyColumns)
    if (!c) return <Text dimColor>No citation open.</Text>
    const v = own ?? (await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value
    const run = (await $.state.get({ ...VERIFY, id })).value
    const fix = (await $.state.get({ ...FIXES, id })).value
    const status = v?.status ?? 'pending'
    const look = chipLook(status, fix?.state, run?.state)
    // the passage an example quotes, or the words a citation quotes
    const quote = quotes.get(cid(c.raw)) ?? quotedWords(c.display)
    const body: RenderElement[] = []
    const head = paraLayout({ prefix: '', heading: 0, quote: false, runs: [{ text: citeLabel(c), cite: c }, { text: ` · ${statusWords(c, status, run)}` }] }, [{ label: citeLabel(c), ...look, tip: '' }], cols, -1)
    body.push(paintLines(Box, Text, head.lines))
    const sentence = claimMap.get(id)?.sentence
    body.push(<Text dimColor wrap="truncate-end">{clip(sentence ? `${placeName(c.ref)} · in "${plainCites(sentence)}"` : placeName(c.ref), cols)}</Text>)
    const red = status === 'missing' || status === 'differs'
    if (v?.why && (red || c.display !== null)) body.push(<Text color={red ? COLORS.problem : COLORS.dim} wrap="truncate-end">{clip(plainWhy(v.why), cols)}</Text>)
    const choice = await otherChoice($, c.ref)
    if (choice) body.push(<Text dimColor wrap="wrap">{choice}</Text>)
    if (fixNote(status, fix)) body.push(<Text color={COLORS.problem} wrap="wrap">{fixNote(status, fix)}</Text>)
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
          return isHit ? l.map(s => ({ ...s, bg: COLORS.cursor })) : l
        })
        body.push(paintLines(Box, Text, rows))
        body.push(<Text dimColor wrap="truncate-end">{card.source?.script ? `made by ${card.source.script}` : 'no script recorded'}</Text>)
      }
    } else if (v.window.length) {
      const head = v.kind === 'call' ? `output of $ ${clip(v.command ?? '', cols - 15)}` : `${v.file}${v.start ? ` · line ${v.start}${v.end && v.end !== v.start ? `-${v.end}` : ''}` : ''}`
      body.push(<Text bold wrap="truncate-end">{head}</Text>)
      const gutter = Math.max(...v.window.map(w => String(w.n).length))
      // the cited lines wrapped, the value or the quoted passage lit; when they take many rows, less context around
      const hits = v.window.filter(w => w.hit)
      const hitRows = Math.max(3, Math.min(8, Math.floor(((e.props.scroll?.bodyRows || 20) - 12) / Math.max(1, hits.length))))
      const wraps = hits.some(w => w.text.length > cols - gutter - 3)
      const near = wraps ? 2 : 99
      const firstHit = v.window.findIndex(w => w.hit)
      const lastHit = v.window.length - 1 - [...v.window].reverse().findIndex(w => w.hit)
      const lines = v.window.filter((w, i) => w.hit || (i >= firstHit - near && i <= lastHit + near))
      body.push(<Box flexDirection="column">{lines.flatMap(w => (w.hit ? wrappedRows({ Text } as never, w, quote, gutter, cols, hitRows) : [lineRow({ Text } as never, w, gutter, cols)]))}</Box>)
      if (quote && status !== 'differs' && !hits.some(w => quoteSpan(w.text, quote))) body.push(<Text wrap="wrap"><Text dimColor>{'quoted: '}</Text><Text backgroundColor={COLORS.highlight} bold>{clip(quote, 600)}</Text></Text>)
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
      const color = run.state === 'verified' ? COLORS.ok : verifyFailed(run.state) ? COLORS.problem : COLORS.dim
      const words: Record<string, string> = {
        asked: `a subagent is writing ${run.script} …`,
        running: `running ${run.script} …`,
        missing: `✗ not written: ${run.stderr ? `the subagent ended without writing ${run.script}: ${clip(run.stderr, 200)}` : `there is no ${run.script}`}`,
        verified: `✓ the script recomputed ${run.result}, as cited`,
        refuted: `✗ the script recomputed ${run.result}, the reply cites ${run.expected}`,
        error: `✗ ${verifyError(run)}`,
      }
      body.push(<Text color={color} bold wrap="wrap">{words[run.state] ?? run.state}</Text>)
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

  // ---------------------------------------------------------------------------------------------- the menu

  // a right-click's menu: every action of the target, one row each, its hotkey first; Esc closes it
  on('ui.render', { component: 'Pane', requestId: MENU_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const t = await read($, menuA)
    if (!t) return <Text dimColor>Nothing selected.</Text>
    const items = menuItems(t)
    const cols = Math.max(20, e.props.bodyColumns)
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">{targetLabel(t, cols - 2)}</Text>
        {items.map((m, i) => (
          <Button
            key={`menu-${m.act}`}
            label={m.label}
            hotkey={m.hotkey}
            plain
            {...(i === 0 ? { autoFocus: true as const } : {})}
            onPress={async () => {
              await $.ui.close({ id: MENU_PANE })
              await act($, m.act, t)
            }}
          />
        ))}
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
    if (!t) return <Text dimColor>No side thread.</Text>
    const g = await ensureGuide($)
    const body: RenderElement[] = []
    body.push(paintLine(Text, [{ s: 'side thread about ', d: true }, ...linkSegs(t.label, { b: true })]))
    if (t.context) body.push(paintLine(Text, linkSegs(t.context.split('\n')[0] ?? '', { d: true })))
    body.push(<Text dimColor>{'─'.repeat(Math.min(cols, 80))}</Text>)
    let k = 0
    for (const turn of t.turns) {
      k++
      body.push(<Text color={COLORS.accent} bold wrap="wrap">{`› ${plainCites(turn.q)}`}</Text>)
      if (turn.state === 'running') {
        body.push(<Text dimColor wrap="truncate-end">{`working · ${turn.tools} tool call${turn.tools === 1 ? '' : 's'}${turn.partial ? ` · ${clip(turn.partial, cols - 30)}` : ''}`}</Text>)
      } else if (turn.state === 'error') {
        body.push(<Text color={COLORS.problem} wrap="wrap">{turn.a}</Text>)
      } else {
        body.push(<Box flexDirection="column">{await drawReply($, e, threadBody(turn.a), cols, `${t.id}:${k}`, `t${k}-`)}</Box>)
      }
      body.push(<Text> </Text>)
    }
    const last = t.turns.at(-1)
    const answered = t.turns.filter(x => x.state === 'done')
    const line = answered.length ? forMain(answered.at(-1)!.a) : ''
    if (line) body.push(paintLine(Text, linkSegs(`for main: ${line}`, { d: true })))
    body.push(
      <Input
        key="ask"
        {...(t.turns.length === 0 ? { autoFocus: true as const } : {})}
        label="ask"
        placeholder={t.turns.length ? 'a follow-up (Enter sends it to this thread)' : `ask about ${clip(plainCites(t.label), 40)} (Enter)`}
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
              const about = t.ref || clip(plainCites(t.label), 60)
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
    const views: { id: string; c: Citation; view: ChipView }[] = []
    for (const id of turn.ids) {
      const cl = claimMap.get(id)
      if (cl) views.push({ id, c: cl.c, view: await chipView($, cl) })
    }
    const bad = views.filter(x => x.view.state !== 'link').length
    const hoverId = await read($, hoverA)
    const hc = hoverId ? claimMap.get(hoverId) : undefined
    const hview = hc ? await chipView($, hc) : undefined
    // the readout row stays when nothing is hovered, so the band keeps its height and the transcript does not move
    const readout = hview ? paintLine(Text, [...chipSegs(hview, false), { s: `  ${hview.tip}`, d: true }]) : <Text> </Text>
    return (
      <Box flexDirection="column">
        {readout}
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          <Text bold>thimble-cc-mod</Text>
          <Text dimColor>{`${views.length} citation${views.length === 1 ? '' : 's'}`}</Text>
          {bad ? <Text color={COLORS.problem}>{`· ${bad} with a problem`}</Text> : null}
          <Text dimColor>·</Text>
          {views.slice(0, 9).map((x, i) => (
            <Button key={`c${i}`} label={`${cut(x.view.label, 14)}${x.view.mark}`} hotkey={String(i + 1)} plain onPress={() => void openCitation($, x.c, x.id)} />
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
    const c = id ? citeOf(id) : undefined
    if (!id || !c) return { text: `the last reply has ${turn?.ids.length ?? 0} citations` }
    await openCitation($, c, id)
    return { text: `opened ${citeLabel(c)}` }
  })

  on('command.run', { command: 'thimble-band' }, async $ => {
    const on_ = !(await read($, bandA))
    await $.state.set({ plugin: 'thimble-cc-mod', key: 'band' }, on_)
    await $.state.set({ plugin: 'thimble-cc-mod', key: 'hidden' }, '')
    return { text: `the citation band is ${on_ ? 'on (digits 1-9 in the empty prompt open a citation)' : 'off'}` }
  })

  on('command.run', { command: 'thimble-ask' }, async ($, e) => {
    const q = e.args.trim()
    const reply = lastReply
    const id = await openThread($, { label: 'the last answer', context: reply ? `The last answer in the main conversation:\n${clip(reply, 3000)}` : '' })
    if (q) void askThread($, id, q, await ensureGuide($))
    // the command's text holds the prompt while it runs, so the pane could not take the keys: once the prompt is
    // empty, its field takes them, so a follow-up typed next goes to this thread
    $.clock.after(250, () => {
      void (async () => {
        await $.ui.open({ id: THREAD_PANE, title: 'Side thread', focus: true, closeOnEscape: true }).catch(() => undefined)
        await $.ui.focus({ requestId: THREAD_PANE, key: 'ask' }).catch(() => undefined)
      })()
    })
    return { text: `side thread opened${q ? `: ${q}` : ''}` }
  })

  on('command.run', { command: 'thimble-cc-mod' }, async ($, e) => {
    await paths($)
    const [word, value = ''] = e.args.trim().split(/\s+/)
    if (word === 'debug') {
      if (value !== 'on' && value !== 'off') return { text: `the mouse log is ${debug ? 'on' : 'off'}: /thimble-cc-mod debug on|off` }
      try {
        await $.fs.write(`${cwd}/${DEBUG_FLAG}`, `${value}\n`)
      } catch (err) {
        return { text: `could not write ${DEBUG_FLAG}: ${String(err).slice(0, 160)}` }
      }
      debug = value === 'on'
      return { text: debug ? `the mouse log is on: ${cwd}/${HOME}/mouse.log` : 'the mouse log is off' }
    }
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
        `mouse log: ${debug ? `on (${HOME}/mouse.log)` : 'off (/thimble-cc-mod debug on)'}`,
      ].join('\n'),
    }
  })

  on('command.run', { command: 'thimble-check' }, async $ => {
    const turn = await read($, turnA)
    const cs = [...new Map((turn?.ids ?? []).map(id => citeOf(id)).filter((c): c is Citation => Boolean(c)).map(c => [c.raw, c])).values()]
    await check($, cs)
    const vs = await Promise.all(cs.map(async c => (await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value))
    const ok = vs.filter(v => v?.status === 'ok').length
    return { text: `${ok} of ${cs.length} citations resolve with their value` }
  })

  // a card by its place in the last reply (/thimble-card 2), or by the citation of it
  on('command.run', { command: 'thimble-card' }, async ($, e) => {
    const arg = e.args.trim().replace(/^\[\[|\]\]$/g, '').replace(/^card:/, '')
    const listed = lastCards
    const id = /^\d+$/.test(arg) ? listed[Number(arg) - 1] : arg || listed[0]
    const card = id ? await loadCard($, id) : null
    if (!id || !card) return { text: listed.length ? `the last reply has ${listed.length} card${listed.length === 1 ? '' : 's'}: /thimble-card 1 to ${listed.length}` : 'the last reply has no card' }
    await openCardPane($, id, '')
    return { text: `opened "${clip(card.question, 80)}"` }
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
        const tail = `${scriptOutput(run.stdout ?? '')}${run.stderr ? `\n${run.stderr}` : ''}`.trim().split('\n').slice(-8)
        body.push(<Text dimColor>{`output of the last run (exit ${run.exitCode})${tail.join('').trim() ? '' : ': nothing printed'}`}</Text>)
        if (tail.join('').trim()) body.push(<Box flexDirection="column">{tail.map(l => <Text wrap="truncate-end">{l || ' '}</Text>)}</Box>)
      }
      body.push(cardEl)
    } else {
      const cited = citedOnCard(picked, card.id)
      if (cited) body.push(<Text dimColor wrap="truncate-end">{`last cited: ${cited}`}</Text>)
    }
    return <Box flexDirection="column">{body}</Box>
  })
}

