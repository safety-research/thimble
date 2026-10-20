// The observer: thimble's always-on, quiet part. It reads each of Claude's messages with the whole session, once,
// after the message exists. All it gives reaches the person: explain marks and important details on the message's
// words, lit verbs, where the answer stands on squeeze's chips, and the session's claims. It tells Claude nothing. The
// session it reads holds what the person engaged with (shell/engaged.js): the explainers, details and citations they
// opened, and what they asked in side threads.
//
// A hook and a queue. Each new message of Claude's is queued as it arrives:
//   - an answer: the last words of a turn of main that answered (the person's question, a key's ask, a background
//     task's report, which starts a turn of its own);
//   - a reply in a long turn: words Claude wrote to the person before it went on working (LONG_REPLY characters or
//     more), queued when its turn takes its next step.
// One worker takes the queue in order, one look per message. When several messages wait (they came while a look ran),
// it takes them all in one look whose prompt names each of them. Two looks never run at once. A look never delays a
// turn. It looks only where a person is (the shell's personHere): never in a `-p` run, and in a session of Claude
// Code's background service only once the person's first prompt came; never for a subagent's or a fork's messages.
//
// One look, in order:
// 1. The evidence the transcript lacks (evidence.js): the cards Claude saved since the last look (and, for context,
//    its latest ones), each with its row lineage in a few lines and, for the new ones, the card as the person sees it;
//    and `thimble coverage` for the session.
// 2. The pass: one `$.model.fork` over the session's own transcript, as the main thread last sent it, so the prompt
//    cache serves that prefix (its `cache_read_input_tokens`). The fork keeps main's system prompt, so the observer's
//    frame (registry feature `observer`) and the enabled lenses' sections (lenses/index.mjs, compose.mjs) are its
//    prompt, then the turn template (feature `observer-turn`): the messages to read now, the evidence, each lens's
//    digest of the state the transcript lacks (the terms already explained, the heads-ups given, the claims so far
//    with their ids), and the reply's skeleton. Every call is a line in the session's events (telemetry), with
//    each lens's share.
// 3. A pass that fails is tried once more (a failed sign-in is said at once); a second failure is said in a toast with
//    its fix.
// 4. Each lens merges its part (lit verbs, explain marks, a heads-up, squeeze levels, claims). The verbs go in
//    the newest message's record; an explain mark or a heads-up goes in the record of the message that holds its term.
//    Order with squeeze: a step the person makes on Interpretation or Background before the pass has said where the
//    answer stands waits for the look (lookPending) and counts from the level it gives.
//
// Features (settings/features.mjs): each lens belongs to a feature the person turns on or off in /thimble-settings,
// and the observer runs only while one of those features is on. A lens turned off (there, or with
// THIMBLE_PROMPTS=lens-explain:off) has no section in the prompt, no key in the reply, and no merge.
//
// Where its output goes: the verbs, explain marks and heads-ups into the messages' records (the shell draws them), the
// claims into the session's Claims (claims/term.ts), placed by their words in the turn's messages.
// It registers no model tool, answers no permission request, starts no `claude` and runs only `thimble coverage`.
import type { EngineInterface, Register } from 'claude-code'

import type { ObjRef } from '../types'
import { answerRow, applyObserver, drawnTextOf, messageRecord, personHere } from '../shell/shell'
import { glossesOf, headsOf, lineOf } from '../shell/message.js'
import { promptText } from '../prompts/prompts'
import { record, tracked } from '../telemetry/telemetry'
import { composeSystem, composeTurn, sharesOf, skeletonOf } from './compose.mjs'
import { digest, jsonIn, parseAnswer } from './evidence.js'
import { LENSES } from './lenses/index.mjs'
import { sessionKey } from '../hooks/conversation'
import { modelWhy, signInFailed } from '../shell/why.js'
import { claimsDigest, claimsGap, turnClaims } from '../claims/term'
import { featureOn, lensOn } from '../settings/features.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Answer = {
  verbs: Record<string, unknown>
  glosses: unknown[]
}
/** The prompt of the turn that runs or ran last: its words; typed: the person wrote it (else a key, named in `verb`,
 *  or the session itself sent it: a task's report, a peer's message, named in `from`). */
type TurnPrompt = { text: string; typed: boolean; verb: string; from: string }
/** One of Claude's messages, queued for a look. `row`: its record's key (empty: the shell's latest answer); `at`: when
 *  it was queued, on the session's clock (objects saved after it are new to the next look); `t`: the same, in wall time,
 *  for how long the look took to land. */
export type Msg = { row: string; text: string; kind: 'answer' | 'reply'; turnId: string; turnNo: number; prompt: TurnPrompt; steps: number; tools: number; at: number; t: number }
type Part = { lens: Any; text: string; id: string }

const LAST = { plugin: 'thimble', key: 'last' } as const

const LONG_REPLY = 600 // characters: words Claude wrote before it went on working are a reply worth a look from this long
const CONTEXT_OBJECTS = 4 // cards the pass reads: every new one, then the latest older ones up to this many
const LOOK_DELAY = 50 // ms after a message is queued before the worker takes the queue
const RETRY_MS = 2000 // ms before a failed pass is tried again
// explains, per session (kept in the session's file, so another session or another folder starts afresh): the terms
// already explained, never explained again in this session
const GLOSSED_KEEP = 100

const S = {
  session: '',
  file: '',
  model: '',
  turnId: '',
  turnNo: 0,
  steps: 0,
  tools: 0,
  turnStart: 0,
  running: false,
  since: 0, // objects saved after this are new to the next look: the first turn's start, then each look's newest message
  prompt: { text: '', typed: true, verb: '', from: 'composer' } as TurnPrompt,
  texts: [] as { row: string; text: string; turnId: string; queued: boolean }[], // Claude's words in the turn now
  queue: [] as Msg[],
  busy: false,
  log: [] as Record<string, unknown>[],
  glossed: [] as string[],
  headsGiven: [] as string[], // the titles of the heads-ups placed in this session, for the lens's digest
}

// the looks to come and the one running: a promise that settles when the queue is empty and the last look has merged,
// so a squeeze step that needs the levels a look gives can wait for them (squeeze/term.ts)
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
/** While a look is on its way or running and will say where the answer stands on squeeze's chips: a promise that
 *  settles when it has merged its lenses (or ended); else null. */
export function lookPending(): Promise<void> | null {
  if (!lensOn(LENSES.find(l => l.name === 'squeeze'))) return null
  return pendingLook?.promise ?? null
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120) || 'none'
const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…')
const oneLine = (s: string) => lineOf(s)
// a message's record is kept by the first 24 characters of its row's id (as the shell keys it)
const rowKey = (uuid: string) => String(uuid).slice(0, 24)
const wait = ($: Engine, ms: number) => new Promise<void>(done => { $.clock.after(ms, () => done()) })

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
        S.glossed = strs(kept.glossed)
        S.headsGiven = strs(kept.headsGiven)
      }
    } catch {
      // a file it cannot read: the observer starts this session's memory again
    }
  }
}

/** The session's file: the terms explained, the heads-ups given, and every look, with the usage of each
 *  call. */
async function save($: Engine): Promise<void> {
  if (!S.file) return
  try {
    await $.fs.write(S.file, JSON.stringify({ glossed: S.glossed.slice(-GLOSSED_KEEP), headsGiven: S.headsGiven.slice(-40), log: S.log.slice(-400) }, null, 1))
  } catch {
    // the file is memory for a resume and a record for measuring; the observer works without it
  }
}

async function logRow($: Engine, row: Record<string, unknown>): Promise<void> {
  S.log.push({ at: new Date(await $.clock.now()).toISOString(), ...row })
  await save($)
}

// ------------------------------------------------------------------------------------------------ what it reads

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
 *  (node/objects.mjs), so an object of megabytes is read too. */
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

/** The cards' digests and the session's coverage: what the transcript does not show of the work. */
async function evidenceNow($: Engine, root: string | null, objs: Seen[]): Promise<{ objects: string; coverage: string }> {
  const [digests, coverage] = await Promise.all([
    Promise.all(objs.map(async x => {
      const drawn = x.isNew ? await drawnTextOf($, x.ref).catch(err => `(the analyst cannot see it: it does not draw: ${cut(String((err as Error)?.message || err), 160)})`) : ''
      return digest(x.object, { isNew: x.isNew, drawn })
    })),
    root ? coverageNow($, root) : Promise.resolve('(no thimble/ folder: thimble kept no record of what was seen)'),
  ])
  return { objects: digests.length ? digests.join('\n\n') : 'No cards yet.', coverage }
}

/** What prompted a message's turn, in a clause: the analyst's question, a key's ask, or a report the session got. */
function promptedBy(p: TurnPrompt): string {
  const q = cut(oneLine(p.text), 300)
  if (p.typed) return q ? `It answers the analyst's message "${q}".` : ''
  if (p.verb) return `It answers the analyst's press of a key (${p.verb})${q ? `, which asked "${q}"` : ''}.`
  if (/notification|peer/.test(p.from)) return "It answers a report the session got (a background task's or another agent's), not a message of the analyst's."
  return q ? `It answers "${q}".` : ''
}

/** The messages a look reads, named so the fork finds each in the transcript: its kind, its turn and its first words. */
export function messagesText(msgs: Msg[]): string {
  const one = (m: Msg) => {
    const begins = cut(oneLine(m.text), 140)
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

/** The keys in the analyst's row, as the features leave them (each key only while its feature is on). */
const rowKeys = () => [['cards', 'v visualize'], ['squeeze', 's squeeze'], ['claims', 'c claims']].filter(([f]) => featureOn(f!)).map(([, w]) => w).join(', ') || '(none)'

// ------------------------------------------------------------------------------------------------ the queue

/** One of Claude's messages into the queue; the worker takes it a moment later. */
async function enqueue($: Engine, m: Omit<Msg, 'at' | 't'>): Promise<void> {
  S.queue.push({ ...m, at: await $.clock.now(), t: Date.now() })
  lookAhead()
  $.clock.after(LOOK_DELAY, () => { void drain($) })
}

/** The worker: the queue in order, all that wait in one look, never two looks at once. */
async function drain($: Engine): Promise<void> {
  if (S.busy) return
  S.busy = true
  try {
    while (S.queue.length) {
      const batch = S.queue.splice(0)
      await look($, batch)
    }
  } finally {
    S.busy = false
    if (S.queue.length) $.clock.after(LOOK_DELAY, () => { void drain($) })
    else lookEnded()
  }
}

/** The words Claude wrote in the turn now that are long enough to read as a reply, and not queued yet: each queued
 *  as a reply in a long turn (the turn took another step after them). */
async function queueReplies($: Engine): Promise<void> {
  if (!featureOn('observer') || personHere() !== 'now') return
  for (const t of S.texts) {
    if (t.queued || t.turnId !== S.turnId || t.text.trim().length < LONG_REPLY) continue
    t.queued = true
    await enqueue($, { row: t.row, text: t.text, kind: 'reply', turnId: S.turnId, turnNo: S.turnNo, prompt: { ...S.prompt }, steps: S.steps, tools: S.tools })
  }
}

// ------------------------------------------------------------------------------------------------ the look

/** The enabled lenses with their sections: on by their switch, and not turned off in the prompt registry. */
async function lensParts($: Engine): Promise<Part[]> {
  const parts: Part[] = []
  for (const lens of LENSES) {
    if (!lensOn(lens)) continue
    const pt = await promptText($, lens.feature)
    if (!pt.off) parts.push({ lens, text: pt.text, id: pt.id })
  }
  return parts
}

type Pass = { f: Any; out: Answer | null; ms: number; fork: Record<string, unknown> }

/** One pass over the messages: one fork of the session, its prompt the frame with the lenses, then the turn template. */
async function pass($: Engine, o: { frame: { text: string; id: string }; parts: Part[]; msgs: Msg[]; evidence: { objects: string; coverage: string }; st: Any; shown: string }): Promise<Pass> {
  const tmpl = await promptText($, 'observer-turn')
  const newest = o.msgs[o.msgs.length - 1]!
  const lenses = Object.fromEntries(o.parts.map(x => [x.lens.name, x.id]))
  const fork: Record<string, unknown> = { prompt: o.frame.id, turn_prompt: tmpl.id, lenses }
  const extra: Record<string, unknown> = { turn: newest.turnNo, lens_prompts: lenses, turn_prompt: tmpl.id, messages: o.msgs.length }
  const system = composeSystem(o.frame.text, o.parts)
  const vals = { MESSAGES: messagesText(o.msgs), ROW: rowKeys(), SHOWN: o.shown, OBJECTS: o.evidence.objects, COVERAGE: o.evidence.coverage, SKELETON: skeletonOf(o.parts.map(x => x.lens)) }
  const turn = composeTurn(tmpl.text, vals, o.parts, o.st)
  const prompt = `${system.text}\n\n${turn.text}`
  fork.prompt_chars = prompt.length
  fork.lens_chars = Object.fromEntries(o.parts.map(x => [x.lens.name, (system.chars[x.lens.name] || 0) + (turn.chars[x.lens.name] || 0)]))
  const model = S.model || 'opus'
  const t0 = Date.now()
  const f: Any = await tracked($, { feature: 'observer', prompt: o.frame.id, model, extra }, async () => {
    const r: Any = await $.model.fork({ prompt })
    if (r && r.isAnswered) {
      const shares = sharesOf({ system, turn, lenses: o.parts.map(x => x.lens), raw: jsonIn(r.text), rawText: r.text }) as Any
      // the transcript the cache served is input too: its share goes with the frame's, in characters weighed as its
      // tokens are priced, so each lens's share is of what the call cost
      if (r.usage) {
        const paid = (r.usage.input_tokens || 0) + (r.usage.cache_creation_input_tokens || 0)
        const perToken = paid ? prompt.length / paid : 4
        shares.shared_in += Math.round(0.1 * (r.usage.cache_read_input_tokens || 0) * perToken)
      }
      Object.assign(extra, shares)
      fork.shares = shares
    }
    return r
  })
  const ms = Date.now() - t0
  fork.ms = ms
  const out: Answer | null = f && f.isAnswered ? parseAnswer(f.text) : null
  if (f && f.isAnswered) {
    fork.usage = f.usage
    fork.out = out
    if (!out) fork.raw = cut(String(f.text), 3000)
  } else {
    fork.error = f?.reason ?? 'no result'
    if (f && 'usage' in f) fork.usage = f.usage
  }
  return { f, out, ms, fork }
}

/** One look at one or more of Claude's messages, in order (the newest last). */
async function look($: Engine, batch: Msg[]): Promise<void> {
  const newest = batch[batch.length - 1]!
  const started = Date.now()
  const row: Record<string, unknown> = {
    kind: 'look', turn: newest.turnNo, steps: newest.steps, tools: newest.tools,
    messages: batch.map(m => ({ row: m.row, kind: m.kind, turn: m.turnNo })), wait_ms: Math.max(0, started - batch[0]!.t),
  }
  try {
    await ensure($)
    // an answer queued before its row was known: the shell's latest answer
    for (const m of batch) if (!m.row) m.row = (await answerRow($)) ?? ''
    if (!featureOn('observer')) { row.dropped = 'turned off'; return }
    row.question = cut(newest.prompt.text, 400)
    if (!newest.prompt.typed) Object.assign(row, { typed: false, ...(newest.prompt.verb ? { verb: newest.prompt.verb } : {}), from: newest.prompt.from })

    // 1. the cards, their lineage, and what the session read
    const root = await rootNow($)
    const objs = root ? await objectsNow($, root, S.since) : []
    row.objects = objs.map(x => `${x.ref.id}@${x.ref.v}${x.isNew ? ' new' : ''}`)
    // every message queued is read, a short answer of a turn with no tool too: the lenses say when there is nothing
    // to give (an empty reply)
    const msgs = batch
    const evidence = await evidenceNow($, root, objs)

    // 2. the state each lens needs, the lenses enabled, one pass
    const glossed = S.glossed.slice()
    const parts = await lensParts($)
    if (!parts.length) { row.skip = 'no lens on'; return }
    // the session's claims so far, which the claims lens adds these messages' to
    const claims = parts.some(x => x.lens.name === 'claims') ? await claimsDigest($) : null
    const st = { glossed, headsGiven: S.headsGiven, ...(claims ?? {}) }
    // a message the person squeezed already: the pass reads the version they read
    const kept = await messageRecord($, newest.row)
    const squeezed = kept && typeof kept.shown === 'string' && kept.shown.trim() && kept.shown !== kept.text ? kept.shown : ''
    const shown = squeezed ? `\nThe analyst reads the newest message squeezed (${squeezed.split('\n').length} lines); this is what shows:\n${cut(squeezed, 6000)}\n` : ''
    const frame = await promptText($, 'observer')
    let p = await pass($, { frame, parts, msgs, evidence, st, shown })
    // 3. a pass that failed or gave nothing readable is tried once more (a failed sign-in is not: it fails again until
    // the person signs in)
    if (!p.out && !signInFailed(p.f)) {
      row.first_try = { error: p.fork.error ?? 'its reply could not be read', ms: p.ms, usage: p.fork.usage ?? null }
      await wait($, RETRY_MS)
      if (!featureOn('observer')) { row.dropped = 'turned off'; return }
      p = await pass($, { frame, parts, msgs, evidence, st, shown })
    }
    row.fork = p.fork
    const out = p.out
    const moved = S.running || S.turnId !== newest.turnId // the person started another turn while it looked
    if (!out) {
      // said plainly, with its fix, each time a look fails twice
      const why = p.f && p.f.isAnswered ? 'its reply could not be read' : modelWhy(p.f)
      $.ui.toast(`thimble's observer could not read Claude's last message: ${why || 'no answer came back'}.`)
      if (claims) await claimsGap($, newest.turnNo, why || 'the observer did not run').catch(() => undefined)
      return
    }

    // 4. each lens merges its part; the records take the verbs and marks of all of them
    let claimsLit: { row: string; note: string; claims: string[] } | null = null
    const ctx: Any = {
      moved,
      verbs: {} as Record<string, unknown>,
      glosses: null as unknown[] | null,
      heads: null as Record<string, unknown> | null,
      log: (k: string, v: unknown) => { row[k] = v },
      // the claims into the session's Claims, placed by their words in the turn's messages
      claims: async (value: { claims: unknown[]; clusters: unknown[] }) => {
        try {
          const r = await turnClaims($, value, { answer: newest.text, turnNo: newest.turnNo, grown: claims?.grown ?? [] })
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


    // the verbs in the newest message's record; each explain mark in the record of the message that holds its term,
    // the newest first (marks are kept by the words Claude wrote, so a term a squeeze left out is placed again when
    // the original shows)
    const recs = new Map<string, Any>()
    for (const m of msgs) recs.set(m.row, await messageRecord($, m.row))
    const textOf = (m: Msg) => { const rec = recs.get(m.row); return rec ? `${String(rec.text)}\n\n${typeof rec.shown === 'string' ? rec.shown : ''}` : '' }
    const byRow = new Map<string, unknown[]>()
    for (const g of ctx.glosses ? (ctx.glosses as unknown[]) : []) {
      const m = [...msgs].reverse().find(x => Object.keys(glossesOf([g], textOf(x), glossed)).length)
      if (m) byRow.set(m.row, [...(byRow.get(m.row) ?? []), g])
    }
    // the heads-up, one at most, in the newest message that holds its words, placed beside the explainers
    const headsAt = ctx.heads ? [...msgs].reverse().find(x => Object.keys(headsOf(ctx.heads, textOf(x))).length) : undefined
    const placed: string[] = []
    for (const m of msgs) {
      const rec = recs.get(m.row)
      const isNewest = m === msgs[msgs.length - 1]
      if (!rec || (!isNewest && !byRow.has(m.row) && m !== headsAt)) continue
      const glosses = glossesOf(byRow.get(m.row) ?? [], textOf(m), [...glossed, ...placed])
      const heads = m === headsAt ? headsOf(ctx.heads, textOf(m)) : {}
      // a message older than the newest keeps its verbs (the keys act on the newest)
      const verbs = isNewest ? { ...(ctx.verbs as Record<string, unknown>) } : { ...((rec.verbs ?? {}) as Record<string, unknown>) }
      // c is lit by thimble, not the pass: only when a claim was corrected (claims/store.js noteFor)
      const lit = claimsLit as { row: string; note: string; claims: string[] } | null
      if (isNewest && lit && lit.row === m.row) verbs.c = { lit: true, note: lit.note, claims: lit.claims }
      const next = await applyObserver($, m.row, { verbs, glosses: { ...glosses, ...heads } })
      if (next) {
        placed.push(...Object.entries(next.glosses || {}).filter(([id, g]) => g.kind !== 'heads' && next.marks.some(k => k.gloss === id)).map(([, g]) => g.term))
        const headsPlaced = Object.entries(next.glosses || {}).filter(([id, g]) => g.kind === 'heads' && next.marks.some(k => k.gloss === id)).map(([, g]) => String(g.title || g.term))
        if (headsPlaced.length) { row.heads = headsPlaced; S.headsGiven = [...S.headsGiven, ...headsPlaced].slice(-40) }
      }
      if (isNewest) {
        row.verbs_lit = Object.keys(verbs)
        const v = verbs.v as { note?: string; proposals?: string[] } | undefined
        row.v_lit = v ? { note: v.note ?? '', proposals: v.proposals ?? [] } : null
      }
    }
    row.glosses = placed
    if (placed.length) S.glossed = [...glossed, ...placed].slice(-GLOSSED_KEEP)
    row.land_ms = Date.now() - newest.t
  } catch (err) {
    row.error = cut(String((err as Error)?.message || err), 300)
  } finally {
    // the objects saved up to the newest message are looked at
    S.since = newest.at
    row.ms = Date.now() - started
    await logRow($, row)
    // one line per look in the session's events: what it lit, so `thimble stats` counts how often v lights
    await record($, { kind: 'look', turn: newest.turnNo, messages: batch.length, ...(row.skip ? { skip: row.skip } : {}), lit: Array.isArray(row.verbs_lit) ? row.verbs_lit : [], v: row.v_lit ?? null, observer: (row.fork as Any)?.prompt ?? null, prompts: (row.fork as Any)?.lenses ?? null, ...(typeof row.land_ms === 'number' ? { land_ms: row.land_ms } : {}) })
  }
}

// ------------------------------------------------------------------------------------------------ the next prompt

/** A prompt in the person's own words: the turn's question. */
async function typedPrompt(_$: Engine, text: string): Promise<void> {
  S.prompt = { text, typed: true, verb: '', from: 'composer' }
}

/** A turn this plugin starts itself, as its prompt row shows it: the person's words (`typed`: a question asked in the
 *  browser) or a verb's press (`verb`: v's ask). */
export type OwnTurn = { text: string; typed: boolean; verb: string }

/**
 * The shell starts a turn of its own (shell.tsx startTurn), which this module's prompt.submit hook may never see: the
 * turn's prompt is kept for its look (a verb's press is no question of the person's).
 */
export async function ownTurn($: Engine, t: OwnTurn): Promise<void> {
  await ensure($)
  if (t.typed) await typedPrompt($, t.text)
  else S.prompt = { text: t.text, typed: false, verb: t.verb, from: 'plugin' }
}

// ------------------------------------------------------------------------------------------------ hooks

export const registerObserver: Register = (on, _options) => {
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
      S.texts = []
      if (!S.since) S.since = S.turnStart
    }
    S.steps = Math.max(S.steps, e.index + 1)
    S.model = e.model
    // a step after words Claude wrote to the person: those words were a reply in a long turn
    if (e.index > 0) {
      try { await queueReplies($) } catch { /* the step goes on */ }
    }
    const r = yield* next(e)
    S.tools += r.toolUses.length
    return r
  })

  // Claude's words, as they are stored: the rows a message's record is kept by
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const stored = await next(e)
    try {
      const msg = e.message as { type?: string; content?: unknown }
      if (e.agentId === undefined && msg.type === 'assistant' && stored?.uuid) {
        const blocks = Array.isArray(msg.content) ? (msg.content as { type?: string; text?: string }[]) : []
        const text = blocks.filter(b => b.type === 'text').map(b => String(b.text || '')).join('\n')
        if (text.trim()) S.texts.push({ row: rowKey(String(stored.uuid)), text, turnId: S.turnId, queued: false })
      }
    } catch {
      // the row is stored whatever the observer makes of it
    }
    return stored
  }).catch(($, e, next) => next(e))

  on('turn.complete', { reason: 'answer' }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    S.running = false
    try {
      if (!featureOn('observer')) return r
      // no look where no person reads it: a `-p` run never, a session of the background service from the person's
      // first prompt (as the shell starts its work)
      if (personHere() !== 'now') return r
      // the answer: the turn's last words, as stored (its row is the record the keys act on)
      const mine = S.texts.filter(t => t.turnId === e.turnId)
      const lastRow = mine.at(-1)
      const text = String(e.answer || '').trim() ? String(e.answer) : lastRow?.text ?? ''
      if (!text.trim()) return r
      if (lastRow?.queued) {
        // its last words were queued as a reply already: it is the answer now, when still waiting
        const waiting = S.queue.find(m => m.row === lastRow.row)
        if (waiting) waiting.kind = 'answer'
        return r
      }
      if (lastRow) lastRow.queued = true
      await enqueue($, { row: lastRow?.row ?? '', text, kind: 'answer', turnId: e.turnId, turnNo: S.turnNo, prompt: { ...S.prompt }, steps: S.steps, tools: S.tools })
    } catch {
      // the turn ends whatever the observer makes of it
    }
    return r
  })

  // a turn that ended another way: no look, but nothing waits for it any more
  on('turn.complete', { reason: /^(aborted|error|refusal)$/ }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) S.running = false
    return r
  })

  // the prompt of main's next turn, whatever sent it (the person, a notification, another plugin's), kept for its look.
  // A turn this plugin starts itself (a verb's ask, a question from the browser) is kept through the shell (ownTurn),
  // as this hook may never see it.
  on('prompt.submit', { origin: { kind: /./ } }, async ($, e, next) => {
    if (e.command) return next(e)
    const o = (e.origin ?? {}) as { kind?: string; name?: string; asUser?: boolean }
    if (o.kind === 'plugin' && o.name === $.plugin.name) return next(e)
    // the person's own words: typed here or through the bridge, or another plugin's prompt sent as theirs
    const typed = !e.isMeta && (/^(composer|bridge|sdk)$/.test(String(o.kind)) || (o.kind === 'plugin' && o.asUser === true))
    const r = await next(e)
    if ((r as Any)?.drop) return r
    try {
      await ensure($)
      if (typed) await typedPrompt($, e.text)
      else if (!e.turnId) S.prompt = { text: e.text, typed: false, verb: '', from: String(o.kind || 'unknown') }
    } catch {
      // the prompt went in; only the observer's record of it is missing
    }
    return r
  }).catch(($, e, next) => next(e))
}

/** For tests: the module's memory, cleared. */
export function resetObserver(): void {
  Object.assign(S, {
    session: '', file: '', model: '', turnId: '', turnNo: 0, steps: 0, tools: 0, turnStart: 0, running: false, since: 0,
    prompt: { text: '', typed: true, verb: '', from: 'composer' }, texts: [], queue: [], busy: false,
    log: [], glossed: [], headsGiven: [],
  })
  lookEnded()
}
