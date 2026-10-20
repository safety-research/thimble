// The observer: thimble's always-on, quiet part. It reads each answer and the objects behind it once, after the
// turn, and most of what it finds goes to Claude, not to the person. Modeled on Claude Code's "you should know" (YSK),
// with Claude Code's own UI only: the band above the prompt, and the hint row the shell draws under each object.
//
// When it looks: after a turn of main that answered, once the answer exists, when the turn did work (it ran a tool,
// saved an object, or wrote a long answer), or when the person's message states a decision (they will tell, send,
// share or choose something), or when the answer drifted from the question. A look never runs mid-turn and never
// delays one. It looks only where a person is (the shell's personHere): never in a `-p` run, and in a session of
// Claude Code's background service only once the person's first prompt came.
//
// One look, in order:
// 1. The question step (registry feature `question`): one small completion, with no transcript, compares the answer
//    with the person's literal question and says whether their message states a decision. Its result is evidence.
//    A turn the person did not type (a verb's ask such as v's, a notification) has no question of theirs to drift
//    from and states no decision: the step does not run, the pass reads that turn's own prompt, and the decision
//    the person stated last stays in view.
// 2. The evidence (evidence.js): the objects Claude saved since the last look (and, for context, its latest ones),
//    each with its lineage in a few lines and, for the new ones, the object as the person sees it (how many rows stand
//    behind each cited value, how sure each query's row lineage is, the files the session never read, what Claude
//    declared, the problems `thimble save` found) and the verbs that can act on it; and `thimble coverage` for the session.
// 3. The pass: one call that composes the enabled lenses (lenses/index.mjs; compose.mjs). Each lens is a folder with
//    its output shape, its digest of the state and its merge into the store, and its prompt fragment in the registry
//    (prompts/lens-<name>/): notes to Claude, the rare line, the lit actions, where the answer stands on squeeze's
//    chips, explain marks, and the turn's claims with what each means. The system prompt is the frame (registry
//    feature `observer`) with the lenses' fragments, which the prompt cache serves; the message is the new turn (the
//    person's prompt, Claude's words and tool calls cut to fit, the answer), its objects, and each lens's digest. It
//    never reads the session before the turn. `observer:v1` is the earlier pass: one prompt in a fork of the session.
//    Every call is a line in the session's events (telemetry), with each lens's share of the pass.
//    Order with squeeze: an answer arrives as Claude wrote it. A step the person makes on Report ↔ Interpret or
//    Familiarity before the pass has said where the answer stands waits for the look (lookPending) and counts from the
//    level it gives.
// A lens turned off (THIMBLE_PROMPTS=lens-explain:off) is neither asked nor merged.
//
// Where its output goes:
// - notes: beside the next prompt of main, whatever sent it (the person, a verb's ask, a notification), as context the
//   person never sees. Once each: a prompt that never entered gives them back. Deduplicated across the session.
// - a line: the band above the prompt, only when the line names a decision in view, no line is open, the backoff
//   allows it, it repeats nothing the person saw or knows, and no new turn began. Otherwise its finding goes to
//   Claude as a note (a repeat goes nowhere). Keys, as YSK's: 1 Learn more (the explanation, written already),
//   2 Know this already (never raised again), 3 Send to main (fills the prompt with "Here is a note offered by a side
//   agent: ..."), 0 Not now. A line nobody answers clears at the second next prompt; a line the session has settled
//   closes at the next look.
// - hints: the shell's hint row under each object (shell/object.js rankRow), in place of its own rule, once the
//   look is done; a ranking that comes while a turn runs waits for that turn's end.
// - claims: into the session's Claims (thimble/claims/<session>.json, CONTRACT 7) by verbs/claims/claims.js: placed
//   by their words in the turn's messages, with the citations near them; c lights under the answer with how many are
//   new. A look that fails is noted there, so the list says which turn was not read, and kept, so it runs again when
//   the Claims pane opens (readAgain).
// Memory and backoff, as YSK's: the last 50 lines shown and every known line are kept in the plugin's store and go
// to the fork; code drops a repeat. After more than two lines typed past in a row, the next 2^(n-3) looks (at most
// 16) give notes but no line.
// Off: /observe off, or the Observer row in /config. /observe says what it did; /observe demo shows a sample line.
// It registers no model tool, answers no permission request, starts no `claude` and runs only `thimble coverage`.
import type { EngineInterface, Register } from 'claude-code'

import type { ObjRef, ObserverLine, Ranking } from '../types'
import { answerRow, applyObserver, claimsStore, drawnTextOf, leanEnv, messageRecord, personHere, saveClaims, setVerb, turnPlaces } from '../shell/shell'
import { glossesOf } from '../shell/message.js'
import { applyTurn, basedOnFrom, clearGap, grownClusters, grownLines, noteFor, noteGap, promptLines } from '../verbs/claims/claims.js'
import { promptText, promptTextAt, shadowVersions } from '../prompts/prompts'
import { FEATURES, fillBlocks } from '../prompts/registry.mjs'
import { record, tracked } from '../telemetry/telemetry'
import { composeSystem, composeTurn, sharesOf } from './compose.mjs'
import { digest, isRepeat, jsonIn, parseAnswer } from './evidence.js'
import { LENSES } from './lenses/index.mjs'
import { stepsOf, turnWords } from './turn.mjs'
import { sessionKey } from '../hooks/conversation'
import { modelWhy } from '../shell/why.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Note = { note: string; rests_on?: string; from: 'observer' | 'line' }
type Answer = {
  notes: { note: string; rests_on?: string }[]
  line: { line: string; decision: string; title: string; explanation: string; rests_on: string } | null
  settled: boolean
  hints: Record<string, unknown>
  verbs: Record<string, unknown>
  glosses: unknown[]
  claims: unknown[]
  clusters: unknown[]
}
// question: the turn's own prompt; typed: whether the person wrote it (else a verb, named in `verb`, or a notification
// sent it); earlier: the person's questions before it
type Look = { turnId: string; turnNo: number; steps: number; tools: number; answer: string; question: string; typed: boolean; verb: string; earlier: string[]; since: number }
type TurnPrompt = { text: string; typed: boolean; verb: string }
// where a turn's claims were said (the shell's turnPlaces), and its answer's row
type Places = Awaited<ReturnType<typeof turnPlaces>>
type Again = { row: string | null; tp: Places | null }
// a look whose call failed, kept so it can run again: its turn, the look, and where its turn's words are
type Failed = { turn: number; look: Look; again: Again; why: string }

const LINE = { plugin: 'thimble', key: 'line' } as const
const RANKED = { plugin: 'thimble', key: 'ranked' } as const
const LAST = { plugin: 'thimble', key: 'last' } as const
const TRAY = { plugin: 'thimble', key: 'tray' } as const

const KEEP = 50 // lines shown and known, remembered, as YSK
const CLEAR_AFTER_PROMPTS = 2 // an unanswered line clears at the second next prompt, as YSK
const MAX_SKIP = 16
const TYPED_PAST_FREE = 2
export const skipsFor = (n: number) => (n <= TYPED_PAST_FREE ? 0 : Math.min(MAX_SKIP, 2 ** (n - TYPED_PAST_FREE - 1)))
const LONG_ANSWER = 800 // characters: a turn that ran no tool is substantial when its answer is this long
const CONTEXT_OBJECTS = 4 // objects the fork reads: every new one, then the latest older ones up to this many
const STEPS_BUDGET = 24000 // characters of the turn's words and tool calls the pass reads, the latest calls kept longest
const NOTE_HEAD = 'Here is a note offered by a side agent:'
const K = {
  seen: 'observer.seen', known: 'observer.known', typedPast: 'observer.typedPastInARow', skip: 'observer.looksToSkip', off: 'observer.off',
  // glosses: the terms the person saw explained (never glossed again), looks whose glosses nobody opened, looks to skip
  glossed: 'observer.glossed', glossUnopened: 'observer.glossUnopened', glossSkip: 'observer.glossSkip',
}
const GLOSSED_KEEP = 100
const GLOSS_FREE = 2 // looks whose glosses nobody opened before glosses back off
export const glossSkipsFor = (n: number) => (n <= GLOSS_FREE ? 0 : Math.min(8, 2 ** (n - GLOSS_FREE - 1)))
const ROWVERBS = { plugin: 'thimble', key: 'rowverbs' } as const
const REREAD = { plugin: 'thimble', key: 'reread' } as const
const KEEP_FAILED = 5 // failed looks kept to read again

const S = {
  session: '',
  file: '',
  enabled: true,
  model: '',
  turnId: '',
  turnNo: 0,
  steps: 0,
  tools: 0,
  turnStart: 0,
  running: false,
  since: 0, // when the first turn the observer has not looked at began: objects saved after it are new
  prompt: { text: '', typed: true, verb: '' } as TurnPrompt, // the prompt of the turn that runs or ran last
  questions: [] as string[], // the person's own questions, in order
  decision: '', // the decision the person stated last, which a turn they did not type keeps in view
  notesGiven: [] as string[],
  pending: [] as Note[],
  looking: false,
  again: null as Look | null,
  deferred: [] as { id: string; ranking: Ranking }[],
  hints: {} as Record<string, Ranking>,
  log: [] as Record<string, unknown>[],
  failed: [] as Failed[],
}

// the looks to come and the one running: a promise that settles when the last of them has ended, so a squeeze step
// that needs the levels a look gives can wait for them (verbs/squeeze/term.ts)
let pendingLook: { promise: Promise<void>; settle: () => void } | null = null
function lookAhead(): void {
  if (pendingLook) return
  let settle = () => {}
  const promise = new Promise<void>(done => { settle = done })
  pendingLook = { promise, settle }
}
function lookEnded(): void {
  const p = pendingLook
  pendingLook = null
  p?.settle()
}
/** While a look is on its way or running: a promise that settles when it has merged its lenses (or ended); else null. */
export function lookPending(): Promise<void> | null {
  return pendingLook?.promise ?? null
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
const num = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0)
const bullets = (xs: string[]) => (xs.length ? xs.map(x => `- ${x}`).join('\n') : '(none)')
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120) || 'none'
const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…')

/** The session and its file, read again after a reload (which keeps the session, not this memory). The prompts come
 *  from the registry (prompts/prompts.ts), at each look. */
async function ensure($: Engine): Promise<void> {
  const id = await sessionKey($)
  if (id !== S.session) {
    S.session = id
    const home = (await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`
    S.file = `${home.replace(/\/+$/, '')}/lean/observer/${safe(id)}.json`
    try {
      if (await $.fs.exists(S.file)) {
        const kept = JSON.parse(String(await $.fs.read(S.file)))
        S.hints = kept.hints && typeof kept.hints === 'object' ? kept.hints : {}
        S.log = Array.isArray(kept.log) ? kept.log : []
        S.notesGiven = strs(kept.notesGiven)
        // the looks whose call failed, which the Claims pane reads again
        S.failed = Array.isArray(kept.failed) ? kept.failed.filter((f: Any) => f && typeof f.turn === 'number' && f.look && typeof f.look.turnId === 'string') : []
        // a reload mid-session: the notes not yet delivered wait again, and the person's questions come back
        const delivered = new Set(S.log.filter(r => r.kind === 'notes_delivered').flatMap(r => strs(r.notes)))
        const added = S.log.filter(r => r.kind === 'look').flatMap(r => (Array.isArray(r.notes_added) ? (r.notes_added as Note[]) : []))
        S.pending = added.filter(n => n && typeof n.note === 'string' && !delivered.has(n.note))
        const typed = S.log.filter(r => r.kind === 'look' && typeof r.question === 'string' && r.typed !== false)
        S.questions = typed.map(r => String(r.question)).slice(-20)
        const said = (typed.at(-1)?.question_step as Any)?.out?.decision
        S.decision = typeof said === 'string' ? said.trim() : ''
      }
    } catch {
      // a file it cannot read: the observer starts this session's memory again
    }
  }
}

/** The session's file: the rankings (so a resumed session draws them again), the notes given, and every look, key and
 *  delivery, with the usage of each call. */
async function save($: Engine): Promise<void> {
  if (!S.file) return
  try {
    await $.fs.write(S.file, JSON.stringify({ hints: S.hints, notesGiven: S.notesGiven.slice(-200), log: S.log.slice(-400), failed: S.failed.slice(-KEEP_FAILED) }, null, 1))
  } catch {
    // the file is memory for a resume and a record for measuring; the observer works without it
  }
}

async function logRow($: Engine, row: Record<string, unknown>): Promise<void> {
  S.log.push({ at: new Date(await $.clock.now()).toISOString(), ...row })
  await save($)
}

async function isOn($: Engine): Promise<boolean> {
  return S.enabled && (await $.store.get(K.off)) !== true
}

// ------------------------------------------------------------------------------------------------ the line

async function openLine($: Engine): Promise<ObserverLine | null> {
  return ((await $.state.get(LINE)).value ?? null) as ObserverLine | null
}

async function closeLine($: Engine): Promise<void> {
  await $.state.set(LINE, null)
}

/** A key answered the line: the person engaged, so the run of lines typed past ends (YSK resets it on any answer). */
async function answered($: Engine): Promise<void> {
  await $.store.set(K.typedPast, 0)
  await $.store.set(K.skip, 0)
}

async function markKnown($: Engine, line: string): Promise<void> {
  const known = strs(await $.store.get(K.known))
  if (!isRepeat(line, known)) await $.store.set(K.known, [...known, line].slice(-KEEP))
}

export function noteForMain(v: Pick<ObserverLine, 'line' | 'title' | 'explanation'>): string {
  const body = [`Heads up · ${v.line}`, '', `**${v.title}**`, ...String(v.explanation || '').split('\n')]
  return `${NOTE_HEAD}\n\n${body.map(l => (l === '' ? '>' : `> ${l}`)).join('\n')}`
}

let sending = false
async function sendToMain($: Engine, v: ObserverLine): Promise<void> {
  if (sending) return
  sending = true
  try {
    const box = await $.prompt.read().catch(() => undefined)
    if (box && String(box.text || '').trim() !== '') {
      $.ui.toast('Your prompt has text in it. Send or clear it, then press the key again.')
      return
    }
    const r = await $.prompt.fill({ text: `${noteForMain(v)}\n\n`, mode: 'replace' }).catch(() => undefined)
    if (r && r.isFilled) {
      await markKnown($, v.line)
      await answered($)
      await closeLine($)
      await logRow($, { kind: 'key', key: 'send_to_main', line: v.line })
      return
    }
    $.ui.toast(r && r.refusal === 'dialog' ? 'A dialog has the keyboard. Answer it, then press the key again.' : "The prompt didn't take the note. Press the key again.")
  } finally {
    sending = false
  }
}

// ------------------------------------------------------------------------------------------------ what it reads

/** The turn's words: the assistant texts after the person's last prompt, when the turn's answer is empty. */
async function answerOf($: Engine, fallback: string): Promise<string> {
  if (fallback.trim()) return fallback
  const msgs = (await $.session.messages()) as Any[]
  const texts: string[] = []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'user' && !(m.toolResults && m.toolResults.length)) break
    if (m.role === 'assistant' && m.text && String(m.text).trim()) texts.unshift(String(m.text))
  }
  return texts.join('\n\n')
}

async function questionStep($: Engine, question: string, answer: string, turn: number, earlier: string[]): Promise<Record<string, unknown>> {
  const q = await promptText($, 'question')
  // the step's instructions come before the turn's words, so the next turn's step reads them from the prompt cache
  const prompt = fillBlocks(q.text, {
    EARLIER: () => bullets(earlier.slice(-6).map(x => cut(x, 600))),
    QUESTION: () => cut(question, 4000) || '(none)',
    ANSWER: () => cut(answer, 16000),
  })
  const t0 = await $.clock.now()
  const model = S.model || 'opus'
  // a comparison of two texts, not an analysis: low effort, so its thinking stays short
  const r = await tracked($, { feature: 'question', prompt: q.id, model, extra: { turn } }, () => $.model.complete({ model, prompt, maxTokens: 2000, effort: 'low' }))
  const ms = (await $.clock.now()) - t0
  if (!r.isAnswered) return { ms, error: r.reason, usage: r.usage, prompt: q.id }
  const out = jsonIn(r.text)
  return { ms, usage: r.usage, out, prompt: q.id, ...(out ? {} : { raw: cut(r.text, 2000) }) }
}

/** The folder under analysis: where the latest object is, else THIMBLE_ROOT, else the nearest folder at or above the
 *  session's that holds thimble/objects. */
async function rootNow($: Engine): Promise<string | null> {
  const last = (await $.state.get(LAST)).value as ObjRef | null | undefined
  if (last?.root) return last.root
  const env = await $.env.get('THIMBLE_ROOT')
  if (env) return env
  let d = String(await $.session.cwd()).replace(/\/+$/, '')
  while (d) {
    if (await $.fs.exists(`${d}/thimble/objects`)) return d
    d = d.slice(0, d.lastIndexOf('/'))
  }
  return null
}

type Seen = { object: Any; ref: ObjRef; isNew: boolean }

/** The objects Claude saved in this session: those saved since `since` (new), then the latest older ones, up to
 *  CONTEXT_OBJECTS in all (every new one is kept), each slimmed to what the digest reads. A Node child reads them
 *  (node/objects.mjs), so an object of megabytes is read too. Objects a verb the person pressed made are not Claude's. */
async function objectsNow($: Engine, root: string, since: number): Promise<Seen[]> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  const r = await $.process.run(['node', '--permission', `--allow-fs-read=${dir}`, `--allow-fs-read=${root}/thimble`, `${dir}/observer/node/objects.mjs`, root, S.session], { timeoutMs: 60000 })
  let list: Any[] = []
  try { list = r.exitCode === 0 ? JSON.parse(r.stdout) : [] } catch { list = [] }
  const mine: Seen[] = []
  for (const o of Array.isArray(list) ? list : []) {
    if (!o || o.session !== S.session) continue
    const t = Date.parse(String(o.updated || o.created || ''))
    mine.push({ object: o, ref: { id: String(o.id), v: Number(o.version) || null, root }, isNew: !!since && t >= since - 2000 })
  }
  const fresh = mine.filter(x => x.isNew)
  return [...fresh, ...mine.filter(x => !x.isNew).slice(0, Math.max(0, CONTEXT_OBJECTS - fresh.length))]
}

async function coverageNow($: Engine, root: string): Promise<string> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  try {
    const r = await $.process.run([`${dir}/bin/thimble`, 'coverage'], { cwd: root, env: { THIMBLE_ROOT: root, THIMBLE_SESSION: S.session }, timeoutMs: 90000 })
    return r.exitCode === 0 ? cut(r.stdout.trim(), 2400) : `(thimble coverage failed: ${cut((r.stderr || r.stdout).trim(), 200)})`
  } catch (err) {
    return `(thimble coverage failed: ${cut(String((err as Error)?.message || err), 200)})`
  }
}

// ------------------------------------------------------------------------------------------------ the look

async function applyRanking($: Engine, id: string, ranking: Ranking): Promise<void> {
  S.hints[id] = ranking
  await $.state.set({ ...RANKED, id }, ranking)
}

/** Rankings that came while a turn ran: shown now that it has ended. */
async function flushDeferred($: Engine): Promise<void> {
  const list = S.deferred
  S.deferred = []
  for (const d of list) await applyRanking($, d.id, d.ranking)
  if (list.length) await save($)
}

/** The session's messages up to a turn's answer: what a look read when it ran, for a look that runs again later. */
function upTo(msgs: Any[], answer: string): Any[] {
  const a = answer.trim()
  if (!a) return msgs
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m?.role === 'assistant' && String(m.text || '').trim() && (String(m.text).trim() === a || a.endsWith(String(m.text).trim()))) return msgs.slice(0, i + 1)
  }
  return msgs
}

/** One look at a turn. `again`: a look that failed, run again (by readAgain) after later turns: it reads that turn's
 *  messages and places its claims and verbs where that turn's answer is. */
async function look($: Engine, t: Look, again: Again | null = null): Promise<void> {
  if (S.looking) {
    // looks never overlap: the latest turn waits for the one running (a look run again stays kept for the next time)
    if (!again) S.again = t
    return
  }
  S.looking = true
  const row: Record<string, unknown> = { kind: 'look', turn: t.turnNo, steps: t.steps, tools: t.tools, ...(again ? { again: true } : {}) }
  try {
    await ensure($)
    const answer = await answerOf($, t.answer)
    if (!answer.trim()) {
      row.skip = 'no answer'
      return
    }
    row.question = cut(t.question, 400)
    if (!t.typed) Object.assign(row, { typed: false, ...(t.verb ? { verb: t.verb } : {}) })

    // 1. the question step: drift and a decision in view. A prompt the person did not type is no question of theirs:
    // no step, and the decision they stated last stays in view
    const q: Record<string, unknown> = t.typed ? await questionStep($, t.question, answer, t.turnNo, t.earlier) : { skipped: t.verb ? `the verb ${t.verb} sent the prompt` : 'the person did not type the prompt' }
    row.question_step = q
    const qo = (q.out ?? null) as Any
    const drift = qo && typeof qo.drift === 'string' && qo.drift.trim() ? qo.drift.trim() : ''
    const stated = qo && typeof qo.decision === 'string' && qo.decision.trim() ? qo.decision.trim() : ''
    if (t.typed && !again) S.decision = stated
    const decision = t.typed ? stated : S.decision

    // 2. the objects and their lineage
    const root = await rootNow($)
    const objs = root ? await objectsNow($, root, t.since) : []
    const fresh = objs.filter(x => x.isNew)
    row.objects = objs.map(x => `${x.ref.id}@${x.ref.v}${x.isNew ? ' new' : ''}`)
    const substantial = t.tools > 0 || answer.length >= LONG_ANSWER || fresh.length > 0
    if (!substantial && !stated && !drift) {
      row.skip = 'no work, no decision, no drift'
      return
    }
    row.why = [substantial ? 'work' : '', stated ? 'decision' : '', drift ? 'drift' : ''].filter(Boolean).join(', ')
    const digests: string[] = []
    for (const x of objs) {
      const drawn = x.isNew ? await drawnTextOf($, x.ref).catch(err => `(the person cannot see it: it does not draw: ${cut(String((err as Error)?.message || err), 160)})`) : ''
      digests.push(digest(x.object, { isNew: x.isNew, drawn }))
    }
    const coverage = root ? await coverageNow($, root) : '(no thimble/ folder: nothing was read through thimble)'

    // 3. the pass: the state each lens needs, the lenses enabled, one call
    const seen = strs(await $.store.get(K.seen))
    const known = strs(await $.store.get(K.known))
    const open = await openLine($)
    const skips = Math.min(MAX_SKIP, num(await $.store.get(K.skip)))
    const glossed = strs(await $.store.get(K.glossed))
    const glossSkip = Math.min(8, num(await $.store.get(K.glossSkip)))
    const inRow = ((await $.state.get(ROWVERBS)).value ?? []) as { key: string; name: string }[]
    // the session's claims so far, which the claims lens adds this turn's to (CONTRACT 7)
    const store = await claimsStore($)
    const grown = grownClusters(store)
    const all = (await $.session.messages().catch(() => [])) as Any[]
    const msgs = again ? upTo(all, answer) : all
    // the turn's words (the person's message and Claude's words, no tool output): what the claims lens's digest and its
    // quiet rule read
    const turnText = turnWords(msgs, t.question)
    const st = { seen, known, notesGiven: S.notesGiven, open, skips, glossed, glossSkip, store, grown, turnText }
    const qText = !t.typed
      ? t.verb
        ? `(no comparison this turn: the person pressed the verb ${t.verb}, and thimble sent the prompt below for them)`
        : '(no comparison this turn: the person did not type the prompt below)'
      : q.out
        ? drift
          ? `A part is missing or replaced: ${drift}`
          : 'The answer gives every part of the question.'
        : '(the step gave no result)'
    const frame = await promptText($, 'observer')
    const mode = FEATURES.observer.versions?.[frame.version]?.mode === 'fork' ? 'fork' : 'lenses'
    const parts: { lens: Any; text: string; id: string }[] = []
    for (const lens of LENSES) {
      const pt = await promptText($, lens.feature)
      if (!pt.off) parts.push({ lens, text: pt.text, id: pt.id })
    }
    const model = S.model || 'opus'
    let passVals: Record<string, unknown> | null = null
    let passTmpl: { text: string; id: string } | null = null
    const fork: Record<string, unknown> = { mode, prompt: frame.id, lenses: Object.fromEntries(parts.map(x => [x.lens.name, x.id])) }
    row.fork = fork
    const extra: Record<string, unknown> = { turn: t.turnNo, mode, lens_prompts: fork.lenses }
    const t0 = await $.clock.now()
    let f: Any
    if (mode === 'fork') {
      // the earlier pass: one prompt, in a fork of the whole session (served from main's prompt cache)
      const sofar = promptLines(store)
      const lineRule = open
        ? '\nA line is open above the prompt now. Give no new line this time: notes only, and say whether the open line is settled.\n'
        : skips > 0
          ? '\nThe person typed past the last lines without a look. Give no line this time: notes only.\n'
          : ''
      const glossRule = glossSkip > 0 ? '\nThe person has not opened the last glosses. Give no glosses this time.\n' : ''
      const prompt = frame.text
        .replace('{{QUESTION_STEP}}', qText)
        .replace('{{QUESTION}}', cut(t.question, 4000) || '(none)')
        .replace('{{DECISION}}', decision || 'none stated')
        .replace('{{ANSWER}}', cut(answer, 16000))
        .replace('{{LINES}}', String(answer.split('\n').length))
        .replace('{{ROW}}', inRow.length ? inRow.map(v => `${v.key} ${v.name}`).join(', ') : 'v visualize, s squeeze')
        .replace('{{GLOSSED}}', bullets(glossed.slice(-GLOSSED_KEEP)))
        .replace('{{GLOSS_RULE}}', glossRule)
        .replace('{{OBJECTS}}', digests.length ? digests.join('\n\n') : 'No cards yet.')
        .replace('{{COVERAGE}}', coverage)
        .replace('{{SEEN}}', bullets(seen.slice(-KEEP)))
        .replace('{{KNOWN}}', bullets(known))
        .replace('{{NOTES}}', bullets(S.notesGiven.slice(-30)))
        .replace('{{OPEN}}', open ? `"${open.line}" (shown ${open.prompts} prompt${open.prompts === 1 ? '' : 's'} ago)` : '(none)')
        .replace('{{LINE_RULE}}', lineRule)
        .replace('{{CLAIMS}}', () => sofar.claims)
        .replace('{{CLUSTERS}}', () => sofar.clusters)
        .replace('{{GROWN}}', () => (grown.length ? `\nGrown clusters, which you can rename or split:\n${grownLines(grown)}\n` : ''))
      fork.prompt_chars = prompt.length
      f = await tracked($, { feature: 'observer', prompt: frame.id, model, extra }, async () => {
        const r = await $.model.fork({ prompt })
        if (r && (r as Any).isAnswered) Object.assign(extra, sharesOf({ system: { chars: {}, shared: 0 }, turn: { chars: {}, shared: prompt.length }, lenses: parts.map(x => x.lens), raw: jsonIn((r as Any).text), rawText: (r as Any).text }))
        return r
      })
    } else {
      // the pass over the new turn and a digest of the state: the frame and the lenses' fragments are the system
      // prompt (cached), the turn is the message
      const tmpl = await promptText($, 'observer-turn')
      // an answer the person squeezed already (a look read again later): the pass reads the version they read beside
      // the original
      const atRow = again ? again.row : await answerRow($)
      const before = atRow ? await messageRecord($, atRow) : null
      const squeezed = before && typeof before.shown === 'string' && before.shown.trim() && before.shown !== before.text ? before.shown : ''
      passVals = {
        QUESTION_STEP: qText,
        QUESTION: cut(t.question, 4000) || '(none)',
        DECISION: decision || 'none stated',
        ROW: inRow.length ? inRow.map(v => `${v.key} ${v.name}`).join(', ') : 'v visualize, s squeeze',
        STEPS: stepsOf(msgs, { answer, budget: STEPS_BUDGET }),
        LINES: String(answer.split('\n').length),
        ANSWER: cut(answer, 16000),
        SHOWN: squeezed ? `\nThe person reads it squeezed (${squeezed.split('\n').length} lines); this is what shows:\n${cut(squeezed, 6000)}\n` : '',
        OBJECTS: digests.length ? digests.join('\n\n') : 'No cards yet.',
        COVERAGE: coverage,
        EARLIER: bullets(t.earlier.slice(-6).map(x => cut(x, 300))),
      }
      passTmpl = tmpl
      f = await lensPass($, { frame, parts, tmpl, vals: passVals, st, model, extra, fork })
    }
    fork.ms = (await $.clock.now()) - t0
    const out: Answer | null = f.isAnswered ? parseAnswer(f.text) : null
    if (f.isAnswered) {
      fork.usage = f.usage
      fork.out = out
      if (!out) fork.raw = cut(String(f.text), 3000)
    } else {
      fork.error = f.reason
      if ('usage' in f) fork.usage = f.usage
    }
    if (!(await isOn($))) {
      row.dropped = 'turned off while it looked'
      return
    }
    const moved = S.running || S.turnId !== t.turnId // the person started another turn while it looked

    // a look that gave nothing readable: noted in Claims, so the list says which turn was not read, and kept, so the
    // Claims pane can run it again
    if (!out) {
      try {
        if (parts.some(x => x.lens.name === 'claims')) {
          const tp = again?.tp ?? (await turnPlaces($, t.turnId))
          const turnNo = tp.turn ?? t.turnNo
          const why = f.isAnswered ? 'the observer gave no answer it could read' : `the observer's call failed: ${modelWhy(f)}`
          noteGap(store, turnNo, why, true)
          await saveClaims($, store)
          const kept: Failed = { turn: turnNo, look: { ...t, answer: cut(answer, 40000) }, again: again ?? { row: tp.rows.at(-1) ?? (await answerRow($)), tp }, why }
          S.failed = [...S.failed.filter(x => x.turn !== turnNo), kept].slice(-KEEP_FAILED)
        }
      } catch (err) {
        row.claims_error = cut(String((err as Error)?.message || err), 300)
      }
      return
    }

    // 4. each lens merges its part into the store; the answer's record takes the verbs and marks of all of them
    const fresher: Note[] = []
    let claimsLit: { row: string; note: string; claims: string[] } | null = null
    const ctx: Any = {
      open, skips, seen, known, moved, glossSkip, isRepeat,
      verbs: {} as Record<string, unknown>,
      glosses: null as unknown[] | null,
      note: (n: Note) => { fresher.push(n) },
      log: (k: string, v: unknown) => { row[k] = v },
      settle: async () => {
        const now = await openLine($)
        if (now && open && now.line === open.line) {
          await closeLine($)
          row.settled = open.line
        }
      },
      lineOpenNow: async () => !!(await openLine($)),
      showLine: async (L: NonNullable<Answer['line']>) => {
        const v: ObserverLine = { kind: 'offer', line: L.line, title: L.title, explanation: L.explanation, decision: L.decision, shownAt: await $.clock.now(), prompts: 0 }
        await $.store.set(K.seen, [...seen, L.line].slice(-KEEP))
        await $.state.set(LINE, v)
        row.line_shown = v
      },
      // the turn's claims into the session's Claims: placed by their words, said again, revised, clustered
      claims: async (value: { claims: unknown[]; clusters: unknown[] }) => {
        try {
          const tp = again?.tp ?? (await turnPlaces($, t.turnId))
          const here = again ? again.row : await answerRow($)
          const places = tp.places.length ? tp.places : here ? [{ row: here, by: 'claude' as const, turn: null, text: answer }] : []
          const when = new Date(await $.clock.now()).toISOString()
          const res = applyTurn(store, { places, out: value, turn: tp.turn ?? t.turnNo, at: when, grown })
          // a turn read after a failed look: it is no longer a gap, and its look is not kept to run again
          clearGap(store, tp.turn ?? t.turnNo)
          S.failed = S.failed.filter(x => x.turn !== (tp.turn ?? t.turnNo))
          // a claim whose sentence cites a value and that the pass gave no "based on": the rows behind the citation say it
          if (root) row.based_on_filled = await fillBasedOn($, root, store, res.added)
          await saveClaims($, store)
          row.claims = { turn: tp.turn ?? t.turnNo, given: value.claims.length, added: res.added, restated: res.restated, revised: res.revised, dropped: res.dropped, clusters: res.clusters }
          const note = noteFor(res)
          const target = tp.rows.at(-1) ?? here
          if (note && target) claimsLit = { row: target, note, claims: res.added }
        } catch (err) {
          row.claims_error = cut(String((err as Error)?.message || err), 300)
        }
      },
    }
    for (const x of parts) {
      try {
        await x.lens.merge(x.lens.read(out), ctx)
      } catch (err) {
        row[`${x.lens.name}_error`] = cut(String((err as Error)?.message || err), 300)
      }
    }

    // notes: those Claude already has dropped, the rest wait for the next prompt
    const added: Note[] = []
    for (const n of fresher) {
      if (isRepeat(n.note, S.notesGiven)) continue
      S.notesGiven.push(n.note)
      S.pending.push(n)
      added.push(n)
    }
    row.notes_added = added

    // the message row of the turn's answer: the verbs the lenses lit and the explain marks, in the answer's record
    const lit = claimsLit as { row: string; note: string; claims: string[] } | null
    const at = again ? again.row : await answerRow($)
    if (at) {
      const kept = await messageRecord($, at)
      const shown = kept ? String(kept.shown ?? kept.text) : answer
      const verbs = { ...(ctx.verbs as Record<string, unknown>) }
      // c is lit by thimble, not the pass: by the claims this turn added to this message (or as it was lit before)
      const prior = (kept?.verbs as Record<string, unknown> | undefined)?.c
      if (lit && lit.row === at && inRow.some(v => v.key === 'c')) verbs.c = { lit: true, note: lit.note, claims: lit.claims }
      else if (prior) verbs.c = prior
      // marks are kept by the words Claude wrote, so a term a squeeze left out is placed again when the original shows
      // (a term may stand in the original or in the squeezed text the person reads)
      const glosses = ctx.glosses ? glossesOf(ctx.glosses, kept ? `${String(kept.text)}\n\n${typeof kept.shown === 'string' ? kept.shown : ''}` : shown, glossed) : {}
      const rec = await applyObserver($, at, { verbs, glosses })
      const placed = rec ? Object.entries(rec.glosses || {}).filter(([id]) => rec.marks.some(m => m.gloss === id)).map(([, g]) => g.term) : []
      row.verbs_lit = Object.keys(verbs)
      const v = verbs.v as { note?: string; proposals?: string[] } | undefined
      row.v_lit = v ? { note: v.note ?? '', proposals: v.proposals ?? [] } : null
      row.glosses = placed
      if (placed.length) {
        await $.store.set(K.glossed, [...glossed, ...placed].slice(-GLOSSED_KEEP))
        const n = num(await $.store.get(K.glossUnopened)) + 1
        await $.store.set(K.glossUnopened, n)
        await $.store.set(K.glossSkip, glossSkipsFor(n))
      } else if (glossSkip > 0) await $.store.set(K.glossSkip, glossSkip - 1)
    }
    // a turn whose answer is another row than the one the verbs light (a new turn ended while it looked)
    if (lit && lit.row !== at && inRow.some(v => v.key === 'c')) await setVerb($, lit.row, 'c', { lit: true, note: lit.note, claims: lit.claims })
    if (skips > 0) await $.store.set(K.skip, skips - 1)

    // the shadow A/B (THIMBLE_PROMPTS_SHADOW): the same turn again with other versions, recorded and never merged
    if (mode === 'lenses' && passVals && passTmpl) await shadowPass($, { t, row, frame, parts, tmpl: passTmpl, vals: passVals, st, model })
  } catch (err) {
    row.error = cut(String((err as Error)?.message || err), 300)
  } finally {
    // the objects saved up to the turn it looked at are looked at; a turn that began since keeps its own start (a look
    // run again changes nothing of it)
    if (!again) S.since = S.turnId !== t.turnId ? S.turnStart : 0
    S.looking = false
    await logRow($, row)
    // one line per look in the session's events: what it lit, so `thimble stats` counts how often v lights
    await record($, { kind: 'look', turn: t.turnNo, ...(again ? { again: true } : {}), ...(row.skip ? { skip: row.skip } : {}), lit: Array.isArray(row.verbs_lit) ? row.verbs_lit : [], v: row.v_lit ?? null, observer: (row.fork as Any)?.prompt ?? null, prompts: (row.fork as Any)?.lenses ?? null })
    const next = S.again
    S.again = null
    if (next) $.clock.after(50, () => { void look($, next) })
    else lookEnded()
  }
}

let rereading = false

/**
 * The turns whose look failed (the observer's call found no sign-in, the API was down), read again now: one look each,
 * oldest first, after any look that runs. The Claims pane starts it when it opens (c), and shows the turns it reads
 * meanwhile (REREAD). A look that fails again stays kept, and the pane says so.
 */
export async function readAgain($: Engine): Promise<void> {
  if (rereading) return
  rereading = true
  try {
    await ensure($)
    if (!S.failed.length || !(await isOn($))) return
    const todo = [...S.failed].sort((a, b) => a.turn - b.turn)
    await $.state.set(REREAD, todo.map(f => f.turn))
    for (const f of todo) {
      while (S.looking) await (lookPending() ?? new Promise<void>(done => { $.clock.after(200, () => done()) }))
      lookAhead()
      await look($, f.look, f.again)
      await $.state.set(REREAD, todo.filter(x => x.turn > f.turn).map(x => x.turn))
    }
  } catch {
    // the turns stay kept, and the pane says they were not read
  } finally {
    rereading = false
    await $.state.set(REREAD, []).catch(() => undefined)
  }
}

/** The pass in lenses mode: the frame and the lenses' fragments as the system prompt (cached), the turn and the lenses'
 *  digests as the message, at the effort the frame's version names (the model's own when it names none). */
async function lensPass($: Engine, o: { frame: { text: string; id: string; version: string }; parts: { lens: Any; text: string; id: string }[]; tmpl: { text: string; id: string }; vals: Record<string, unknown>; st: Any; model: string; extra: Record<string, unknown>; fork: Record<string, unknown> }): Promise<Any> {
  const system = composeSystem(o.frame.text, o.parts)
  const turn = composeTurn(o.tmpl.text, o.vals, o.parts, o.st)
  o.fork.prompt_chars = system.text.length + turn.text.length
  o.fork.system_chars = system.text.length
  o.fork.lens_chars = Object.fromEntries(o.parts.map(x => [x.lens.name, (system.chars[x.lens.name] || 0) + (turn.chars[x.lens.name] || 0)]))
  o.extra.turn_prompt = o.tmpl.id
  const effort = (FEATURES.observer.versions as Any)?.[o.frame.version]?.effort as string | undefined
  if (effort) o.extra.effort = effort
  return tracked($, { feature: 'observer', prompt: o.frame.id, model: o.model, extra: o.extra }, async () => {
    const r = await $.model.complete({ model: o.model, system: [{ text: system.text, cache: true }], prompt: turn.text, maxTokens: 16000, ...(effort ? { effort } : {}) } as Any)
    if (r && (r as Any).isAnswered) Object.assign(o.extra, sharesOf({ system, turn, lenses: o.parts.map(x => x.lens), raw: jsonIn((r as Any).text), rawText: (r as Any).text }))
    return r
  })
}

/** The shadow A/B: the turn's pass again with the versions THIMBLE_PROMPTS_SHADOW names, on the same turn and state. Its
 *  call is in the session's events with `shadow` (thimble stats shows it on its own row), and a look line with `shadow`
 *  says what it would have lit; nothing of it is shown or merged. */
async function shadowPass($: Engine, o: { t: Look; row: Record<string, unknown>; frame: { text: string; id: string; version: string }; parts: { lens: Any; text: string; id: string }[]; tmpl: { text: string; id: string }; vals: Record<string, unknown>; st: Any; model: string }): Promise<void> {
  try {
    const sh = await shadowVersions($)
    if (!sh || !Object.keys(sh.versions).length) return
    const sv = sh.versions
    const frame = sv.observer ? await promptTextAt($, 'observer', sv.observer) : o.frame
    if ((FEATURES.observer.versions as Any)?.[frame.version]?.mode === 'fork') { o.row.shadow = { spec: sh.spec, skipped: 'the shadow frame is a fork, which cannot run beside the lenses' }; return }
    const parts: { lens: Any; text: string; id: string }[] = []
    for (const lens of LENSES as Any[]) {
      const want = sv[lens.feature]
      const mine = o.parts.find(x => x.lens === lens)
      if (!want && mine) { parts.push(mine); continue }
      const pt = want ? await promptTextAt($, lens.feature, want) : await promptText($, lens.feature)
      if (!pt.off) parts.push({ lens, text: pt.text, id: pt.id })
    }
    const tmpl = sv['observer-turn'] ? await promptTextAt($, 'observer-turn', sv['observer-turn']) : o.tmpl
    const fork: Record<string, unknown> = {}
    const extra: Record<string, unknown> = { turn: o.t.turnNo, mode: 'lenses', shadow: sh.spec, lens_prompts: Object.fromEntries(parts.map(x => [x.lens.name, x.id])) }
    const t0 = await $.clock.now()
    const f = await lensPass($, { frame, parts, tmpl, vals: o.vals, st: o.st, model: o.model, extra, fork })
    const out = f?.isAnswered ? parseAnswer(f.text) : null
    const v = out ? ((LENSES as Any[]).find(l => l.name === 'actions')?.read(out) as { note?: string; proposals?: string[] } | null) : null
    const claims = out && Array.isArray(out.claims) ? out.claims.length : 0
    o.row.shadow = { spec: sh.spec, ms: (await $.clock.now()) - t0, usage: f?.usage ?? null, ok: !!out, v: v ?? null, claims, out }
    await record($, { kind: 'look', turn: o.t.turnNo, shadow: sh.spec, lit: v ? ['v'] : [], v: v ? { note: v.note ?? '', proposals: v.proposals ?? [] } : null, observer: frame.id, prompts: extra.lens_prompts })
  } catch (err) {
    o.row.shadow_error = cut(String((err as Error)?.message || err), 300)
  }
}

/** "Based on" for the turn's new claims that cite a value and that the pass gave none: the rows behind the claim's first
 *  citation (`thimble resolve`), as words. Returns how many it filled. */
async function fillBasedOn($: Engine, root: string, store: Any, added: string[]): Promise<number> {
  const want = (added || []).map(id => store.claims.find((c: Any) => c.id === id)).filter((c: Any) => c && !c.based_on && c.sources?.length)
  if (!want.length) return 0
  const refs = [...new Set(want.map((c: Any) => String(c.sources[0].ref)))].slice(0, 12)
  const dir = $.plugin.root.replace(/\/+$/, '')
  const env = await leanEnv($, root)
  const got = new Map<string, Any>()
  await Promise.all(refs.map(async ref => {
    try {
      const r = await $.process.run([`${dir}/bin/thimble`, 'resolve', ref, '--json', '-n', '0'], { cwd: root, env, timeoutMs: 60000 })
      if (r.exitCode === 0) got.set(ref, JSON.parse(r.stdout))
    } catch {
      // a ref that does not resolve keeps its claim's cite as its "based on"
    }
  }))
  let n = 0
  for (const c of want) {
    const w = basedOnFrom(String(c.sources[0].ref), got.get(String(c.sources[0].ref)))
    if (w) { c.based_on = w; n++ }
  }
  return n
}

// ------------------------------------------------------------------------------------------------ the band

function band($: Engine, e: Any, v: ObserverLine): Any {
  const { Box, Text, Button, Markdown } = $.ui.resolve(e) as Any
  const lead = [Text({ color: 'suggestion', children: '✦' }), Text({ dimColor: true, children: ' Heads up · ' })]
  const later = async () => {
    await answered($)
    await closeLine($)
    await logRow($, { kind: 'key', key: 'not_now', line: v.line })
  }
  const key = (k: string, hotkey: string, label: string, onPress: () => unknown, role?: string) =>
    Box({ key: `b-${k}`, marginRight: 3, children: [Button({ key: k, hotkey, plain: true, label, onPress, ...(role ? { role } : {}) })] })
  if (v.kind === 'explained') {
    return Box({ flexDirection: 'column', marginTop: 1, children: [
      Text({ wrap: 'wrap', children: [...lead, Text({ bold: true, children: v.title })] }),
      Box({ marginLeft: 2, flexDirection: 'column', children: [Markdown({ text: v.explanation || v.line })] }),
      Box({ flexDirection: 'row', flexWrap: 'wrap', marginLeft: 2, children: [
        key('understood', '1', 'Understood', async () => {
          await markKnown($, v.line)
          await answered($)
          await closeLine($)
          await logRow($, { kind: 'key', key: 'understood', line: v.line })
        }),
        key('send', '2', 'Send to main', () => sendToMain($, v)),
        key('later', '0', 'Not now', later, 'dismiss'),
        Text({ dimColor: true, children: '/observe off turns these off' }),
      ] }),
    ] })
  }
  return Box({ flexDirection: 'column', marginTop: 1, children: [
    Text({ wrap: 'wrap', children: [...lead, v.line] }),
    Box({ flexDirection: 'row', flexWrap: 'wrap', marginLeft: 2, children: [
      key('learn', '1', 'Learn more', async () => {
        await answered($)
        const cur = await openLine($)
        if (cur) await $.state.set(LINE, { ...cur, kind: 'explained' })
        await logRow($, { kind: 'key', key: 'learn_more', line: v.line })
      }),
      key('known', '2', 'Know this already', async () => {
        await markKnown($, v.line)
        await answered($)
        await closeLine($)
        await logRow($, { kind: 'key', key: 'know_this', line: v.line })
      }),
      key('send', '3', 'Send to main', () => sendToMain($, v)),
      key('later', '0', 'Not now', later, 'dismiss'),
    ] }),
  ] })
}

// ------------------------------------------------------------------------------------------------ the next prompt

// the notes on the prompt in flight, until it entered (or a drop gave them back)
let carrying: Note[] = []

/** The notes as Claude reads them with a prompt, or null when there are none. */
function notesText(pending: Note[]): string | null {
  if (!pending.length) return null
  return [
    'Notes from a side agent that read your last answer, the objects you saved and their lineage. The person does not see these notes.',
    'Act on them in this reply: if a note shows an error in what you told the person, correct it plainly; otherwise check it or keep it in mind. Do not mention the side agent or the notes.',
    ...pending.map(n => `- ${n.note}${n.rests_on ? ` (It rests on: "${cut(n.rests_on, 300)}")` : ''}`),
  ].join('\n')
}

/** A prompt in the person's own words: the turn's question, one of their questions, and a prompt typed past an open
 *  line, which clears at the second. */
async function typedPrompt($: Engine, text: string): Promise<void> {
  S.prompt = { text, typed: true, verb: '' }
  S.questions = [...S.questions, text].slice(-20)
  const v = await openLine($)
  if (!v) return
  const n = v.prompts + 1
  if (n >= CLEAR_AFTER_PROMPTS) {
    await closeLine($)
    const past = num(await $.store.get(K.typedPast)) + 1
    await $.store.set(K.typedPast, past)
    await $.store.set(K.skip, skipsFor(past))
    await logRow($, { kind: 'key', key: 'typed_past', line: v.line, typed_past_in_a_row: past })
  } else {
    await $.state.set(LINE, { ...v, prompts: n })
  }
}

/** A turn this plugin starts itself, as its prompt row shows it: the person's words (`typed`: a question asked in the
 *  browser) or a verb's press (`verb`: v's ask). */
export type OwnTurn = { text: string; typed: boolean; verb: string }

/**
 * The shell starts a turn of its own (shell.tsx startTurn), which this module's prompt.submit hook may never see: the
 * turn's prompt is kept for its look (a verb's press is no question of the person's), and the notes waiting for
 * Claude are taken, once, as the text Claude reads in the row before that prompt; null when there are none.
 */
export async function ownTurn($: Engine, t: OwnTurn): Promise<string | null> {
  await ensure($)
  if (t.typed) await typedPrompt($, t.text)
  else S.prompt = { text: t.text, typed: false, verb: t.verb }
  const pending = (await isOn($)) ? S.pending : []
  S.pending = []
  if (!pending.length) return null
  await logRow($, { kind: 'notes_delivered', notes: pending.map(n => n.note), with: t.verb ? `verb ${t.verb}` : 'plugin' })
  return notesText(pending)
}

// ------------------------------------------------------------------------------------------------ hooks

export const registerObserver: Register = (on, options) => {
  S.enabled = (options as Any)?.observer !== false

  // (matchers: the kernel and the shell hold the bare hooks of these events, and the engine takes one per event)
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const r = await next(e)
    try {
      await ensure($)
      await $.command.register({ name: 'observe', description: 'The observer that reads each answer and the objects behind it: /observe off, /observe on, /observe demo, or /observe for what it did' })
      // a resumed session: the hint rows as the observer ranked them
      for (const [id, ranking] of Object.entries(S.hints)) await $.state.set({ ...RANKED, id }, ranking)
    } catch {
      // the observer stays quiet; the session goes on
    }
    return r
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    if (e.turnId !== S.turnId) {
      S.turnId = e.turnId
      S.turnNo += 1
      S.steps = 0
      S.tools = 0
      S.running = true
      S.turnStart = await $.clock.now()
      if (!S.since) S.since = S.turnStart
    }
    S.steps = Math.max(S.steps, e.index + 1)
    S.model = e.model
    const r = yield* next(e)
    S.tools += r.toolUses.length
    return r
  })

  on('turn.complete', { reason: 'answer' }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    S.running = false
    try {
      await flushDeferred($)
      if (!(await isOn($))) return r
      // no look where no person reads it: a `-p` run never, a session of the background service from the person's
      // first prompt (as the shell starts its work)
      if (personHere() !== 'now') return r
      const p = S.prompt
      const earlier = p.typed && S.questions.at(-1) === p.text ? S.questions.slice(0, -1) : S.questions.slice()
      const t: Look = { turnId: e.turnId, turnNo: S.turnNo, steps: S.steps, tools: S.tools, answer: e.answer || '', question: p.text, typed: p.typed, verb: p.verb, earlier, since: S.since }
      lookAhead()
      $.clock.after(50, () => { void look($, t) })
    } catch {
      // the turn ends whatever the observer makes of it
    }
    return r
  })

  // a turn that ended another way: no look, but nothing waits for it any more
  on('turn.complete', { reason: /^(aborted|error|refusal)$/ }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      S.running = false
      try {
        await flushDeferred($)
      } catch {
        // nothing to show is better than a turn that does not end
      }
    }
    return r
  })

  // notes reach Claude beside the next prompt of main, whatever sent it: the person's, a notification, another
  // plugin's. A turn this plugin starts itself (a verb's ask, a question from the browser) takes them through the
  // shell (ownTurn), as this hook may never see it. The turn's prompt is kept for its look.
  on('prompt.submit', { origin: { kind: /./ } }, async ($, e, next) => {
    if (e.command) return next(e)
    const o = (e.origin ?? {}) as { kind?: string; name?: string; asUser?: boolean }
    if (o.kind === 'plugin' && o.name === $.plugin.name) return next(e)
    // the person's own words: typed here or through the bridge, or another plugin's prompt sent as theirs
    const typed = !e.isMeta && (/^(composer|bridge|sdk)$/.test(String(o.kind)) || (o.kind === 'plugin' && o.asUser === true))
    let context: string | null = null
    try {
      await ensure($)
      carrying = (await isOn($)) ? S.pending : []
      S.pending = []
      context = notesText(carrying)
    } catch {
      // a prompt goes in as sent when the observer cannot add to it
    }
    const r = context ? await next({ ...e, context: [...(e.context ?? []), context] }) : await next(e)
    const went = carrying
    carrying = []
    // a prompt that never entered (a hook dropped it, the engine refused it) gave Claude nothing: its notes wait
    if ((r as Any)?.drop) { S.pending = [...went, ...S.pending]; return r }
    try {
      if (typed) await typedPrompt($, e.text)
      else if (!e.turnId) S.prompt = { text: e.text, typed: false, verb: '' }
      if (went.length) await logRow($, { kind: 'notes_delivered', notes: went.map(n => n.note), with: o.kind === 'plugin' ? `plugin ${o.name ?? ''}`.trim() : String(o.kind || 'unknown') })
    } catch {
      // the prompt went in; only the observer's record of it is missing
    }
    return r
  }).catch(($, e, next) => {
    // a drop beneath, after the notes went down with the prompt, fails this hook: the notes wait for the next prompt
    if (carrying.length) S.pending = [...carrying, ...S.pending]
    carrying = []
    return next(e)
  })

  on('command.run', { command: 'observe' }, async ($, e) => {
    await ensure($)
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off' || arg === 'on') {
      await $.store.set(K.off, arg === 'off')
      if (arg === 'off') {
        S.pending = []
        await closeLine($)
      }
      await logRow($, { kind: 'switch', on: arg === 'on' })
      if (arg === 'on' && !S.enabled) return { text: 'The Observer row in /config is off. Turn it on there.' }
      return { text: arg === 'on' ? 'The observer is on.' : 'The observer is off: no lines above the prompt, no notes to Claude, no new claims under c, and the hint rows keep the shell\'s own rule. /observe on starts it again.' }
    }
    if (arg === 'demo') {
      // a made-up line, so a person can see the band and its keys before a real one comes
      await $.state.set(LINE, {
        kind: 'offer', prompts: 0, shownAt: await $.clock.now(), decision: 'quote the share to the team',
        line: "Before you quote 6.2% to your team: it is the empty label's share, and the file does not say that empty means unlabeled.",
        title: 'Empty label may not mean unlabeled',
        explanation: '- **This is a sample line** from `/observe demo`; nothing in your work caused it.\n- A real line names a decision you stated and one fact that could change it.\n- Check: open labels.jsonl and read a row whose label is "".',
      })
      return { text: 'A sample line is above the prompt.' }
    }
    const looks = S.log.filter(x => x.kind === 'look' && !x.skip)
    const lines = looks.filter(x => x.line_shown).length
    const ranked = Object.keys(S.hints).length
    const claims = (await claimsStore($)).claims.length
    return { text: `The observer is ${(await isOn($)) ? 'on' : 'off'}. This session: ${looks.length} look${looks.length === 1 ? '' : 's'}, ${S.notesGiven.length} note${S.notesGiven.length === 1 ? '' : 's'} to Claude, ${lines} line${lines === 1 ? '' : 's'} shown, ${ranked} hint row${ranked === 1 ? '' : 's'} ranked, ${claims} claim${claims === 1 ? '' : 's'} read. /observe off or /observe on.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      const v = await openLine($)
      // the tray, which the person opened, has the band while it is open
      if ((await $.state.get(TRAY)).value) return next(e)
      if (e.props.hasSurvey || !v || !(await isOn($))) return next(e)
      return band($, e, v)
    } catch (err) {
      // a drawing that throws is drawn as Claude Code draws it: the person never sees the error itself
      return next(e)
    }
  })
}

/** For tests: the module's memory, cleared. */
export function resetObserver(): void {
  Object.assign(S, {
    session: '', file: '', enabled: true, model: '', turnId: '', turnNo: 0, steps: 0, tools: 0,
    turnStart: 0, running: false, since: 0, prompt: { text: '', typed: true, verb: '' }, questions: [], decision: '', notesGiven: [], pending: [], looking: false, again: null,
    deferred: [], hints: {}, log: [], failed: [],
  })
  rereading = false
  sending = false
  carrying = []
  lookEnded()
}
