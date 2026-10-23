// observer.ts: one quiet look at each of Claude's answers, for the features that read answers: the explainers, the
// important details (heads-ups) and the claims. It reads each answer with the whole conversation, once, after the
// answer exists, and all it gives reaches the person through those features. It tells Claude nothing.
//
// A hook and a queue. Each new message of Claude's is queued as it arrives (core/answers.ts keeps them):
//   - an answer: the last text row of a turn of main's that answered (the person's question, a key's ask, a background
//     task's report, which starts a turn of its own);
//   - a reply in a long turn: words Claude wrote before it went on working (LONG_REPLY characters or more), queued
//     when its turn takes its next step.
// One worker takes the queue in order. When several messages wait (they came while a look ran), it takes them all in
// one look whose prompt names each of them. Two looks never run at once, and a look never delays a turn. It looks only
// where a person is (personHere): never in a `-p` run, and in a session Claude Code's background service runs only once
// the person's first prompt came; never at a fork's or a subagent's messages.
//
// One look, in order:
// 1. What the conversation does not show of the work: the cards main drew in the looked-at turns (title and text copy,
//    cards/draw.ts cardText), and `thimble coverage` of the session.
// 2. The pass: one `$.model.fork` over the conversation as main last sent it, so the prompt cache serves that prefix.
//    Its prompt is the frame (prompts/observer.md) with the enabled lenses' sections (lenses.mjs, compose.mjs), then
//    the turn template (prompts/observer-turn.md): the messages to read, the evidence, each lens's digest of what
//    thimble already gave (explain/seam.ts explainState, claims/seam.ts claimsState), and the reply's skeleton. The
//    call is a line in the session's events (telemetry, feature `observer`).
// 3. A pass that fails is tried once more (a failed sign-in is not: it fails again until the person signs in); a
//    second failure says so on the failure line, and the claims hear that the turn's claims are missing.
// 4. Each feature places its part (explain/seam.ts explainMerge for the explain and heads lenses, claims/seam.ts
//    claimsMerge for the claims lens), from the Look this module hands it.
//
// Switches (settings/features.mjs): each lens belongs to a feature (explain, details, claims); the observer runs while
// one of them is on, and a lens whose feature is off has no section in the prompt, no key in the reply and no merge.
// It registers no model tool, answers no permission request, starts no `claude` and runs only `thimble coverage`.
import type { EngineInterface, Register } from 'claude-code'

import { failNotice } from '../bar/notice'
import { cardText } from '../cards/draw'
import { metaOf } from '../cards/store'
import { claimsLookFailed, claimsMerge, claimsState } from '../claims/seam'
import { messageOf, turnOf, type TurnRec } from '../core/answers'
import { isPersonPrompt, oneLine } from '../core/answers.mjs'
import { textView } from '../core/answerview'
import { readKept, rootHere, runThimble, startDir, writeKept } from '../core/env'
import { modelWhy } from '../core/why.js'
import { explainMerge, explainState } from '../explain/seam'
import { sessionKey } from '../hooks/conversation'
import { promptText, type PromptName } from '../prompts/prompts'
import { featureOn } from '../settings/features.mjs'
import { record, tracked } from '../telemetry/telemetry'
import { composeSystem, composeTurn, sharesOf, skeletonOf } from './compose.mjs'
import { LENSES } from './lenses.mjs'
import { jsonIn, parseAnswer } from './reply.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** The prompt of a message's turn: its words, and who sent it (prompt.submit's origin kind). */
export type TurnPrompt = { text: string; by: string }
/** One of Claude's messages a look reads: its row, its words, whether it ended its turn, its turn and that turn's
 *  prompt. `at`: when it was queued (session clock); `t`: the same in wall time. */
export type LookMsg = { row: string; text: string; kind: 'answer' | 'reply'; turnId: string; turnNo: number; prompt: TurnPrompt; at: number; t: number }
/** What one look gave, as a feature's merge reads it: the messages it read (the newest last), the reply read
 *  leniently (reply.mjs parseAnswer), whether the person started another turn while it looked, and a log of the
 *  look's own (a feature may note what it placed). */
export type Look = { msgs: LookMsg[]; out: { glosses: unknown[]; heads: unknown; claims: unknown[]; clusters: unknown[] }; moved: boolean; log: (key: string, value: unknown) => void }

type Lens = { name: string; feature: PromptName; option: string; skeleton: string; read: (r: Any) => Any; raw: (r: Any) => Any; digest: (st: Any) => Any; when: (st: Any) => string[] }
type Part = { lens: Lens; text: string; id: string }

const LONG_REPLY = 600 // characters: words Claude wrote before it went on working are a reply worth a look from this long
const LOOK_DELAY = 50 // ms after a message is queued before the worker takes the queue
const RETRY_MS = 2000 // ms before a failed pass is tried again
const COVERAGE_CHARS = 2400
const CARD_CHARS = 3000

const S = {
  queue: [] as LookMsg[],
  busy: false,
  queued: new Set<string>(),
  running: '' as string,
  log: [] as Record<string, unknown>[],
  person: 'now' as 'now' | 'later' | 'never',
  /** goes up when the conversation changes (a /clear, a /resume): a look of the earlier one's messages adds nothing */
  gen: 0,
}

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)
const wait = ($: Engine, ms: number) => new Promise<void>(done => { $.clock.after(ms, () => done()) })

/** Whether a person is at this session: `now` (an interactive session), `later` (one Claude Code's background service
 *  runs, until the person's first prompt), `never` (a `-p` run, the SDK). The observer looks only `now`. */
export function personHere(): 'now' | 'later' | 'never' {
  return S.person
}

/** Whether the observer runs: one of the features its lenses serve is on. */
export const observerOn = (): boolean => (LENSES as Lens[]).some(l => featureOn(l.option))

// ------------------------------------------------------------------------------------------------ what it reads

/** The cards main drew in these turns, each its title and its text copy as the person sees it now. */
async function cardsNow($: Engine, turns: TurnRec[]): Promise<string> {
  const out: string[] = []
  for (const t of turns) {
    for (const c of t.cards) {
      const meta = await metaOf($, c.id).catch(() => null)
      if (!meta || meta.version < 1) continue
      const copy = await cardText($, c.id).catch(err => `(it does not draw: ${cut(String((err as Error)?.message || err), 160)})`)
      out.push(`Card "${cut(meta.title, 80)}" (version ${meta.version}, drawn in turn ${t.n}), as the analyst sees it:\n${cut(copy, CARD_CHARS)}`)
    }
  }
  return out.length ? out.join('\n\n') : 'No cards in these turns.'
}

/** `thimble coverage` of the session: what it read of the folder, in words. */
async function coverageNow($: Engine): Promise<string> {
  const root = (await rootHere($)) || (await startDir($))
  try {
    const r = await runThimble($, root, ['coverage'], { session: await sessionKey($), timeoutMs: 90000 })
    return r.code === 0 ? cut(r.stdout.trim(), COVERAGE_CHARS) : `(thimble coverage failed: ${cut((r.stderr || r.stdout).trim(), 200)})`
  } catch (err) {
    return `(thimble coverage failed: ${cut(String((err as Error)?.message || err), 200)})`
  }
}

/** What prompted a message's turn, in a clause: the analyst's question, or a report the session got. */
function promptedBy(p: TurnPrompt): string {
  const q = oneLine(p.text, 300)
  if (isPersonPrompt(p.by)) return q ? `It answers the analyst's message "${q}".` : ''
  if (/notification|peer/.test(p.by)) return "It answers a report the session got (a background task's or another agent's), not a message of the analyst's."
  return q ? `It answers "${q}".` : ''
}

/** The messages a look reads, named so the fork finds each in the conversation: its kind, its turn, its first words. */
export function messagesText(msgs: LookMsg[]): string {
  const one = (m: LookMsg) => {
    const begins = oneLine(m.text, 140)
    const n = m.text.split('\n').length
    const lines = `${n} line${n === 1 ? '' : 's'}`
    const what = m.kind === 'answer'
      ? `Claude's answer at the end of turn ${m.turnNo}, which begins "${begins}" (${lines}). ${promptedBy(m.prompt)}`
      : `Words Claude wrote to the analyst in the middle of turn ${m.turnNo}, before it went on working, which begin "${begins}" (${lines}).`
    return what.trim()
  }
  if (msgs.length === 1) return `Read this message of Claude's, above in the session: ${one(msgs[0]!)}`
  return [`Read these ${msgs.length} messages of Claude's, above in the session, in order. They came while you read the one before them:`, ...msgs.map((m, i) => `${i + 1}. ${one(m)}`)].join('\n')
}

/** The keys above the analyst's prompt, as the features leave them. */
const rowKeys = () => [['cards', 'v card'], ['squeeze', 's squeeze'], ['claims', 'c claims']].filter(([f]) => featureOn(f!)).map(([, w]) => w).join(', ') || '(none)'

/** The look's step on the bar's busy line: `adding explainers, details, claims`. */
export function lookWord(lenses: string[]): string {
  const nouns: Record<string, string> = { explain: 'explainers', heads: 'details', claims: 'claims' }
  const said = lenses.map(x => nouns[x]).filter((x): x is string => !!x)
  return said.length ? `adding ${said.join(', ')}` : 'reading the answer'
}

// ------------------------------------------------------------------------------------------------ the queue

async function enqueue($: Engine, m: Omit<LookMsg, 'at' | 't'>): Promise<void> {
  if (S.queued.has(m.row)) {
    // its words were queued as a reply already: it is the answer now, while it still waits
    if (m.kind === 'answer') { const w = S.queue.find(x => x.row === m.row); if (w) w.kind = 'answer' }
    return
  }
  S.queued.add(m.row)
  S.queue.push({ ...m, at: Number(await $.clock.now()), t: Date.now() })
  $.clock.after(LOOK_DELAY, () => { void drain($) })
}

async function drain($: Engine): Promise<void> {
  if (S.busy) return
  S.busy = true
  try {
    while (S.queue.length) await look($, S.queue.splice(0))
  } finally {
    S.busy = false
    if (S.queue.length) $.clock.after(LOOK_DELAY, () => { void drain($) })
  }
}

/** A message of the turn, as a look reads it. */
async function msgOf($: Engine, t: TurnRec, row: string, kind: 'answer' | 'reply'): Promise<Omit<LookMsg, 'at' | 't'> | null> {
  const m = await messageOf($, row)
  if (!m?.text.trim()) return null
  return { row, text: m.text, kind, turnId: t.turnId, turnNo: t.n, prompt: { text: t.prompt.text, by: t.prompt.by } }
}

// ------------------------------------------------------------------------------------------------ the look

async function lensParts($: Engine): Promise<Part[]> {
  const parts: Part[] = []
  for (const lens of LENSES as Lens[]) {
    if (!featureOn(lens.option)) continue
    parts.push({ lens, text: await promptText($, lens.feature), id: lens.feature })
  }
  return parts
}

type Pass = { f: Any; out: Look['out'] | null; ms: number; fork: Record<string, unknown> }

async function pass($: Engine, o: { frame: string; parts: Part[]; msgs: LookMsg[]; vals: Record<string, string>; st: Any }): Promise<Pass> {
  const tmpl = await promptText($, 'observer-turn')
  const lenses = Object.fromEntries(o.parts.map(x => [x.lens.name, x.id]))
  const system = composeSystem(o.frame, o.parts)
  const turn = composeTurn(tmpl, { ...o.vals, SKELETON: skeletonOf(o.parts.map(x => x.lens)) }, o.parts, o.st)
  const prompt = `${system.text}\n\n${turn.text}`
  const fork: Record<string, unknown> = { lenses, prompt_chars: prompt.length }
  const t0 = Date.now()
  const f: Any = await tracked($, { feature: 'observer', prompt: 'observer', doing: lookWord(o.parts.map(x => x.lens.name)), extra: { turn: o.msgs.at(-1)?.turnNo ?? null, messages: o.msgs.length, lens_prompts: lenses } }, async () => {
    const r: Any = await $.model.fork({ prompt })
    if (r && r.isAnswered) fork.shares = sharesOf({ system, turn, lenses: o.parts.map(x => x.lens), raw: jsonIn(r.text), rawText: r.text })
    return r
  })
  const ms = Date.now() - t0
  const out = f && f.isAnswered ? parseAnswer(f.text) : null
  if (f && f.isAnswered) { fork.usage = f.usage; if (!out) fork.raw = cut(String(f.text), 3000) }
  else fork.error = f?.reason ?? 'no result'
  return { f, out, ms, fork }
}

/** A failed sign-in fails again until the person signs in: no second try. */
const signInFailed = (r: Any) => !!r && r.reason === 'api-error' && (r.status === 401 || r.error === 'authentication_failed')

/** One look at one or more of Claude's messages, in order (the newest last). */
async function look($: Engine, batch: LookMsg[]): Promise<void> {
  const newest = batch[batch.length - 1]!
  const started = Date.now()
  const gen = S.gen
  const row: Record<string, unknown> = { kind: 'look', turn: newest.turnNo, messages: batch.map(m => ({ row: m.row, kind: m.kind, turn: m.turnNo })), wait_ms: Math.max(0, started - batch[0]!.t) }
  try {
    if (!observerOn()) { row.dropped = 'turned off'; return }
    const parts = await lensParts($)
    if (!parts.length) { row.skip = 'no lens on'; return }
    const turns: TurnRec[] = []
    for (const id of [...new Set(batch.map(m => m.turnId))]) { const t = await turnOf($, id); if (t) turns.push(t) }
    const [objects, coverage] = await Promise.all([cardsNow($, turns), coverageNow($)])
    const st = { ...(await explainState($).catch(() => ({}))), ...(await claimsState($).catch(() => ({}))) }
    // a message the person reads in another version (squeezed): the look reads the version they read
    const shownText = (await textView($, newest.row, newest.text)).text
    const shown = shownText !== newest.text ? `\nThe analyst reads the newest message squeezed (${shownText.split('\n').length} lines); this is what shows:\n${cut(shownText, 6000)}\n` : ''
    const vals = { MESSAGES: messagesText(batch), ROW: rowKeys(), SHOWN: shown, OBJECTS: objects, COVERAGE: coverage }
    const frame = await promptText($, 'observer')
    let p = await pass($, { frame, parts, msgs: batch, vals, st })
    if (!p.out && !signInFailed(p.f)) {
      row.first_try = { error: p.fork.error ?? 'its reply could not be read', ms: p.ms }
      await wait($, RETRY_MS)
      if (!observerOn()) { row.dropped = 'turned off'; return }
      p = await pass($, { frame, parts, msgs: batch, vals, st })
    }
    row.fork = p.fork
    if (gen !== S.gen) { row.dropped = 'the conversation changed'; return }
    const moved = !!S.running && S.running !== newest.turnId
    const lookOf = (out: Look['out']): Look => ({ msgs: batch, out, moved, log: (k, v) => { row[k] = v } })
    if (!p.out) {
      const why = p.f && p.f.isAnswered ? 'its reply could not be read' : modelWhy(p.f) || 'no answer came back'
      failNotice($, `thimble could not add ${lookWord(parts.map(x => x.lens.name)).replace(/^adding /, '')} to Claude's last answer: ${why}.`, 'observer')
      if (parts.some(x => x.lens.name === 'claims')) await claimsLookFailed($, lookOf({ glosses: [], heads: null, claims: [], clusters: [] }), why).catch(() => undefined)
      return
    }
    const look = lookOf(p.out)
    const on = new Set(parts.map(x => x.lens.name))
    if (on.has('explain') || on.has('heads')) {
      // a lens that is off gives nothing to place
      const out = { ...p.out, glosses: on.has('explain') ? p.out.glosses : [], heads: on.has('heads') ? p.out.heads : null }
      try { await explainMerge($, { ...look, out }) } catch (err) { row.explain_error = cut(String((err as Error)?.message || err), 300) }
    }
    if (on.has('claims')) {
      try { await claimsMerge($, look) } catch (err) { row.claims_error = cut(String((err as Error)?.message || err), 300) }
    }
    row.land_ms = Date.now() - newest.t
  } catch (err) {
    row.error = cut(String((err as Error)?.message || err), 300)
  } finally {
    row.ms = Date.now() - started
    if (gen === S.gen) {
      S.log = [...S.log, { at: new Date(Number(await $.clock.now())).toISOString(), ...row }].slice(-400)
      await writeKept($, 'observer.json', { log: S.log }).catch(() => undefined)
    }
    await record($, { kind: 'look', turn: newest.turnNo, messages: batch.length, ...(row.skip ? { skip: row.skip } : {}), ...(typeof row.land_ms === 'number' ? { land_ms: row.land_ms } : {}) }).catch(() => undefined)
  }
}

// ------------------------------------------------------------------------------------------------ hooks

/** A /clear or a /resume (hooks/turnover.ts): the looks waiting for the earlier conversation's messages are dropped,
 *  a look that runs for them adds nothing, and the log goes on from the new one's. */
export async function turnObserver($: Engine): Promise<void> {
  S.gen += 1
  S.queue = []
  S.queued.clear()
  const kept = await readKept<{ log?: Record<string, unknown>[] }>($, 'observer.json')
  S.log = Array.isArray(kept?.log) ? kept!.log : []
}

export const registerObserver: Register = on => {
  // who is at this session: a `-p` run never; a session of Claude Code's background service from the person's first
  // prompt
  on('session.start', { cwd: /^\/?/ }, async ($, e, next) => {
    const r = await next(e)
    try {
      const kind = String((await $.env.get('CLAUDE_CODE_SESSION_KIND').catch(() => undefined)) ?? '').trim()
      S.person = e.isInteractive === false ? 'never' : kind ? 'later' : 'now'
    } catch {
      // a person is taken to be here
    }
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.submit', { origin: { kind: /^(composer|bridge)$/ } }, async ($, e, next) => {
    if (S.person === 'later') S.person = 'now'
    return next(e)
  }).catch(($, e, next) => next(e))

  // a step after words Claude wrote to the person: those words were a reply in a long turn
  on('turn.step', { turnId: /\S/ }, async function* ($, e, next) {
    if (e.agentId === undefined) {
      S.running = e.turnId
      if (e.index > 0 && observerOn() && S.person === 'now') {
        try {
          const t = await turnOf($, e.turnId)
          for (const row of t?.rows ?? []) {
            if (S.queued.has(row)) continue
            const m = t ? await msgOf($, t, row, 'reply') : null
            if (m && m.text.trim().length >= LONG_REPLY) await enqueue($, m)
          }
        } catch {
          // the step goes on
        }
      }
    }
    return yield* next(e)
  })

  // main's turn answered: its answer (core/answers.ts set it before this hook) is queued
  on('turn.complete', { reason: /^(answer|aborted|error|refusal)$/ }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    if (S.running === e.turnId) S.running = ''
    try {
      if (e.reason !== 'answer' || !observerOn() || S.person !== 'now') return r
      const t = await turnOf($, e.turnId)
      const m = t?.answer ? await msgOf($, t, t.answer, 'answer') : null
      if (m) await enqueue($, m)
    } catch {
      // the turn ends whatever the observer makes of it
    }
    return r
  }).catch(($, e, next) => next(e))
}

/** For tests: the module's memory, cleared. */
export function resetObserver(): void {
  Object.assign(S, { queue: [], busy: false, queued: new Set<string>(), running: '', log: [], person: 'now' })
}

/** For tests: the looks run now, in order, without waiting for the clock. */
export async function drainNow($: Engine): Promise<void> {
  await drain($)
}
