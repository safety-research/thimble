// telemetry.ts: every model call thimble makes, and every turn, as one line in the session's events
// ($THIMBLE_HOME/lean/events/<session>.jsonl, events.mjs says the lines). `lean stats` reads them back.
//
// - A call: `tracked($, {feature, prompt, model}, () => $.model.complete(...))` times it and writes its line: the
//   feature (observer, question, squeeze, a verb), the prompt version it used, the model, the four token counts, the
//   seconds, and whether the main turn waited for it.
// - A turn: main's, with its duration and usage from Claude Code's turn.complete, the feature that started it ('main',
//   or the verb whose request it answers: markNextTurn), and `hook_ms`, the time thimble's own hooks took inside it;
//   a subagent's, labelled by the module that started it (claimAgent: a side thread).
// - The time inside a turn: for each event that runs inside a main turn (prompt.submit, turn.start, tool.call,
//   session.append, turn.complete), one hook here reads `next.trace` after the chain beneath it ran: each of thimble's
//   links beneath with its own wall time (Claude Code's own work taken out). The sum is what thimble's hooks added to
//   the turn. This hook registers first, so it is the outermost of thimble's; when a trace shows a link of thimble's
//   above it, the turn's line says the measure is partial.
// Lines are appended by a Node child (append.mjs) a moment after they are made, batched, never inside a turn's path.
import type { EngineInterface } from 'claude-code'

import { callLine, eventsFile, turnLine } from './events.mjs'

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

/** The time thimble's hooks took in one dispatch, from the trace of the chain beneath the outermost of them. */
export function ownMs(trace: readonly Any[] | undefined, plugin: string): { ms: number; partial: boolean } {
  let ms = 0
  let partial = false
  for (const x of trace || []) {
    if (!x || x.plugin !== plugin) continue
    ms += Number(x.ms) || 0
  }
  // the first link beneath is index 1 when this hook is the outermost link of the chain
  const first = (trace || [])[0]
  if (first && Number(first.index) > 1) partial = true
  return { ms, partial }
}

function addHookMs(ms: number, partial = false): void {
  if (!(ms > 0) && !partial) return
  if (partial) T.partial = true
  if (T.active) T.hookMs += ms
  else T.pendingMs += ms
}

/** The next main turn answers a verb's request (v's card): its line is filed under that verb. */
export function markNextTurn(feature: string): void {
  T.next = feature
}

/** A subagent thimble started (a side thread): its turns are filed under `feature`. */
export function claimAgent(agentId: string, feature: string, prompt?: string | null): void {
  if (agentId) T.agents.set(agentId, { feature, prompt: prompt ?? null })
}

async function where($: Engine): Promise<string> {
  const id = String(await $.session.id())
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
 * A model call, timed and recorded: its feature, the prompt version, the model, the usage, the seconds, and whether
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

export function registerTelemetry(on: Any): void {
  // (matchers: the shell and the kernel hold the bare hooks of these events, and the engine takes one per event)
  on('prompt.submit', { text: /^[\s\S]*$/ }, async ($: Engine, e: Any, next: Any) => {
    const r = await next(e)
    const own = ownMs(next.trace, $.plugin.name)
    addHookMs(own.ms, own.partial)
    return r
  }).catch(($: Engine, e: Any, next: Any) => next(e))

  on('tool.call', { tool: /./ }, async ($: Engine, e: Any, next: Any) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      const own = ownMs(next.trace, $.plugin.name)
      addHookMs(own.ms, own.partial)
    }
    return r
  }).catch(($: Engine, e: Any, next: Any) => next(e))

  on('session.append', { door: /./ }, async ($: Engine, e: Any, next: Any) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      const own = ownMs(next.trace, $.plugin.name)
      addHookMs(own.ms, own.partial)
    }
    return r
  }).catch(($: Engine, e: Any, next: Any) => next(e))

  on('turn.start', { turnId: /./ }, async ($: Engine, e: Any, next: Any) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      T.active = true
      T.feature = T.next || 'main'
      T.next = null
      T.hookMs = T.pendingMs
      T.pendingMs = 0
      T.partial = false
      const own = ownMs(next.trace, $.plugin.name)
      addHookMs(own.ms, own.partial)
    }
    return r
  }).catch(($: Engine, e: Any, next: Any) => next(e))

  on('turn.complete', { turnId: /./ }, async ($: Engine, e: Any, next: Any) => {
    const r = await next(e)
    try {
      if (e.agentId === undefined) {
        const own = ownMs(next.trace, $.plugin.name)
        addHookMs(own.ms, own.partial)
        const line = turnLine({ feature: T.feature, ms: e.durationMs, usage: e.usage ?? r?.usage ?? null, model: e.usage?.model ?? null, hook_ms: T.hookMs, reason: e.reason, turn: e.turnId, ...(T.partial ? { hook_partial: true } : {}) })
        T.active = false
        T.hookMs = 0
        T.partial = false
        await record($, line)
      } else {
        const who = T.agents.get(String(e.agentId))
        await record($, turnLine({ feature: who?.feature ?? 'agent', agent: String(e.agentId), ms: e.durationMs, usage: e.usage ?? null, model: e.usage?.model ?? null, reason: e.reason, ...(who?.prompt ? { prompt: who.prompt } : {}) }))
      }
    } catch {
      // the turn ends whatever the record makes of it
    }
    return r
  }).catch(($: Engine, e: Any, next: Any) => next(e))
}

/** For tests: the module's memory, cleared. */
export function resetTelemetry(): void {
  Object.assign(T, { home: '', session: '', queue: [], flushing: false, active: false, feature: 'main', next: null, hookMs: 0, pendingMs: 0, agents: new Map(), partial: false })
}
