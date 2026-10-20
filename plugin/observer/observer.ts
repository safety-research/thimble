// The observer: thimble's always-on, quiet part. It reads each answer and the objects behind it once, after the
// turn. What it finds goes to Claude as notes the person never sees, and to the answer as explain marks, lit verbs and
// where the answer stands on squeeze's chips.
//
// When it looks: after a turn of main that answered, once the answer exists, when the turn did work (it ran a tool,
// saved an object, or wrote a long answer). A look never runs mid-turn and never delays one. It looks only where a
// person is (the shell's personHere): never in a `-p` run, and in a session of Claude Code's background service only
// once the person's first prompt came.
//
// One look, in order:
// 1. The evidence (evidence.js): the objects Claude saved since the last look (and, for context, its latest ones),
//    each with its lineage in a few lines and, for the new ones, the object as the person sees it (how many rows stand
//    behind each cited value, how sure each query's row lineage is, the files the session never read, what Claude
//    declared, the problems `thimble save` found) and the verbs that can act on it; and `thimble coverage` for the session.
// 2. The pass: one call that composes the enabled lenses (lenses/index.mjs; compose.mjs). Each lens is a folder with
//    its output shape, its digest of the state and its merge into the store, and its prompt fragment in the registry
//    (prompts/lens-<name>/): notes to Claude, the lit actions, where the answer stands on squeeze's chips, explain
//    marks, and the turn's claims with what each leaves open. The system prompt is the frame (registry feature `observer`)
//    with the lenses' fragments, which the prompt cache serves; the message is the new turn (the person's prompt,
//    Claude's words and tool calls cut to fit, the answer), its objects, and each lens's digest. It never reads the
//    session before the turn. Every call is a line in the session's events (telemetry), with each lens's share of the
//    pass.
//    Order with squeeze: an answer arrives as Claude wrote it. A step the person makes on Report ↔ Interpret or
//    Familiarity before the pass has said where the answer stands waits for the look (lookPending) and counts from the
//    level it gives.
// A lens turned off (THIMBLE_PROMPTS=lens-explain:off) is neither asked nor merged.
//
// Where its output goes:
// - notes: beside the next prompt of main, whatever sent it (the person, a verb's ask, a notification), as context the
//   person never sees. Once each: a prompt that never entered gives them back. Deduplicated across the session.
// - claims: into the session's Claims (claims/term.ts): placed by their words in the turn's messages, with the
//   citations near them; c lights under the answer only when a new claim reads two ways or one was corrected.
// A pass that fails says so once, in a toast with its fix, and again only when the reason changes, and the Claims pane
// says which turn was not read.
// Off: the Observer row in /config.
// It registers no model tool, answers no permission request, starts no `claude` and runs only `thimble coverage`.
import type { EngineInterface, Register } from 'claude-code'

import type { ObjRef } from '../types'
import { answerRow, applyObserver, drawnTextOf, messageRecord, personHere } from '../shell/shell'
import { glossesOf } from '../shell/message.js'
import { promptText } from '../prompts/prompts'
import { FEATURES } from '../prompts/registry.mjs'
import { record, tracked } from '../telemetry/telemetry'
import { composeSystem, composeTurn, sharesOf } from './compose.mjs'
import { digest, isRepeat, jsonIn, parseAnswer } from './evidence.js'
import { LENSES } from './lenses/index.mjs'
import { stepsOf } from './turn.mjs'
import { sessionKey } from '../hooks/conversation'
import { modelWhy } from '../shell/why.js'
import { claimsDigest, claimsGap, turnClaims } from '../claims/term'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Note = { note: string; rests_on?: string; from: 'observer' }
type Answer = {
  notes: { note: string; rests_on?: string }[]
  verbs: Record<string, unknown>
  glosses: unknown[]
}
// question: the turn's own prompt; typed: whether the person wrote it (else a verb, named in `verb`, or a notification
// sent it); earlier: the person's questions before it
type Look = { turnId: string; turnNo: number; steps: number; tools: number; answer: string; question: string; typed: boolean; verb: string; earlier: string[]; since: number }
type TurnPrompt = { text: string; typed: boolean; verb: string }

const LAST = { plugin: 'thimble', key: 'last' } as const
const TRAY = { plugin: 'thimble', key: 'tray' } as const

const LONG_ANSWER = 800 // characters: a turn that ran no tool is substantial when its answer is this long
const CONTEXT_OBJECTS = 4 // objects the fork reads: every new one, then the latest older ones up to this many
const STEPS_BUDGET = 24000 // characters of the turn's words and tool calls the pass reads, the latest calls kept longest
const K = {
  // glosses: the terms the person saw explained (never glossed again), looks whose glosses nobody opened, looks to skip
  glossed: 'observer.glossed', glossUnopened: 'observer.glossUnopened', glossSkip: 'observer.glossSkip',
}
const GLOSSED_KEEP = 100
const GLOSS_FREE = 2 // looks whose glosses nobody opened before glosses back off
export const glossSkipsFor = (n: number) => (n <= GLOSS_FREE ? 0 : Math.min(8, 2 ** (n - GLOSS_FREE - 1)))

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
  notesGiven: [] as string[],
  pending: [] as Note[],
  looking: false,
  again: null as Look | null,
  log: [] as Record<string, unknown>[],
  failedWhy: '', // why the last pass failed, as said in its toast: the same reason is not said again
}

// the looks to come and the one running: a promise that settles when the last of them has ended, so a squeeze step
// that needs the levels a look gives can wait for them (squeeze/term.ts)
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
        S.log = Array.isArray(kept.log) ? kept.log : []
        S.notesGiven = strs(kept.notesGiven)
        // a reload mid-session: the notes not yet delivered wait again, and the person's questions come back
        const delivered = new Set(S.log.filter(r => r.kind === 'notes_delivered').flatMap(r => strs(r.notes)))
        const added = S.log.filter(r => r.kind === 'look').flatMap(r => (Array.isArray(r.notes_added) ? (r.notes_added as Note[]) : []))
        S.pending = added.filter(n => n && typeof n.note === 'string' && !delivered.has(n.note))
        const typed = S.log.filter(r => r.kind === 'look' && typeof r.question === 'string' && r.typed !== false)
        S.questions = typed.map(r => String(r.question)).slice(-20)
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
    await $.fs.write(S.file, JSON.stringify({ notesGiven: S.notesGiven.slice(-200), log: S.log.slice(-400) }, null, 1))
  } catch {
    // the file is memory for a resume and a record for measuring; the observer works without it
  }
}

async function logRow($: Engine, row: Record<string, unknown>): Promise<void> {
  S.log.push({ at: new Date(await $.clock.now()).toISOString(), ...row })
  await save($)
}

async function isOn(_$: Engine): Promise<boolean> {
  return S.enabled
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

/** One look at a turn. */
async function look($: Engine, t: Look): Promise<void> {
  if (S.looking) {
    // looks never overlap: the latest turn waits for the one running
    S.again = t
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
    if (!t.typed) Object.assign(row, { typed: false, ...(t.verb ? { verb: t.verb } : {}) })

    // 1. the objects and their lineage
    const root = await rootNow($)
    const objs = root ? await objectsNow($, root, t.since) : []
    const fresh = objs.filter(x => x.isNew)
    row.objects = objs.map(x => `${x.ref.id}@${x.ref.v}${x.isNew ? ' new' : ''}`)
    const substantial = t.tools > 0 || answer.length >= LONG_ANSWER || fresh.length > 0
    if (!substantial) {
      row.skip = 'no work'
      return
    }
    const digests: string[] = []
    for (const x of objs) {
      const drawn = x.isNew ? await drawnTextOf($, x.ref).catch(err => `(the analyst cannot see it: it does not draw: ${cut(String((err as Error)?.message || err), 160)})`) : ''
      digests.push(digest(x.object, { isNew: x.isNew, drawn }))
    }
    const coverage = root ? await coverageNow($, root) : '(no thimble/ folder: thimble kept no record of what was seen)'

    // 2. the pass: the state each lens needs, the lenses enabled, one call
    const glossed = strs(await $.store.get(K.glossed))
    const glossSkip = Math.min(8, num(await $.store.get(K.glossSkip)))
    const msgs = (await $.session.messages().catch(() => [])) as Any[]
    const frame = await promptText($, 'observer')
    const parts: { lens: Any; text: string; id: string }[] = []
    for (const lens of LENSES) {
      const pt = await promptText($, lens.feature)
      if (!pt.off) parts.push({ lens, text: pt.text, id: pt.id })
    }
    // the session's claims so far, which the claims lens adds this turn's to, and the turn's own words
    const claims = parts.some(x => x.lens.name === 'claims') ? await claimsDigest($, msgs, t.question) : null
    const st = { notesGiven: S.notesGiven, glossed, glossSkip, ...(claims ?? {}) }
    const model = S.model || 'opus'
    const fork: Record<string, unknown> = { prompt: frame.id, lenses: Object.fromEntries(parts.map(x => [x.lens.name, x.id])) }
    row.fork = fork
    const extra: Record<string, unknown> = { turn: t.turnNo, mode: 'lenses', lens_prompts: fork.lenses }
    const t0 = await $.clock.now()
    // the pass over the new turn and a digest of the state: the frame and the lenses' fragments are the system
    // prompt (cached), the turn is the message
    const tmpl = await promptText($, 'observer-turn')
    // an answer the person squeezed already: the pass reads the version they read beside the original
    const atRow = await answerRow($)
    const before = atRow ? await messageRecord($, atRow) : null
    const squeezed = before && typeof before.shown === 'string' && before.shown.trim() && before.shown !== before.text ? before.shown : ''
    const vals: Record<string, unknown> = {
      QUESTION: cut(t.question, 4000) || '(none)',
      ROW: 'v visualize, s squeeze, c claims',
      STEPS: stepsOf(msgs, { answer, budget: STEPS_BUDGET }),
      LINES: String(answer.split('\n').length),
      ANSWER: cut(answer, 16000),
      SHOWN: squeezed ? `\nThe analyst reads it squeezed (${squeezed.split('\n').length} lines); this is what shows:\n${cut(squeezed, 6000)}\n` : '',
      OBJECTS: digests.length ? digests.join('\n\n') : 'No cards yet.',
      COVERAGE: coverage,
      EARLIER: bullets(t.earlier.slice(-6).map(x => cut(x, 300))),
    }
    const f: Any = await lensPass($, { frame, parts, tmpl, vals, st, model, extra, fork })
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

    // a pass that failed or gave nothing readable: said once, with its fix (the same reason is not said again)
    if (!out) {
      const why = f.isAnswered ? 'its reply could not be read' : modelWhy(f)
      if (why && why !== S.failedWhy) {
        S.failedWhy = why
        $.ui.toast(`thimble's check of the answer did not run: ${why}.`)
      }
      // the Claims pane says which turn was not read
      if (claims) await claimsGap($, t.turnNo, why || 'the check of the answer did not run').catch(() => undefined)
      return
    }
    S.failedWhy = ''

    // 4. each lens merges its part into the store; the answer's record takes the verbs and marks of all of them
    const fresher: Note[] = []
    let claimsLit: { row: string; note: string; claims: string[] } | null = null
    const ctx: Any = {
      moved, glossSkip, isRepeat,
      verbs: {} as Record<string, unknown>,
      glosses: null as unknown[] | null,
      note: (n: Note) => { fresher.push(n) },
      log: (k: string, v: unknown) => { row[k] = v },
      // the turn's claims into the session's Claims, placed by their words in the turn's messages
      claims: async (value: { claims: unknown[]; clusters: unknown[] }) => {
        try {
          const r = await turnClaims($, value, { answer, turnNo: t.turnNo, grown: claims?.grown ?? [] })
          row.claims = r.log
          claimsLit = r.lit
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
    const at = await answerRow($)
    if (at) {
      const kept = await messageRecord($, at)
      const shown = kept ? String(kept.shown ?? kept.text) : answer
      const verbs = { ...(ctx.verbs as Record<string, unknown>) }
      // c is lit by thimble, not the pass: when a new claim of the answer reads two ways, or one was corrected
      const lit = claimsLit as { row: string; note: string; claims: string[] } | null
      if (lit && lit.row === at) verbs.c = { lit: true, note: lit.note, claims: lit.claims }
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
    }  } catch (err) {
    row.error = cut(String((err as Error)?.message || err), 300)
  } finally {
    // the objects saved up to the turn it looked at are looked at; a turn that began since keeps its own start
    S.since = S.turnId !== t.turnId ? S.turnStart : 0
    S.looking = false
    await logRow($, row)
    // one line per look in the session's events: what it lit, so `thimble stats` counts how often v lights
    await record($, { kind: 'look', turn: t.turnNo, ...(row.skip ? { skip: row.skip } : {}), lit: Array.isArray(row.verbs_lit) ? row.verbs_lit : [], v: row.v_lit ?? null, observer: (row.fork as Any)?.prompt ?? null, prompts: (row.fork as Any)?.lenses ?? null })
    const next = S.again
    S.again = null
    if (next) $.clock.after(50, () => { void look($, next) })
    else lookEnded()
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

// ------------------------------------------------------------------------------------------------ the next prompt

// the notes on the prompt in flight, until it entered (or a drop gave them back)
let carrying: Note[] = []

/** The notes as Claude reads them with a prompt, or null when there are none. */
function notesText(pending: Note[]): string | null {
  if (!pending.length) return null
  return [
    'Notes from a side agent that read your last answer, the cards you saved and their lineage. The analyst does not see these notes.',
    'Act on them in this reply: if a note shows an error in what you told the analyst, correct it plainly; otherwise check it or keep it in mind. Do not mention the side agent or the notes.',
    ...pending.map(n => `- ${n.note}${n.rests_on ? ` (It rests on: "${cut(n.rests_on, 300)}")` : ''}`),
  ].join('\n')
}

/** A prompt in the person's own words: the turn's question, and one of their questions. */
async function typedPrompt(_$: Engine, text: string): Promise<void> {
  S.prompt = { text, typed: true, verb: '' }
  S.questions = [...S.questions, text].slice(-20)
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
}

/** For tests: the module's memory, cleared. */
export function resetObserver(): void {
  Object.assign(S, {
    session: '', file: '', enabled: true, model: '', turnId: '', turnNo: 0, steps: 0, tools: 0,
    turnStart: 0, running: false, since: 0, prompt: { text: '', typed: true, verb: '' }, questions: [], notesGiven: [], pending: [], looking: false, again: null,
    log: [], failedWhy: '',
  })
  carrying = []
  lookEnded()
}
