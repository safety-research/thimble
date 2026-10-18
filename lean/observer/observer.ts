// The observer: lean thimble's always-on, quiet part. It reads each answer and the objects behind it once, after the
// turn, and most of what it finds goes to Claude, not to the person. Modeled on Claude Code's "you should know" (YSK),
// with Claude Code's own UI only: the band above the prompt, and the hint row the shell draws under each object.
//
// When it looks: after a turn of main that answered, once the answer exists, when the turn did work (it ran a tool,
// saved an object, or wrote a long answer), or when the person's message states a decision (they will tell, send,
// share or choose something), or when the answer drifted from the question. A look never runs mid-turn and never
// delays one.
//
// One look, in order:
// 1. The question step (registry feature `question`): one small completion, with no transcript, compares the answer
//    with the person's literal question and says whether their message states a decision. Its result is evidence.
// 2. The evidence (evidence.js): the objects Claude saved since the last look (and, for context, its latest ones),
//    each with its lineage in a few lines and, for the new ones, the object as the person sees it (how many rows stand
//    behind each cited value, how sure each query's row lineage is, the files the session never read, what Claude
//    declared, the problems `lean save` found) and the verbs that can act on it; and `lean coverage` for the session.
// 3. The pass: one call that composes the enabled lenses (lenses/index.mjs; compose.mjs). Each lens is a folder with
//    its output shape, its digest of the state and its merge into the store, and its prompt fragment in the registry
//    (prompts/lens-<name>/): notes to Claude, the rare line, the lit actions, where the answer stands on squeeze's
//    chips, explain marks, and the turn's claims with what each means. The system prompt is the frame (registry
//    feature `observer`) with the lenses' fragments, which the prompt cache serves; the message is the new turn (the
//    person's prompt, Claude's words and tool calls cut to fit, the answer), its objects, and each lens's digest. It
//    never reads the session before the turn. `observer:v1` is the earlier pass: one prompt in a fork of the session.
//    Every call is a line in the session's events (telemetry), with each lens's share of the pass.
// A lens turned off (LEAN_PROMPTS=lens-explain:off) is neither asked nor merged.
//
// Where its output goes:
// - notes: beside the person's next prompt, as context the person never sees. Deduplicated across the session.
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
//   new. A look that fails is noted there, so the list says which turn was not read.
// Memory and backoff, as YSK's: the last 50 lines shown and every known line are kept in the plugin's store and go
// to the fork; code drops a repeat. After more than two lines typed past in a row, the next 2^(n-3) looks (at most
// 16) give notes but no line.
// Off: /observe off, or the Observer row in /config. /observe says what it did; /observe demo shows a sample line.
// It registers no model tool, answers no permission request, starts no `claude` and runs only `lean coverage`.
import type { EngineInterface, Register } from 'claude-code'

import type { ObjRef, ObserverLine, Ranking } from '../types'
import { answerRow, applyObserver, cardSettled, claimsStore, drawnTextOf, leanEnv, messageRecord, saveClaims, setVerb, turnPlaces } from '../shell/shell'
import { glossesOf } from '../shell/message.js'
import { applyTurn, basedOnFrom, grownClusters, grownLines, noteFor, noteGap, promptLines } from '../verbs/claims/claims.js'
import { promptText, promptTextAt, shadowVersions } from '../prompts/prompts'
import { FEATURES, fill } from '../prompts/registry.mjs'
import { record, tracked } from '../telemetry/telemetry'
import { composeSystem, composeTurn, sharesOf } from './compose.mjs'
import { digest, isRepeat, jsonIn, parseAnswer } from './evidence.js'
import { LENSES } from './lenses/index.mjs'
import { stepsOf, turnWords } from './turn.mjs'

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
type Look = { turnId: string; turnNo: number; steps: number; tools: number; answer: string; question: string; since: number }

const LINE = { plugin: 'thimble-lean', key: 'line' } as const
const RANKED = { plugin: 'thimble-lean', key: 'ranked' } as const
const LAST = { plugin: 'thimble-lean', key: 'last' } as const
const TRAY = { plugin: 'thimble-lean', key: 'tray' } as const

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
const ROWVERBS = { plugin: 'thimble-lean', key: 'rowverbs' } as const

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
  question: '',
  questions: [] as string[],
  notesGiven: [] as string[],
  pending: [] as Note[],
  looking: false,
  again: null as Look | null,
  deferred: [] as { id: string; ranking: Ranking }[],
  hints: {} as Record<string, Ranking>,
  log: [] as Record<string, unknown>[],
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
const num = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0)
const bullets = (xs: string[]) => (xs.length ? xs.map(x => `- ${x}`).join('\n') : '(none)')
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120) || 'none'
const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…')

/** The session and its file, read again after a reload (which keeps the session, not this memory). The prompts come
 *  from the registry (prompts/prompts.ts), at each look. */
async function ensure($: Engine): Promise<void> {
  const id = String(await $.session.id())
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
        // a reload mid-session: the notes not yet delivered wait again, and the person's questions come back
        const delivered = new Set(S.log.filter(r => r.kind === 'notes_delivered').flatMap(r => strs(r.notes)))
        const added = S.log.filter(r => r.kind === 'look').flatMap(r => (Array.isArray(r.notes_added) ? (r.notes_added as Note[]) : []))
        S.pending = added.filter(n => n && typeof n.note === 'string' && !delivered.has(n.note))
        S.questions = S.log.filter(r => r.kind === 'look' && typeof r.question === 'string').map(r => String(r.question)).slice(-20)
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
    await $.fs.write(S.file, JSON.stringify({ hints: S.hints, notesGiven: S.notesGiven.slice(-200), log: S.log.slice(-400) }, null, 1))
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

async function questionStep($: Engine, question: string, answer: string, turn: number): Promise<Record<string, unknown>> {
  const q = await promptText($, 'question')
  const prompt = fill(q.text, {
    EARLIER: () => bullets(S.questions.slice(0, -1).slice(-6).map(x => cut(x, 600))),
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

/** The folder under analysis: where the latest object is, else LEAN_ROOT, else the nearest folder at or above the
 *  session's that holds thimble/objects. */
async function rootNow($: Engine): Promise<string | null> {
  const last = (await $.state.get(LAST)).value as ObjRef | null | undefined
  if (last?.root) return last.root
  const env = await $.env.get('LEAN_ROOT')
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
    const r = await $.process.run([`${dir}/bin/lean`, 'coverage'], { cwd: root, env: { LEAN_ROOT: root, LEAN_SESSION: S.session }, timeoutMs: 90000 })
    return r.exitCode === 0 ? cut(r.stdout.trim(), 2400) : `(lean coverage failed: ${cut((r.stderr || r.stdout).trim(), 200)})`
  } catch (err) {
    return `(lean coverage failed: ${cut(String((err as Error)?.message || err), 200)})`
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

async function look($: Engine, t: Look): Promise<void> {
  if (S.looking) {
    S.again = t // looks never overlap; the latest turn waits for the one running
    return
  }
  S.looking = true
  const row: Record<string, unknown> = { kind: 'look', turn: t.turnNo, steps: t.steps, tools: t.tools }
  try {
    await ensure($)
    const answer = await answerOf($, t.answer)
    if (!answer.trim()) {
      row.skip = 'no answer'
      return
    }
    row.question = cut(t.question, 400)

    // 1. the question step: drift and a decision in view
    const q = await questionStep($, t.question, answer, t.turnNo)
    row.question_step = q
    const qo = (q.out ?? null) as Any
    const drift = qo && typeof qo.drift === 'string' && qo.drift.trim() ? qo.drift.trim() : ''
    const decision = qo && typeof qo.decision === 'string' && qo.decision.trim() ? qo.decision.trim() : ''

    // 2. the objects and their lineage (a card drawn after the answer, by a fork, is one of them once it is done)
    const card = cardSettled()
    if (card) await Promise.race([card, new Promise<void>(done => $.clock.after(180000, () => done()))])
    const root = await rootNow($)
    const objs = root ? await objectsNow($, root, t.since) : []
    const fresh = objs.filter(x => x.isNew)
    row.objects = objs.map(x => `${x.ref.id}@${x.ref.v}${x.isNew ? ' new' : ''}`)
    const substantial = t.tools > 0 || answer.length >= LONG_ANSWER || fresh.length > 0
    if (!substantial && !decision && !drift) {
      row.skip = 'no work, no decision, no drift'
      return
    }
    row.why = [substantial ? 'work' : '', decision ? 'decision' : '', drift ? 'drift' : ''].filter(Boolean).join(', ')
    const digests: string[] = []
    for (const x of objs) {
      const drawn = x.isNew ? await drawnTextOf($, x.ref).catch(err => `(the person cannot see it: it does not draw: ${cut(String((err as Error)?.message || err), 160)})`) : ''
      digests.push(digest(x.object, { isNew: x.isNew, drawn }))
    }
    const coverage = root ? await coverageNow($, root) : '(no thimble/ folder: nothing was read through lean)'

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
    const msgs = (await $.session.messages().catch(() => [])) as Any[]
    // the turn's words (the person's message and Claude's words, no tool output): what the claims lens's digest and its
    // quiet rule read
    const turnText = turnWords(msgs, t.question)
    const st = { seen, known, notesGiven: S.notesGiven, open, skips, glossed, glossSkip, store, grown, turnText }
    const qText = q.out
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
        .replace('{{OBJECTS}}', digests.length ? digests.join('\n\n') : 'No objects yet.')
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
      // a long answer arrives squeezed: the person reads the squeezed text, which the pass reads beside the original
      const atRow = await answerRow($)
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
        OBJECTS: digests.length ? digests.join('\n\n') : 'No objects yet.',
        COVERAGE: coverage,
        EARLIER: bullets(S.questions.slice(0, -1).slice(-6).map(x => cut(x, 300))),
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

    // a look that gave nothing readable: noted in Claims, so the list says which turn was not read
    if (!out) {
      try {
        if (parts.some(x => x.lens.name === 'claims')) {
          const tp = await turnPlaces($, t.turnId)
          noteGap(store, tp.turn ?? t.turnNo, f.isAnswered ? 'the look gave no answer it could read' : `the look failed (${f.reason})`)
          await saveClaims($, store)
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
          const tp = await turnPlaces($, t.turnId)
          const here = await answerRow($)
          const places = tp.places.length ? tp.places : here ? [{ row: here, by: 'claude' as const, turn: null, text: answer }] : []
          const when = new Date(await $.clock.now()).toISOString()
          const res = applyTurn(store, { places, out: value, turn: tp.turn ?? t.turnNo, at: when, grown })
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
    const at = await answerRow($)
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

    // the shadow A/B (LEAN_PROMPTS_SHADOW): the same turn again with other versions, recorded and never merged
    if (mode === 'lenses' && passVals && passTmpl) await shadowPass($, { t, row, frame, parts, tmpl: passTmpl, vals: passVals, st, model })
  } catch (err) {
    row.error = cut(String((err as Error)?.message || err), 300)
  } finally {
    // the objects saved up to the turn it looked at are looked at; a turn that began since keeps its own start
    S.since = S.turnId !== t.turnId ? S.turnStart : 0
    S.looking = false
    await logRow($, row)
    // one line per look in the session's events: what it lit, so `lean stats` counts how often v lights
    await record($, { kind: 'look', turn: t.turnNo, ...(row.skip ? { skip: row.skip } : {}), lit: Array.isArray(row.verbs_lit) ? row.verbs_lit : [], v: row.v_lit ?? null, observer: (row.fork as Any)?.prompt ?? null, prompts: (row.fork as Any)?.lenses ?? null })
    const next = S.again
    S.again = null
    if (next) $.clock.after(50, () => { void look($, next) })
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

/** The shadow A/B: the turn's pass again with the versions LEAN_PROMPTS_SHADOW names, on the same turn and state. Its
 *  call is in the session's events with `shadow` (lean stats shows it on its own row), and a look line with `shadow`
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
 *  citation (`lean resolve`), as words. Returns how many it filled. */
async function fillBasedOn($: Engine, root: string, store: Any, added: string[]): Promise<number> {
  const want = (added || []).map(id => store.claims.find((c: Any) => c.id === id)).filter((c: Any) => c && !c.based_on && c.sources?.length)
  if (!want.length) return 0
  const refs = [...new Set(want.map((c: Any) => String(c.sources[0].ref)))].slice(0, 12)
  const dir = $.plugin.root.replace(/\/+$/, '')
  const env = await leanEnv($, root)
  const got = new Map<string, Any>()
  await Promise.all(refs.map(async ref => {
    try {
      const r = await $.process.run([`${dir}/bin/lean`, 'resolve', ref, '--json', '-n', '0'], { cwd: root, env, timeoutMs: 60000 })
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
      const t: Look = { turnId: e.turnId, turnNo: S.turnNo, steps: S.steps, tools: S.tools, answer: e.answer || '', question: S.question, since: S.since }
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

  // notes reach Claude beside the person's next prompt; an open line counts the prompts it survives
  on('prompt.submit', { origin: { kind: /^(composer|bridge)$/ } }, async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    let context: string | null = null
    try {
      await ensure($)
      S.question = e.text
      S.questions = [...S.questions, e.text].slice(-20)
      const pending = (await isOn($)) ? S.pending : []
      S.pending = []
      const v = await openLine($)
      if (v) {
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
      if (pending.length) {
        context = [
          'Notes from a side agent that read your last answer, the objects you saved and their lineage. The person does not see these notes.',
          'Act on them in this reply: if a note shows an error in what you told the person, correct it plainly; otherwise check it or keep it in mind. Do not mention the side agent or the notes.',
          ...pending.map(n => `- ${n.note}${n.rests_on ? ` (It rests on: "${cut(n.rests_on, 300)}")` : ''}`),
        ].join('\n')
        await logRow($, { kind: 'notes_delivered', notes: pending.map(n => n.note) })
      }
    } catch {
      // a prompt goes in as typed when the observer cannot add to it
    }
    return context ? next({ ...e, context: [...(e.context ?? []), context] }) : next(e)
  }).catch(($, e, next) => next(e))

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
    turnStart: 0, running: false, since: 0, question: '', questions: [], notesGiven: [], pending: [], looking: false, again: null,
    deferred: [], hints: {}, log: [],
  })
  sending = false
}
