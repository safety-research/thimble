// observer.ts: one quiet look at each of Claude's answers, for the features that read answers: the explainers, the
// important details (heads-ups) and the claims. It reads each answer with the whole conversation, once, after the
// answer exists, and all it gives reaches the person through those features. It tells Claude nothing.
//
// A hook and a queue. Each new message of Claude's is queued as it arrives (core/answers.ts keeps them):
//   - an answer: the last text row of a turn of main's that answered (the person's question, a key's ask, a background
//     task's report, which starts a turn of its own);
//   - a reply in a long turn: words Claude wrote before it went on working (LONG_REPLY characters or more), queued
//     when its turn takes its next step;
//   - the words of an answer with cards: the rows above and between the turn's cards, queued with its answer, since
//     a reply that explains, shows a card and explains again is one answer;
//   - a catch-up (squeeze/term.ts): each version shown is read by the explain and heads lenses as an answer is, with
//     its words as what the analyst reads (lookAtCatchUp).
// One worker takes the queue in order. When several messages wait (they came while a look ran), it takes them all in
// one look whose prompt names each of them. Two looks never run at once, and a look never delays a turn. It looks only
// where a person is (S.person): never in a `-p` run, and in a session Claude Code's background service runs only once
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
// A lens whose feature has a mode (Claims: auto, on demand, off) joins the look after each reply only in its `auto` mode;
// else it looks on demand: f in the Claims pane (its ui.press hook here) queues the answers the claims have not read,
// for a look of that lens alone. While Minimal is on no lens joins the look after each reply; h asks for a look of the
// heads lens alone at one answer (headsUpsNow).
// It registers no model tool, answers no permission request, starts no `claude` and runs only `thimble coverage`.
import type { EngineInterface, Register } from 'claude-code'

import { failNotice } from '../bar/notice'
import { cardText } from '../cards/draw'
import { metaOf } from '../cards/store'
import { CLAIMS_FIND, claimsFindEnd, claimsFindStart, claimsLookFailed, claimsMerge, claimsState, claimsUnread } from '../claims/seam'
import { messageOf, turnOf, turnOfRow, type TurnRec } from '../core/answers'
import { isPersonPrompt, oneLine } from '../core/answers.mjs'
import { textView } from '../core/answerview'
import { readKept, rootHere, runThimble, startDir, writeKept } from '../core/env'
import { modelWhy } from '../core/why.js'
import { explainMerge, explainState } from '../explain/seam'
import { sessionKey } from '../hooks/conversation'
import { promptText, type PromptName } from '../prompts/prompts'
import { featureOn, lensesAfterReply, minimalOn } from '../settings/features.mjs'
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
 *  prompt. `at`: when it was queued (session clock); `t`: the same in wall time. `only`: the lenses of a look on
 *  demand (the claims'), which reads it with those alone. */
export type LookMsg = { row: string; text: string; kind: 'answer' | 'reply'; turnId: string; turnNo: number; prompt: TurnPrompt; at: number; t: number; only?: string[]; catchUp?: string }
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
function wait($: Engine, ms: number): Promise<void> {
  return new Promise<void>(done => { $.clock.after(ms, () => done()) })
}

/** Whether a lens joins the look after each reply: its feature is on, in its `auto` mode when it has one. */
const lensAuto = (l: Lens): boolean => lensesAfterReply(l.option)

/** Whether the observer looks after each reply: one of its lenses joins that look. */
export const observerOn = (): boolean => (LENSES as Lens[]).some(lensAuto)

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
    // a catch-up is not in the session above: its words stand here, and it is what the analyst reads of the replies
    if (m.catchUp) {
      const n = m.catchUp.split('\n').length
      return `A catch-up thimble wrote of Claude's messages since the analyst's last prompt (${n} line${n === 1 ? '' : 's'}). The analyst reads it below those messages, in place of reading them. It is not in the session above; these are its words:\n${cut(m.catchUp, 6000)}`
    }
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
const rowKeys = () => [['cards', 'v visualize'], ['squeezeAnswers', 's rewrite'], ['claims', 'c evidence']].filter(([f]) => featureOn(f!)).map(([, w]) => w).join(', ') || '(none)'

/** The look's step on the bar's busy line: `adding explainers, details, claims`. */
export function lookWord(lenses: string[]): string {
  const nouns: Record<string, string> = { explain: 'explainers', heads: 'details', claims: 'claims' }
  const said = lenses.map(x => nouns[x]).filter((x): x is string => !!x)
  return said.length ? `adding ${said.join(', ')}` : 'reading the answer'
}

// ------------------------------------------------------------------------------------------------ the queue

/** A message as the queue knows it: its row, and the lenses of a look on demand. */
const queuedKey = (m: { row: string; only?: string[]; catchUp?: string }) => `${m.row}${m.only ? `#${m.only.join(',')}` : ''}${m.catchUp ? `#cu${m.catchUp.length}` : ''}`

async function enqueue($: Engine, m: Omit<LookMsg, 'at' | 't'>): Promise<void> {
  if (S.queued.has(queuedKey(m))) {
    // its words were queued as a reply already: it is the answer now, while it still waits
    if (m.kind === 'answer') { const w = S.queue.find(x => x.row === m.row); if (w) w.kind = 'answer' }
    return
  }
  S.queued.add(queuedKey(m))
  S.queue.push({ ...m, at: Number(await $.clock.now()), t: Date.now() })
  $.clock.after(LOOK_DELAY, () => { void drain($) })
}

async function drain($: Engine): Promise<void> {
  if (S.busy) return
  S.busy = true
  try {
    // the messages that wait, together, up to the first that wants other lenses (a look on demand, or after a reply)
    while (S.queue.length) {
      const kind = String(S.queue[0]!.only ?? '')
      const n = S.queue.findIndex(m => String(m.only ?? '') !== kind)
      await look($, S.queue.splice(0, n < 0 ? S.queue.length : n))
    }
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

/** A turn's answer as looks read it: a reply with cards is one answer, so the words above and between its cards come
 *  first, then its last row. */
async function answerMsgs($: Engine, t: TurnRec): Promise<Omit<LookMsg, 'at' | 't'>[]> {
  const out: Omit<LookMsg, 'at' | 't'>[] = []
  const first = Math.min(...t.cards.map(c => (typeof c.after === 'number' ? c.after : Infinity)))
  if (Number.isFinite(first)) {
    for (const row of t.rows.slice(Math.max(0, first - 1), -1)) {
      const w = await msgOf($, t, row, 'reply')
      if (w) out.push(w)
    }
  }
  const m = t.answer ? await msgOf($, t, t.answer, 'answer') : null
  if (m) out.push(m)
  return out
}

/** f in the Claims pane: the answers the claims have not read, queued for a look of the claims lens alone. Answers
 *  how many answers it queued. */
export async function findClaimsNow($: Engine): Promise<number> {
  const turns = await claimsUnread($)
  if (!turns.length) return 0
  await claimsFindStart($, turns.length)
  for (const t of turns) for (const m of await answerMsgs($, t)) await enqueue($, { ...m, only: ['claims'] })
  return turns.length
}

/** h while Minimal is on (explain/seam.ts headsKey): the answer at `row` queued for a look of the heads lens alone.
 *  Answers whether it was queued: Heads-ups is on, a person is here, and `row` is an answer. */
export async function headsUpsNow($: Engine, row: string): Promise<boolean> {
  if (!featureOn('details') || S.person !== 'now') return false
  const t = await turnOfRow($, row)
  if (!t || t.answer !== row) return false
  const msgs = await answerMsgs($, t)
  for (const m of msgs) await enqueue($, { ...m, only: ['heads'] })
  return msgs.length > 0
}

/** A catch-up's version shown (squeeze/term.ts settled): the explain and heads lenses read it as they read an answer,
 *  with its words as what the analyst reads below `row`, the newest message it covers, where what they give is kept
 *  (explain/seam.ts explainMerge) and the catch-up's drawing finds it (explainSpansOf). */
export async function lookAtCatchUp($: Engine, row: string, text: string): Promise<void> {
  // Minimal: nothing is marked by itself, a catch-up's words neither
  if (minimalOn()) return
  const only = (LENSES as Lens[]).filter(l => (l.name === 'explain' || l.name === 'heads') && featureOn(l.option)).map(l => l.name)
  if (!only.length || S.person !== 'now' || !text.trim()) return
  const t = await turnOfRow($, row)
  const m = t ? await msgOf($, t, row, 'answer') : null
  if (m) await enqueue($, { ...m, only, catchUp: text })
}

// ------------------------------------------------------------------------------------------------ the look

/** The lenses of a look and their fragments: those that join the look after each reply, or `only` these (on demand). */
async function lensParts($: Engine, only?: string[]): Promise<Part[]> {
  const parts: Part[] = []
  for (const lens of LENSES as Lens[]) {
    if (only ? !only.includes(lens.name) || !featureOn(lens.option) : !lensAuto(lens)) continue
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
  const only = newest.only
  if (only) row.only = only
  const on = () => (only ? (LENSES as Lens[]).some(l => only.includes(l.name) && featureOn(l.option)) : observerOn())
  try {
    if (!on()) { row.dropped = 'turned off'; return }
    const parts = await lensParts($, only)
    if (!parts.length) { row.skip = 'no lens on'; return }
    const turns: TurnRec[] = []
    for (const id of [...new Set(batch.map(m => m.turnId))]) { const t = await turnOf($, id); if (t) turns.push(t) }
    const [objects, coverage] = await Promise.all([cardsNow($, turns), coverageNow($)])
    const st = { ...(await explainState($).catch(() => ({}))), ...(await claimsState($).catch(() => ({}))) }
    // a message the person reads in another version (squeezed): the look reads the version they read (a catch-up's
    // words stand in its message's place, messagesText)
    const shownText = newest.catchUp ?? (await textView($, newest.row, newest.text)).text
    const shown = !newest.catchUp && shownText !== newest.text ? `\nThe analyst reads the newest message squeezed (${shownText.split('\n').length} lines); this is what shows:\n${cut(shownText, 6000)}\n` : ''
    const vals = { MESSAGES: messagesText(batch), ROW: rowKeys(), SHOWN: shown, OBJECTS: objects, COVERAGE: coverage }
    const frame = await promptText($, 'observer')
    let p = await pass($, { frame, parts, msgs: batch, vals, st })
    if (!p.out && !signInFailed(p.f)) {
      row.first_try = { error: p.fork.error ?? 'its reply could not be read', ms: p.ms }
      await wait($, RETRY_MS)
      if (!on()) { row.dropped = 'turned off'; return }
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
    const lensOn = new Set(parts.map(x => x.lens.name))
    if (lensOn.has('explain') || lensOn.has('heads')) {
      // a lens that is off gives nothing to place
      const out = { ...p.out, glosses: lensOn.has('explain') ? p.out.glosses : [], heads: lensOn.has('heads') ? p.out.heads : null }
      try { await explainMerge($, { ...look, out }) } catch (err) { row.explain_error = cut(String((err as Error)?.message || err), 300) }
    }
    if (lensOn.has('claims')) {
      try { await claimsMerge($, look) } catch (err) { row.claims_error = cut(String((err as Error)?.message || err), 300) }
    }
    row.land_ms = Date.now() - newest.t
  } catch (err) {
    row.error = cut(String((err as Error)?.message || err), 300)
  } finally {
    // a look for the claims on demand ended, whatever came of it: the pane stops saying they are being found
    if (only?.includes('claims')) await claimsFindEnd($).catch(() => undefined)
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

  // f in the Claims pane, or a click on its line: the claims of the answers they have not read, found now
  on('ui.press', { element: /^claims-find$/ }, async ($, e, next) => {
    if (e.plugin !== 'thimble' || e.element !== CLAIMS_FIND) return next(e)
    try {
      await findClaimsNow($)
    } catch (err) {
      await claimsFindEnd($).catch(() => undefined)
      failNotice($, `thimble could not start finding the claims: ${cut(String((err as Error)?.message || err), 160)}. Press f to try again.`, 'claims:find')
    }
    return { element: e.element }
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
      if (t) for (const m of await answerMsgs($, t)) await enqueue($, m)
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
