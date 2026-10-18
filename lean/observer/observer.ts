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
// 1. The question step (prompts/question.md): one small completion, with no transcript, compares the answer with the
//    person's literal question and says whether their message states a decision. Its result is evidence for step 3.
// 2. The evidence (evidence.js): the objects Claude saved since the last look (and, for context, its latest ones),
//    each with its lineage in a few lines (how many rows stand behind each cited value, how sure each query's row
//    lineage is, the files the session never read, what Claude declared, the problems `lean save` found) and the
//    verbs that can act on it; and `lean coverage` for the session.
// 3. The fork (prompts/observer.md): one tool-less fork of the session (served from main's prompt cache). It gives
//    0-2 notes for Claude, at most one line for the person, whether the open line is settled, and for each new object
//    the 2-3 verbs most worth doing with a few words each.
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
// Memory and backoff, as YSK's: the last 50 lines shown and every known line are kept in the plugin's store and go
// to the fork; code drops a repeat. After more than two lines typed past in a row, the next 2^(n-3) looks (at most
// 16) give notes but no line.
// Off: /observe off, or the Observer row in /config. /observe says what it did; /observe demo shows a sample line.
// It registers no model tool, answers no permission request, starts no `claude` and runs only `lean coverage`.
import type { EngineInterface, Register } from 'claude-code'

import type { ObjRef, ObserverLine, Ranking } from '../types'
import { rankedId, verbsOf } from '../shell/shell'
import { digest, hintsFor, isRepeat, jsonIn, parseAnswer, pickHints } from './evidence.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Note = { note: string; rests_on?: string; from: 'observer' | 'line' }
type Answer = {
  notes: { note: string; rests_on?: string }[]
  line: { line: string; decision: string; title: string; explanation: string; rests_on: string } | null
  settled: boolean
  hints: Record<string, unknown>
}
type Look = { turnId: string; turnNo: number; steps: number; tools: number; answer: string; question: string; since: number }

const LINE = { plugin: 'thimble-lean', key: 'line' } as const
const RANKED = { plugin: 'thimble-lean', key: 'ranked' } as const
const LAST = { plugin: 'thimble-lean', key: 'last' } as const

const KEEP = 50 // lines shown and known, remembered, as YSK
const CLEAR_AFTER_PROMPTS = 2 // an unanswered line clears at the second next prompt, as YSK
const MAX_SKIP = 16
const TYPED_PAST_FREE = 2
export const skipsFor = (n: number) => (n <= TYPED_PAST_FREE ? 0 : Math.min(MAX_SKIP, 2 ** (n - TYPED_PAST_FREE - 1)))
const LONG_ANSWER = 800 // characters: a turn that ran no tool is substantial when its answer is this long
const CONTEXT_OBJECTS = 4 // objects the fork reads: every new one, then the latest older ones up to this many
const NOTE_HEAD = 'Here is a note offered by a side agent:'
const K = { seen: 'observer.seen', known: 'observer.known', typedPast: 'observer.typedPastInARow', skip: 'observer.looksToSkip', off: 'observer.off' }

const S = {
  observerPrompt: '',
  questionPrompt: '',
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

/** The prompts, the session and its file, read again after a reload (which keeps the session, not this memory). */
async function ensure($: Engine): Promise<void> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  if (!S.observerPrompt) S.observerPrompt = String(await $.fs.read(`${dir}/observer/prompts/observer.md`))
  if (!S.questionPrompt) S.questionPrompt = String(await $.fs.read(`${dir}/observer/prompts/question.md`))
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

async function questionStep($: Engine, question: string, answer: string): Promise<Record<string, unknown>> {
  const prompt = S.questionPrompt
    .replace('{{EARLIER}}', bullets(S.questions.slice(0, -1).slice(-6).map(q => cut(q, 600))))
    .replace('{{QUESTION}}', cut(question, 4000) || '(none)')
    .replace('{{ANSWER}}', cut(answer, 16000))
  const t0 = await $.clock.now()
  const r = await $.model.complete({ model: S.model || 'opus', prompt, maxTokens: 2000 })
  const ms = (await $.clock.now()) - t0
  if (!r.isAnswered) return { ms, error: r.reason, usage: r.usage }
  const out = jsonIn(r.text)
  return { ms, usage: r.usage, out, ...(out ? {} : { raw: cut(r.text, 2000) }) }
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
 *  CONTEXT_OBJECTS in all (every new one is kept). Objects a verb the person pressed made are not Claude's. */
async function objectsNow($: Engine, root: string, since: number): Promise<Seen[]> {
  const dir = `${root}/thimble/objects`
  const files = ((await $.fs.list(dir).catch(() => [])) as { name: string }[]).filter(f => f.name.endsWith('.json'))
  const mine: Seen[] = []
  for (const f of files) {
    try {
      const o = JSON.parse(String(await $.fs.read(`${dir}/${f.name}`)))
      if (!o || o.session !== S.session) continue
      const t = Date.parse(String(o.updated || o.created || ''))
      mine.push({ object: o, ref: { id: String(o.id), v: Number(o.version) || null, root }, isNew: !!since && t >= since - 2000 })
    } catch {
      // a file being written: the next look reads it
    }
  }
  mine.sort((a, b) => Date.parse(String(b.object.updated || '')) - Date.parse(String(a.object.updated || '')))
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
    const q = await questionStep($, t.question, answer)
    row.question_step = q
    const qo = (q.out ?? null) as Any
    const drift = qo && typeof qo.drift === 'string' && qo.drift.trim() ? qo.drift.trim() : ''
    const decision = qo && typeof qo.decision === 'string' && qo.decision.trim() ? qo.decision.trim() : ''

    // 2. the objects and their lineage
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
    const verbs: Record<string, Any[]> = {}
    const digests: string[] = []
    for (const x of objs) {
      verbs[x.ref.id] = await verbsOf($, x.ref).catch(() => [])
      digests.push(digest(x.object, { verbs: verbs[x.ref.id], isNew: x.isNew }))
    }
    const coverage = root ? await coverageNow($, root) : '(no thimble/ folder: nothing was read through lean)'

    // 3. the fork
    const seen = strs(await $.store.get(K.seen))
    const known = strs(await $.store.get(K.known))
    const open = await openLine($)
    const skips = Math.min(MAX_SKIP, num(await $.store.get(K.skip)))
    const lineRule = open
      ? '\nA line is open above the prompt now. Give no new line this time: notes only, and say whether the open line is settled.\n'
      : skips > 0
        ? '\nThe person typed past the last lines without a look. Give no line this time: notes only.\n'
        : ''
    const qText = q.out
      ? drift
        ? `A part is missing or replaced: ${drift}`
        : 'The answer gives every part of the question.'
      : '(the step gave no result)'
    const prompt = S.observerPrompt
      .replace('{{QUESTION_STEP}}', qText)
      .replace('{{QUESTION}}', cut(t.question, 4000) || '(none)')
      .replace('{{DECISION}}', decision || 'none stated')
      .replace('{{ANSWER}}', cut(answer, 16000))
      .replace('{{OBJECTS}}', digests.length ? digests.join('\n\n') : 'No objects yet.')
      .replace('{{COVERAGE}}', coverage)
      .replace('{{SEEN}}', bullets(seen.slice(-KEEP)))
      .replace('{{KNOWN}}', bullets(known))
      .replace('{{NOTES}}', bullets(S.notesGiven.slice(-30)))
      .replace('{{OPEN}}', open ? `"${open.line}" (shown ${open.prompts} prompt${open.prompts === 1 ? '' : 's'} ago)` : '(none)')
      .replace('{{LINE_RULE}}', lineRule)
    const t0 = await $.clock.now()
    const f = await $.model.fork({ prompt })
    const fork: Record<string, unknown> = { ms: (await $.clock.now()) - t0, prompt_chars: prompt.length }
    row.fork = fork
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

    // the open line: closed when the session has settled it
    if (open && out?.settled) {
      const now = await openLine($)
      if (now && now.line === open.line) {
        await closeLine($)
        row.settled = open.line
      }
    }

    // notes, then the line
    const fresher: Note[] = (out?.notes ?? []).slice(0, 2).map(n => ({ from: 'observer' as const, ...n }))
    const L = out?.line ?? null
    if (L) {
      let why = ''
      if (!L.decision) why = 'it names no decision'
      else if (await openLine($)) why = 'a line is open'
      else if (skips > 0) why = 'backoff'
      else if (isRepeat(L.line, [...seen, ...known])) why = 'repeat'
      else if (moved) why = 'stale: a new turn began'
      if (why) {
        row.line_dropped = { line: L.line, why }
        // a finding that cannot be a line still reaches Claude; one the person saw or knows goes nowhere
        if (why !== 'repeat') fresher.push({ from: 'line', note: `${L.line}${L.explanation ? ' ' + L.explanation.replace(/\n+/g, ' ') : ''}`, ...(L.rests_on ? { rests_on: L.rests_on } : {}) })
      } else {
        const v: ObserverLine = { kind: 'offer', line: L.line, title: L.title, explanation: L.explanation, decision: L.decision, shownAt: await $.clock.now(), prompts: 0 }
        await $.store.set(K.seen, [...seen, L.line].slice(-KEEP))
        await $.state.set(LINE, v)
        row.line_shown = v
      }
    }
    const added: Note[] = []
    for (const n of fresher) {
      if (isRepeat(n.note, S.notesGiven)) continue
      S.notesGiven.push(n.note)
      S.pending.push(n)
      added.push(n)
    }
    row.notes_added = added

    // the hint rows of the new objects
    const ranked: Record<string, unknown> = {}
    for (const x of fresh) {
      const list = pickHints(hintsFor(out?.hints, x.ref.id), verbs[x.ref.id] || [])
      if (!list.length) continue
      const ranking: Ranking = { verbs: list, at: await $.clock.now(), by: 'observer' }
      const id = rankedId(x.ref)
      ranked[`${x.ref.id}@${x.ref.v}`] = list
      if (moved) S.deferred.push({ id, ranking })
      else await applyRanking($, id, ranking)
    }
    row.hints = ranked
    if (moved && Object.keys(ranked).length) row.hints_wait = 'for the running turn to end'
    if (skips > 0) await $.store.set(K.skip, skips - 1)
  } catch (err) {
    row.error = cut(String((err as Error)?.message || err), 300)
  } finally {
    // the objects saved up to the turn it looked at are looked at; a turn that began since keeps its own start
    S.since = S.turnId !== t.turnId ? S.turnStart : 0
    S.looking = false
    await logRow($, row)
    const next = S.again
    S.again = null
    if (next) $.clock.after(50, () => { void look($, next) })
  }
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
      return { text: arg === 'on' ? 'The observer is on.' : 'The observer is off: no lines above the prompt, no notes to Claude, and the hint rows keep the shell\'s own rule. /observe on starts it again.' }
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
    return { text: `The observer is ${(await isOn($)) ? 'on' : 'off'}. This session: ${looks.length} look${looks.length === 1 ? '' : 's'}, ${S.notesGiven.length} note${S.notesGiven.length === 1 ? '' : 's'} to Claude, ${lines} line${lines === 1 ? '' : 's'} shown, ${ranked} hint row${ranked === 1 ? '' : 's'} ranked. /observe off or /observe on.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await openLine($)
    if (e.props.hasSurvey || !v || !(await isOn($))) return next(e)
    return band($, e, v)
  })
}

/** For tests: the module's memory, cleared. */
export function resetObserver(): void {
  Object.assign(S, {
    observerPrompt: '', questionPrompt: '', session: '', file: '', enabled: true, model: '', turnId: '', turnNo: 0, steps: 0, tools: 0,
    turnStart: 0, running: false, since: 0, question: '', questions: [], notesGiven: [], pending: [], looking: false, again: null,
    deferred: [], hints: {}, log: [],
  })
  sending = false
}
