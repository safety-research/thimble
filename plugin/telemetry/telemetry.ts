// telemetry.ts: every model call thimble makes, and every turn, as one line in the session's events
// ($THIMBLE_HOME/lean/events/<session>.jsonl, events.mjs says the lines). `thimble stats` reads them back.
//
// - A call: `tracked($, {feature, prompt, model}, () => $.model.complete(...))` times it and writes its line: the
//   feature (observer, question, squeeze, a verb), the prompt it used, the model, the four token counts, the
//   seconds, and whether the main turn waited for it.
// - A turn: main's, with its duration and usage from Claude Code's turn.complete, the feature that started it ('main',
//   or the verb whose request it answers: markNextTurn), and `hook_ms`, the time thimble's own hooks took inside it;
//   a subagent's, labelled by the module that started it (claimAgent: a side thread).
// - The time inside a turn: for each event that runs inside a main turn (prompt.submit, turn.start, tool.call,
//   session.append, turn.complete), telemetry registers two hooks, one before thimble's other hooks and one after, so
//   they bracket them. In one dispatch the first of the two to run is the outer: it times the whole span; the inner
//   times what lies beneath it (Claude Code's own work). The span less that is what thimble's hooks added to the turn.
//   A dispatch where the two did not both run is counted as partial on the turn's line.
// Lines are appended by a Node child (append.mjs) a moment after they are made, batched, never inside a turn's path.
import type { EngineInterface } from 'claude-code'

import { callLine, eventsFile, turnLine } from './events.mjs'
import { sessionKey } from '../hooks/conversation'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const T = {
  home: '',
  session: '',
  queue: [] as { file: string; line: string }[],
  flushing: false,
  // the main turn now: when it started, what started it, and the time thimble's hooks took in it so far
  active: false,
  feature: 'main',
  next: null as string | null,
  hookMs: 0,
  pendingMs: 0,
  agents: new Map<string, { feature: string; prompt?: string | null }>(),
  partial: false,
}

function addHookMs(ms: number): void {
  if (!(ms > 0)) return
  if (T.active) T.hookMs += ms
  else T.pendingMs += ms
}

/** The next main turn answers a verb's request (v's card): its line is filed under that verb. */
export function markNextTurn(feature: string): void {
  T.next = feature
}

/** The feature of the main turn now, or of the last one once it ended: 'main', or the verb whose request it answers. */
export function turnFeature(): string {
  return T.feature
}

/** A subagent thimble started (a side thread): its turns are filed under `feature`. */
export function claimAgent(agentId: string, feature: string, prompt?: string | null): void {
  if (agentId) T.agents.set(agentId, { feature, prompt: prompt ?? null })
}

async function where($: Engine): Promise<string> {
  const id = await sessionKey($)
  if (id !== T.session || !T.home) {
    T.session = id
    T.home = (await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`
  }
  return eventsFile(T.home, T.session)
}

/** One line into the session's events: appended a moment later, with others made meanwhile. */
export async function record($: Engine, row: Record<string, unknown>): Promise<void> {
  try {
    const file = await where($)
    const t = Math.round(Date.now()) / 1000
    T.queue.push({ file, line: JSON.stringify({ t, session: T.session, ...row }) })
    $.clock.after(30, () => { void flush($) })
  } catch {
    // a record that cannot be made is a gap in the measure, never a change to the session
  }
}

async function flush($: Engine): Promise<void> {
  if (T.flushing) return
  T.flushing = true
  try {
    const dir = $.plugin.root.replace(/\/+$/, '')
    while (T.queue.length) {
      const batch = T.queue.splice(0)
      const byFile = new Map<string, string[]>()
      for (const x of batch) byFile.set(x.file, [...(byFile.get(x.file) ?? []), x.line])
      for (const [file, lines] of byFile) await $.process.run(['node', `${dir}/telemetry/append.mjs`, file], { stdin: lines.join('\n') + '\n', timeoutMs: 20000 })
    }
  } catch {
    // the lines are lost; the session goes on
  } finally {
    T.flushing = false
  }
}

/**
 * A model call, timed and recorded: its feature, the prompt, the model, the usage, the seconds, and whether
 * the main turn waited for it. Returns the call's result as it came.
 */
export async function tracked<R>($: Engine, o: { feature: string; prompt?: string | null; model?: string | null; blocked?: boolean; extra?: Record<string, unknown> }, call: () => Promise<R>): Promise<R> {
  // wall time (the session's clock is the person's; a call's seconds are real ones)
  const t0 = Date.now()
  let r: Any
  try {
    r = await call()
    return r
  } finally {
    const ms = Date.now() - t0
    const ok = !!(r && r.isAnswered)
    await record($, callLine({
      feature: o.feature, prompt: o.prompt ?? null, model: o.model ?? null, usage: r?.usage ?? null, ms, ok,
      blocked: o.blocked ?? false, ...(ok ? {} : { reason: String(r?.reason ?? 'threw') }), ...(o.extra || {}),
    }))
  }
}

// one dispatch's frame, by what tells dispatches of an event apart (a tool call's id; a row's uuid)
const F = new Map<string, { t0: number; engine: number }>()
const keyOf = (event: string, e: Any) => (event === 'tool.call' ? `tool:${e?.tool_use_id ?? e?.tool ?? ''}` : event === 'session.append' ? `append:${e?.uuid ?? ''}:${e?.door ?? ''}` : event)

/** What happens around the span of a main turn's event, by the outer hook: before it, and after with its hooks' ms. */
async function before(event: string, e: Any): Promise<void> {
  if (event === 'turn.start') {
    T.active = true
    T.feature = T.next || 'main'
    T.next = null
    T.hookMs = T.pendingMs
    T.pendingMs = 0
    T.partial = false
  }
}

async function after($: Engine, event: string, e: Any, r: Any, ms: number | null): Promise<void> {
  if (ms == null) T.partial = true
  else addHookMs(ms)
  if (event !== 'turn.complete') return
  const line = turnLine({ feature: T.feature, ms: e.durationMs, usage: e.usage ?? r?.usage ?? null, model: e.usage?.model ?? null, hook_ms: T.hookMs, reason: e.reason, turn: e.turnId, ...(T.partial ? { hook_partial: true } : {}) })
  T.active = false
  T.hookMs = 0
  T.partial = false
  await record($, line)
}

/** One of the two bracketing hooks: outer when it runs first in this dispatch, inner otherwise. */
async function bracket($: Engine, event: string, e: Any, next: Any): Promise<Any> {
  // a subagent's events are not main's turn; its turn's end is a line of its own
  if (e && e.agentId !== undefined) {
    const k = `agent:${event}:${e.agentId}`
    if (event !== 'turn.complete' || F.has(k)) return next(e)
    F.set(k, { t0: 0, engine: 0 })
    try {
      const r = await next(e)
      const who = T.agents.get(String(e.agentId))
      await record($, turnLine({ feature: who?.feature ?? 'agent', agent: String(e.agentId), ms: e.durationMs, usage: e.usage ?? null, model: e.usage?.model ?? null, reason: e.reason, ...(who?.prompt ? { prompt: who.prompt } : {}) }))
      return r
    } finally {
      F.delete(k)
    }
  }
  const k = keyOf(event, e)
  const f = F.get(k)
  if (f) {
    // inner: what lies beneath thimble's hooks
    const s = Date.now()
    try { return await next(e) } finally { f.engine = Date.now() - s }
  }
  const fr = { t0: Date.now(), engine: -1 }
  F.set(k, fr)
  let r: Any
  try {
    await before(event, e)
    r = await next(e)
    return r
  } finally {
    F.delete(k)
    const span = Date.now() - fr.t0
    try { await after($, event, e, r, fr.engine >= 0 ? Math.max(0, span - fr.engine) : null) } catch { /* the measure only */ }
  }
}

/**
 * Telemetry's hooks: `which` is 'first' (registered before thimble's other hooks) or 'last' (after them). Both run
 * the same bracket; the matchers differ, since the engine takes one hook per event and matcher.
 */
export function registerTelemetry(on: Any, which: 'first' | 'last'): void {
  const first = which === 'first'
  on('prompt.submit', first ? { text: /^/ } : { text: /$/ }, ($: Engine, e: Any, next: Any) => bracket($, 'prompt.submit', e, next)).catch(($: Engine, e: Any, next: Any) => next(e))
  on('tool.call', first ? { tool: /^/ } : { tool: /$/ }, ($: Engine, e: Any, next: Any) => bracket($, 'tool.call', e, next)).catch(($: Engine, e: Any, next: Any) => next(e))
  on('session.append', first ? { door: /^/ } : { door: /$/ }, ($: Engine, e: Any, next: Any) => bracket($, 'session.append', e, next)).catch(($: Engine, e: Any, next: Any) => next(e))
  on('turn.start', first ? { turnId: /^/ } : { turnId: /$/ }, ($: Engine, e: Any, next: Any) => bracket($, 'turn.start', e, next)).catch(($: Engine, e: Any, next: Any) => next(e))
  on('turn.complete', first ? { turnId: /^/ } : { turnId: /$/ }, ($: Engine, e: Any, next: Any) => bracket($, 'turn.complete', e, next)).catch(($: Engine, e: Any, next: Any) => next(e))
}

/** For tests: the module's memory, cleared. */
export function resetTelemetry(): void {
  Object.assign(T, { home: '', session: '', queue: [], flushing: false, active: false, feature: 'main', next: null, hookMs: 0, pendingMs: 0, agents: new Map(), partial: false })
  F.clear()
}
