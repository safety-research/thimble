// thimble-chat: a single-agent thimble inside Claude Code. No server, no browser.
//
// - Prompting: prompt/chat.md rides with the first prompt of a conversation as context (managed settings on this
//   machine bypass a user plugin's prompt.compose). It tells main to answer card shaped or report shaped, numbers from
//   code, every number cited.
// - Cards: main's Python writes a card with helper/tcard.py (.thimble-chat/cards/<id>.json); a reply line holding only
//   [[card:<id>]] is drawn as the card's panel there, between the reply's text, by the Client card.tsx. A card is one
//   of six typed specs; one that does not validate is drawn as an error, and a fix round corrects it. The helper
//   writes cards to the session's folder (THIMBLE_CHAT_ROOT, set at session.start), wherever the script runs.
// - Citations: every [[...]] of a reply is drawn as a link (para.tsx, cite.ts), red when helper/resolve.py finds the
//   ref missing or without its value. The citation panel shows the cited lines, highlighted.
// - Fix rounds: when a reply has red citations or a card that cannot be drawn, a forked subagent corrects them, out of
//   main's chat; each corrected passage is drawn in place, marked, and main is told in a note it reads but the analyst
//   does not see. A red citation shows a spinner while the fork works and a static marker when the fix failed.
// - Verification scripts: a forked subagent writes a standalone script that recomputes a cited value; the mod runs it
//   and marks the citation ✓ or ✗. The panel shows the script and its output.
// - Gestures (gestures.tsx): every target (card, mark, sentence, citation, row, record, node) takes the same clicks;
//   a right-click opens the menu of every action.
// - Side threads (threads.tsx): a subagent answers out of main's chat; its result is offered back as one line. Every
//   row a subagent of the mod causes in main's chat is drawn as one dim line.
// - Bash results: each output is saved (.thimble-chat/calls/<id>.json) and main is told its ref, so it can cite a line.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, ResolveInput } from 'claude-code'

import type { ChatAgent, ChatCorrection, ChatFixItem, ChatRun, ChatThread, ChatVerdict, ChatVerify } from '../types'
import { FAILED_MARK, applyCorrections, blockLayout, chipSegs, chipState, fixItems, fixPrompt, fixedCard, parseFix, settleFix, verifyMark } from './cite'
import type { ChipView, Problem } from './cite'
import { cardLayout, cut } from './draw'
import type { CardData, CardMeta } from './draw'
import { chipLabel, cid, citations, clip, embeddedCards, forMain, fromMod, needsDrawing, parseReply, scriptResult, sentenceOf, shownMatches, takeawayAfter, threadBody, validateCard, valueIn } from './lib'
import type { Citation } from './lib'
import { COLORS, paintLine, paintLines } from './paint'
import { cardOf, citationOf, citeText, menuItems, placeOf, targetLabel } from './gestures'
import type { Act, Gesture, PointerEv, Sent, Target } from './gestures'
import { AGENT_PREFIX, forkPrompt, freshPrompt, lastTurn, threadFile, withGuide } from './threads'

type Dollar = EngineInterface

const VERDICTS = { plugin: 'thimble-chat', key: 'verdicts' } as const
const VERIFY = { plugin: 'thimble-chat', key: 'verify' } as const
const RUNS = { plugin: 'thimble-chat', key: 'runs' } as const
const THREADS = { plugin: 'thimble-chat', key: 'threads' } as const
const ENDS = { plugin: 'thimble-chat', key: 'ends' } as const
const FIXES = { plugin: 'thimble-chat', key: 'fixes' } as const
const AGENTS = { plugin: 'thimble-chat', key: 'agents' } as const
const CORRECTIONS = { plugin: 'thimble-chat', key: 'corrections' } as const
const openA = atom({ plugin: 'thimble-chat', key: 'open' } as const, '')
const turnA = atom({ plugin: 'thimble-chat', key: 'turn' } as const, null)
const hiddenA = atom({ plugin: 'thimble-chat', key: 'hidden' } as const, '')
const correctionsA = atom(CORRECTIONS, [])
const paneCardA = atom({ plugin: 'thimble-chat', key: 'paneCard' } as const, '')
const paneModeA = atom({ plugin: 'thimble-chat', key: 'paneMode' } as const, '')
const pickedA = atom({ plugin: 'thimble-chat', key: 'picked' } as const, '')
const hoverA = atom({ plugin: 'thimble-chat', key: 'hover' } as const, '')
const bandA = atom({ plugin: 'thimble-chat', key: 'band' } as const, false)
const threadA = atom({ plugin: 'thimble-chat', key: 'thread' } as const, '')
const threadListA = atom({ plugin: 'thimble-chat', key: 'threadList' } as const, [])
const menuA = atom({ plugin: 'thimble-chat', key: 'menu' } as const, null)

const CITE_PANE = 'thimble-cite'
const CARD_PANE = 'thimble-card'
const THREAD_PANE = 'thimble-thread'
const MENU_PANE = 'thimble-menu'
const HOME = '.thimble-chat'
const CARD_MAX_COLS = 120
const GUIDE_MARK = '# thimble-chat\n'
const MOD_AGENT = new RegExp(`${AGENT_PREFIX} (side thread|fix of|verification of)`)
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
  debug = Boolean(await $.env.get('THIMBLE_CHAT_DEBUG'))
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

/** What is wrong with a reply, for a fix round: cards it embeds that cannot be drawn, citations that fail. */
async function problemsOf($: Dollar, text: string): Promise<Problem[]> {
  const out: Problem[] = []
  for (const id of embeddedCards(text)) {
    const f = await cardFile($, id)
    if (f.error) out.push({ card: id, why: f.error })
  }
  const cs = citations(text)
  remember(cs, text)
  await check($, cs)
  for (const c of cs) {
    const v = (await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value
    if (v?.status === 'missing') out.push({ cite: c, why: `does not resolve: ${v.why}` })
    else if (v?.status === 'differs') out.push({ cite: c, why: v.why })
  }
  return out
}

// ------------------------------------------------------------------------------------------------ the mod's subagents

/** Start a subagent of the mod: a fork of main, or where a fork is refused a general-purpose one given `fresh`. */
async function spawnSub($: Dollar, prompt: string, description: string, fresh: string): Promise<{ agentId: string; engine: string } | { deny: string }> {
  const desc = `${AGENT_PREFIX} ${description}`
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
    .catch((err: unknown) => $.ui.log(`thimble-chat: could not leave main a note: ${String(err).slice(0, 200)}`))
}

// ------------------------------------------------------------------------------------------------ fix rounds

function fixKey(it: ChatFixItem): string[] {
  return it.card ? [`card-${it.card}`] : it.cites.map(cid)
}

async function setFix($: Dollar, items: ChatFixItem[], state: string, why?: string): Promise<void> {
  for (const it of items) for (const id of fixKey(it)) await $.state.set({ ...FIXES, id }, why ? { state, why } : { state })
}

/** A reply's problems go to a forked subagent, out of main's chat; its citations spin until it answers. */
async function startFix($: Dollar, text: string, endRow: string): Promise<void> {
  const problems = await problemsOf($, text)
  if (!problems.length) return
  const items = fixItems(text, problems)
  await setFix($, items, 'fixing')
  const prompt = fixPrompt(items)
  const label = `fix of ${items.length} problem${items.length === 1 ? '' : 's'}`
  const r = await spawnSub($, prompt, label, withGuide(await ensureGuide($), `${prompt}\n\nThe reply:\n${text}`))
  if ('deny' in r) {
    await setFix($, items, 'failed', `could not start a subagent: ${r.deny}`)
    return
  }
  await $.state.set({ ...AGENTS, id: r.agentId }, { kind: 'fix', label, items, reply: text, endRow })
}

/** The fix round answered: each corrected passage that now checks is drawn in place; the others stay red, marked. */
async function fixComplete($: Dollar, a: ChatAgent, reason: string, answer: string): Promise<void> {
  const items = a.items ?? []
  const got = reason === 'answer' ? parseFix(answer, items.length) : items.map(() => ({ ok: false as const, why: `the fix ended: ${reason}` }))
  const fresh = got.flatMap(g => (g.ok ? citations(g.text) : []))
  for (const g of got) if (g.ok) remember(citations(g.text), g.text)
  await check($, fresh)
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
  const made: ChatCorrection[] = out.corrections.map(c => ({ ...c, at }))
  const notes = out.notes
  // a card's script may have changed values the reply cites
  const reply = applyCorrections(a.reply ?? '', made, false)
  const cs = citations(reply)
  remember(cs, reply)
  await check($, cs.filter(c => c.ref.startsWith('card:')))
  if (made.length) {
    const all = await update($, correctionsA, list => [...(list ?? []), ...made].slice(-200))
    await paths($)
    await $.fs.write(`${cwd}/${HOME}/corrections.json`, JSON.stringify(all, null, 1)).catch(() => undefined)
    const end = a.endRow ? (await $.state.get({ ...ENDS, id: a.endRow })).value : undefined
    if (end && a.endRow) {
      await $.state.set({ ...ENDS, id: a.endRow }, { ...end, ids: cs.map(c => cid(c.raw)) })
      try {
        const file = `${cwd}/${end.file}`
        await $.fs.write(file, applyCorrections(await $.fs.read(file), made, false))
      } catch {
        // the answer file keeps the reply as it was
      }
    }
    const turn = await read($, turnA)
    if (turn && turn.ids.some(id => fixKeysOf(items).has(id))) await $.state.set({ plugin: 'thimble-chat', key: 'turn' }, { ...turn, ids: cs.map(c => cid(c.raw)) })
  }
  if (notes.length) await noteMain($, ['thimble-chat checked your last reply, and a subagent worked on its problems; the analyst sees the result in place:', ...notes.map(n => `- ${n}`)].join('\n'))
}

function fixKeysOf(items: ChatFixItem[]): Set<string> {
  return new Set(items.flatMap(fixKey))
}

async function loadCorrections($: Dollar): Promise<void> {
  if ((await read($, correctionsA))?.length) return
  await paths($)
  try {
    const list = JSON.parse(await $.fs.read(`${cwd}/${HOME}/corrections.json`)) as ChatCorrection[]
    if (Array.isArray(list)) await $.state.set(CORRECTIONS, list.filter(c => typeof c?.old === 'string' && typeof c?.new === 'string'))
  } catch {
    // no corrections in this folder
  }
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
    `thimble-chat: the analyst asks for a verification script of ${c.raw} (${where}), from the sentence "${clip(sentence, 300)}"`,
    `Write it at ${script}, following "Verification scripts" in thimble-chat's guidance, run it once, and reply in one sentence with what it recomputed.`,
  ].join('\n')
}

/** A forked subagent writes the citation's verification script, out of main's chat; its end runs the script. */
async function askVerify($: Dollar, id: string): Promise<void> {
  const c = known.get(id)
  if (!c) return
  const v = (await $.state.get({ ...VERDICTS, id })).value
  const script = scriptPath(id)
  await $.state.set({ ...VERIFY, id }, { id, state: 'asked', script, expected: c.display })
  const prompt = verifyPrompt(c, v, replyOf.get(id) ?? '', script)
  const label = `verification of ${chipLabel(c)}`
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
    if (r.exitCode === 0 && result !== null && c) {
      await noteMain($, `thimble-chat: the verification script ${script} recomputed ${result} for ${c.raw}${expected === null ? '' : ok ? ', which matches' : `, not ${expected}`}.`)
    }
  } catch (err) {
    await $.state.set({ ...VERIFY, id }, { id, state: 'error', script, expected, source: source.slice(0, 9000), stderr: String(err).slice(0, 500) })
  }
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
      return 'script being written'
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
    $.ui.toast('this card has no script to run')
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
      env: { THIMBLE_CHAT_PARAMS: JSON.stringify(values), THIMBLE_CHAT_ONLY: `${card.source.index ?? 0}:${id}`, THIMBLE_CHAT_ROOT: cwd },
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
  const label = `side thread: ${clip(t.label, 40)}`
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
  // the ring moves from the question field to "offer to main", so its hotkey (m) works; a click or Tab reaches the field
  if (reason === 'answer' && forMain(text)) void $.ui.focus({ requestId: THREAD_PANE, key: 'main' }).catch(() => undefined)
  $.ui.toast(`the side thread on ${clip(t.label, 40)} answered`)
  return text
}

// ------------------------------------------------------------------------------------------------ chips

/** How a citation in the prompt is painted: as a link, like the reply's. */
function chipDecoration(raw: string, start = 0): { start: number; end: number; underline: boolean; color: string } {
  return { start, end: start + raw.length, underline: true, color: COLORS.link }
}

function fixWords(fix: { state: string; why?: string } | undefined): string {
  if (fix?.state === 'fixing') return 'being fixed…'
  if (fix?.state === 'failed') return `couldn't fix: ${fix.why ?? 'no reason given'}`
  return ''
}

/** A ref as the analyst reads it: a card's place by the card's question, never its id; any other place as written. */
function placeName(ref: string): string {
  const m = /^card:([A-Za-z0-9_-]+)(?:#(.*))?$/.exec(ref)
  if (!m) return ref
  const q = cards.get(m[1]!)?.data?.question
  const name = q ? `card "${clip(q, 40)}"` : 'a card'
  return m[2] ? `${name} · ${m[2]}` : name
}

async function chipView($: Dollar, c: Citation): Promise<{ view: ChipView; id: string }> {
  const id = cid(c.raw)
  const v = (await $.state.get({ ...VERDICTS, id })).value
  const run = (await $.state.get({ ...VERIFY, id })).value
  const fix = (await $.state.get({ ...FIXES, id })).value
  const state = chipState(v?.status, fix?.state)
  const tip = [placeName(c.ref), state === 'link' && v?.status !== 'ok' ? '' : v?.why, state === 'fixing' || state === 'failed' ? fixWords(fix) : '', verifyWords(run)].filter(Boolean).join(' · ')
  return { id, view: { label: chipLabel(c), state, mark: verifyMark(run?.state), tip } }
}

// ------------------------------------------------------------------------------------------------ drawing a reply

/** A reply's blocks as thimble-chat draws them: Markdown as the engine would, cards as panels, paragraphs that hold
 *  citations as chips. Interactive (Clients) on the terminal and desktop, static elsewhere. */
async function drawReply($: Dollar, e: ResolveInput, text: string, width: number, prefix = ''): Promise<RenderElement[]> {
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
        const more = fix?.state === 'fixing' ? ' · being fixed…' : fix?.state === 'failed' ? ` · ${FAILED_MARK}: ${fix.why ?? ''}` : ''
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
    for (const r of block.runs) {
      if (!r.cite) continue
      const { view, id } = await chipView($, r.cite)
      chips.push(view)
      ids.push(id)
      raws.push(r.cite.raw)
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

async function openCitation($: Dollar, c: Citation): Promise<void> {
  const id = cid(c.raw)
  remember([c])
  if (!(await $.state.get({ ...VERDICTS, id })).value) enqueue($, [c])
  await $.state.set({ plugin: 'thimble-chat', key: 'open' }, id)
  await openPane($, { id: CITE_PANE, title: 'Citation', focus: true, closeOnEscape: true, columns: 96, rows: 22 })
}

async function openCardPane($: Dollar, id: string, mode: string): Promise<void> {
  const card = await loadCard($, id)
  await $.state.set({ plugin: 'thimble-chat', key: 'paneCard' }, id)
  await $.state.set({ plugin: 'thimble-chat', key: 'paneMode' }, mode)
  await openPane($, { id: CARD_PANE, title: clip(card?.question ?? 'Card', 60), focus: true, closeOnEscape: true, columns: 100 })
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

/** One line of .thimble-chat/mouse.log (THIMBLE_CHAT_DEBUG=1): a press or release a Client saw, and what it made. */
async function logMouse($: Dollar, module: string, g: Sent): Promise<void> {
  await paths($)
  const ev: Partial<PointerEv> = g.ev ?? {}
  const mods = (['shift', 'ctrl', 'alt'] as const).filter(k => ev[k]).join('+') || 'none'
  mouseLog.push(
    JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), event: ev.type, button: ev.button, mods, gesture: g.gesture ?? 'none', target: g.target ? `${g.target.kind}: ${targetLabel(g.target)}` : '', module }),
  )
  try {
    await $.fs.write(`${cwd}/${HOME}/mouse.log`, `${mouseLog.slice(-500).join('\n')}\n`)
  } catch {
    // the log is best effort
  }
}

async function onGesture($: Dollar, g: Gesture, t: Target): Promise<void> {
  if (g === 'menu') await openMenu($, t)
  else if (g === 'cite') await act($, 'cite', t)
  else if (g === 'thread') await act($, 'thread', t)
  else if (g === 'primary') {
    const c = placeOf(t)
    if (c) await openCitation($, c)
  }
}

let menuWatch: { cancel: () => void } | null = null

/** Open the menu of a target. The target stays in state while the menu is open, so the reply lights it (drawReply hands
 *  it to each Client as `menu`), and is cleared once the menu closes, by a choice or Esc. */
async function openMenu($: Dollar, t: Target): Promise<void> {
  await $.state.set({ plugin: 'thimble-chat', key: 'menu' }, t)
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
      await $.state.set({ plugin: 'thimble-chat', key: 'menu' }, null)
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
    return citationContext($, cid(c.raw))
  }
  if (t.kind === 'sentence' || !c) {
    const s = (t.text ?? '').trim()
    return { label: `the passage "${clip(s, 48)}"`, context: s ? `The passage of the reply: "${clip(s, 1500)}"` : '' }
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
      if (c) await openCitation($, c)
      return
    }
    case 'cite': {
      const text = citeText(t)
      if (!text) return
      await $.prompt.fill({ text: `${text} `, mode: 'insert', decorations: text.startsWith('[[') ? [chipDecoration(text)] : [] })
      if (text.startsWith('[[')) await $.state.set({ plugin: 'thimble-chat', key: 'picked' }, text)
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
      await askVerify($, id)
      // a mark has no chip of its own to show the outcome: the citation panel does
      if (t.kind !== 'citation') await openCitation($, c)
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

// ------------------------------------------------------------------------------------------------ register

export const register: Register = on => {
  let turnText: string[] = []
  let turnRows: string[] = [] // the uuids of this turn's text rows in main
  let turnPrompt = ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await ensureGuide($)
    // the card helper writes cards here, wherever a script runs: every Bash command and process started after inherits it
    await $.env.set('THIMBLE_CHAT_ROOT', cwd).catch((err: unknown) => $.ui.log(`thimble-chat: could not set THIMBLE_CHAT_ROOT: ${String(err).slice(0, 120)}`))
    await loadCorrections($)
    $.clock.every(150, () => void flushQueue($))
    await $.command.register({ name: 'thimble-card', description: 'Open a card of the last reply in a pane: /thimble-card <n>' })
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
      if (embeddedCards(text).length) lastCards = embeddedCards(text)
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
    // a subagent of the mod that ends with a notification to main: main would answer it in its chat
    if (e.origin.kind === 'task-notification') {
      const mine = (await $.agent.list().catch(() => [])).filter(a => a.spawnedBy === 'thimble-chat')
      if (mine.some(a => e.text.includes(a.id))) return { drop: 'thimble-chat: a subagent of the mod finished' }
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
    if (cardsOf.length) lastCards = cardsOf
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
    // a card that cannot be drawn or a citation that fails goes to a fix round, out of main's chat
    if (text.trim() && !fromMod(turnPrompt)) await startFix($, text, turnRows.at(-1) ?? '')
    return done
  })

  // ---------------------------------------------------------------------------------------------- the reply

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const end = (await $.state.get({ ...ENDS, id: e.requestId })).value
    if (!needsDrawing(e.props.text) && !end) return next(e)
    const text = applyCorrections(e.props.text, (await read($, correctionsA)) ?? [])
    const cs = citations(text)
    remember(cs, text)
    const unchecked: Citation[] = []
    for (const c of cs) if (!(await $.state.get({ ...VERDICTS, id: cid(c.raw) })).value) unchecked.push(c)
    if (unchecked.length) enqueue($, unchecked)
    const { Box, Text } = $.ui.resolve(e)
    const out = await drawReply($, e, text, (e.viewport?.columns ?? 100) - 4)
    if (end) {
      // one dim line under the answer: its citations and cards, where it is saved, and the problems left
      const left = { problem: 0, fixing: 0, failed: 0, link: 0 }
      for (const id of end.ids) {
        const v = (await $.state.get({ ...VERDICTS, id })).value
        const f = (await $.state.get({ ...FIXES, id })).value
        left[chipState(v?.status, f?.state)]++
      }
      const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
      out.push(
        <Box marginTop={1}>
          <Text wrap="truncate-end">
            <Text dimColor>{[plural(end.ids.length, 'citation'), ...(end.cards.length ? [plural(end.cards.length, 'card')] : []), `saved as ${end.file}`].join(' · ')}</Text>
            {left.fixing ? <Text dimColor>{` · fixing ${left.fixing}…`}</Text> : null}
            {left.problem ? <Text color={COLORS.problem}>{` · ${plural(left.problem, 'problem')}`}</Text> : null}
            {left.failed ? <Text color={COLORS.problem}>{` · ${left.failed} couldn't be fixed`}</Text> : null}
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
    return <Text dimColor wrap="truncate-end">{`› ${AGENT_PREFIX}: ${a?.label ?? 'a subagent'} finished`}</Text>
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
        if (g.gesture && g.target) await onGesture($, g.gesture, g.target)
      }
    } else if (debug && (d.ev || d.type === 'act' || d.type === 'param')) {
      await paths($)
      mouseLog.push(JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), module: e.module, ...d }))
      await $.fs.write(`${cwd}/${HOME}/mouse.log`, `${mouseLog.slice(-500).join('\n')}\n`)
    }
    if (d.type === 'pointer' || d.type === 'gesture') return next(e)
    if (d.type === 'hover') {
      await $.state.set({ plugin: 'thimble-chat', key: 'hover' }, typeof d.id === 'string' ? d.id : '')
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
    const id = await read($, openA)
    const v = id ? (await $.state.get({ ...VERDICTS, id })).value : undefined
    // after a reload the module's map is empty; the verdict in state still holds the citation
    const c = id ? (known.get(id) ?? (v ? { raw: v.raw, ref: v.ref, display: v.display } : undefined)) : undefined
    const cols = Math.max(30, e.props.bodyColumns)
    if (!c) return <Text dimColor>No citation open.</Text>
    const run = (await $.state.get({ ...VERIFY, id })).value
    const fix = (await $.state.get({ ...FIXES, id })).value
    const status = v?.status ?? 'pending'
    const state = chipState(status, fix?.state)
    const body: RenderElement[] = []
    body.push(paintLine(Text, [...chipSegs({ label: chipLabel(c), state, mark: verifyMark(run?.state), tip: '' }, false), { s: `  ${STATUS_WORDS[status] ?? status}` }]))
    body.push(<Text dimColor wrap="truncate-end">{clip(c.ref.startsWith('card:') ? placeName(c.ref) : c.raw, cols)}</Text>)
    if (v?.why) body.push(<Text color={state === 'link' ? COLORS.dim : COLORS.problem} wrap="truncate-end">{clip(v.why, cols)}</Text>)
    if (state === 'fixing' || state === 'failed') body.push(<Text color={COLORS.problem} wrap="wrap">{fixWords(fix)}</Text>)
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
      const color = run.state === 'verified' ? COLORS.ok : run.state === 'refuted' || run.state === 'error' ? COLORS.problem : COLORS.dim
      const words: Record<string, string> = {
        asked: `a subagent is writing ${run.script} …`,
        running: `running ${run.script} …`,
        missing: `${run.script} was not written${run.stderr ? `: ${clip(run.stderr, 200)}` : ''}`,
        verified: `✓ the script recomputed ${run.result}, as cited`,
        refuted: `✗ the script recomputed ${run.result}, the reply cites ${run.expected}`,
        error: run.exitCode === undefined && run.stderr && !run.source ? run.stderr : `the script ${run.exitCode ? `exited with ${run.exitCode}` : 'printed no RESULT line'}`,
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
        body.push(<Text color={COLORS.problem} wrap="wrap">{turn.a}</Text>)
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
    const views: { id: string; c: Citation; view: ChipView }[] = []
    for (const id of turn.ids) {
      const c = known.get(id)
      if (c) views.push({ id, c, view: (await chipView($, c)).view })
    }
    const bad = views.filter(x => x.view.state !== 'link').length
    const hoverId = await read($, hoverA)
    const hc = hoverId ? known.get(hoverId) : undefined
    const hview = hc ? (await chipView($, hc)).view : undefined
    // the readout row stays when nothing is hovered, so the band keeps its height and the transcript does not move
    const readout = hview ? paintLine(Text, [...chipSegs(hview, false), { s: `  ${hview.tip}`, d: true }]) : <Text> </Text>
    return (
      <Box flexDirection="column">
        {readout}
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          <Text bold>thimble-chat</Text>
          <Text dimColor>{`${views.length} citation${views.length === 1 ? '' : 's'}`}</Text>
          {bad ? <Text color={COLORS.problem}>{`· ${bad} with a problem`}</Text> : null}
          <Text dimColor>·</Text>
          {views.slice(0, 9).map((x, i) => (
            <Button key={`c${i}`} label={`${cut(x.view.label, 14)}${x.view.mark}`} hotkey={String(i + 1)} plain onPress={() => void openCitation($, x.c)} />
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
        body.push(<Text dimColor>{`output of the last run (exit ${run.exitCode})`}</Text>)
        const tail = `${run.stdout ?? ''}${run.stderr ? `\n${run.stderr}` : ''}`.trim().split('\n').slice(-8)
        body.push(<Box flexDirection="column">{tail.map(l => <Text wrap="truncate-end">{l || ' '}</Text>)}</Box>)
      }
      body.push(cardEl)
    } else {
      if (picked) body.push(<Text dimColor wrap="truncate-end">{`last cited: ${picked}`}</Text>)
    }
    return <Box flexDirection="column">{body}</Box>
  })
}

