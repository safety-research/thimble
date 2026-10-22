// events.mjs: the lines thimble's telemetry writes to the session's events, and how `thimble dev stats` reads them.
// Pure.
//
// The session's events are one file, $THIMBLE_HOME/events/<conversation>.jsonl (core/layout.mjs eventsFile): the one
// append-only log of the session, which the kernel writes its change feed to (core/feed.ts reads it) and telemetry
// writes its lines to. It is under THIMBLE_HOME, not the data folder, because a session's log starts before any data
// folder is known, and because the kernel writes nothing into the folder under analysis.
// Readers skip the kinds they do not know. Telemetry adds:
//
//   {kind: 'call', feature, prompt, model, usage, ms, blocked, ok, ...}   one model call thimble made: a label's read
//        (feature 'labels'), the observer's look after an answer ('observer'), a squeeze's rewrite ('squeeze'), a longer
//        explainer ('explain'). `blocked`: whether the main turn waited for it (thimble's calls run beside the turn, so
//        false).
//   {kind: 'turn', feature, agent, ms, usage, model, hook_ms, reason}     one turn: main's (feature 'main'), or a fork's
//        (feature 'checker', 'designer' or 'thread'). `hook_ms`: the time thimble's own hooks took inside a main turn,
//        which is the latency thimble adds to it.
//   {kind: 'prompts', plugin}                                             once per session: the plugin's version (its
//        texts are the ones that version holds)
//   {kind: 'look', turn, messages, skip?, land_ms?}                       one look of the observer (observer.ts)

/** Price weights of a model call's tokens: input 1, cache write 1.25, cache read 0.1, output 5. */
export const PRICE = { input_tokens: 1, cache_creation_input_tokens: 1.25, cache_read_input_tokens: 0.1, output_tokens: 5 }

/** A call's price-weighted tokens, and its input and output parts. */
export function weighted(u) {
  const x = u || {}
  const n = k => (Number.isFinite(x[k]) ? x[k] : 0)
  const input = n('input_tokens') + 1.25 * n('cache_creation_input_tokens') + 0.1 * n('cache_read_input_tokens')
  const output = 5 * n('output_tokens')
  return { input, output, total: input + output }
}

/** The usage counts as the API names them, zero where absent: the one shape every line keeps. */
export function usageOf(u) {
  const x = u || {}
  const n = k => (Number.isFinite(x[k]) ? x[k] : 0)
  return { input_tokens: n('input_tokens'), cache_creation_input_tokens: n('cache_creation_input_tokens'), cache_read_input_tokens: n('cache_read_input_tokens'), output_tokens: n('output_tokens') }
}

/** One call's line. */
export function callLine({ feature, prompt = null, model = null, usage = null, ms = 0, blocked = false, ok = true, ...rest }) {
  return { kind: 'call', feature, prompt, model, usage: usageOf(usage), ms: Math.round(ms), blocked: !!blocked, ok: !!ok, ...rest }
}

/** One turn's line. */
export function turnLine({ feature = 'main', agent = null, ms = 0, usage = null, model = null, hook_ms = null, reason = 'answer', ...rest }) {
  return { kind: 'turn', feature, agent, ms: Math.round(ms), usage: usageOf(usage), model, ...(hook_ms == null ? {} : { hook_ms: Math.round(hook_ms) }), reason, ...rest }
}

// ------------------------------------------------------------------------------------------------ reading them back

export function parseLines(text) {
  const out = []
  for (const l of String(text || '').split('\n')) {
    if (!l.trim()) continue
    try { out.push(JSON.parse(l)) } catch { /* a line being written */ }
  }
  return out
}

const add = (a, u) => { for (const k of Object.keys(PRICE)) a[k] = (a[k] || 0) + (u?.[k] || 0); return a }

/** A session's events summed per feature: calls (count, price-weighted tokens, seconds, how many blocked the main turn)
 *  and turns (main and the forks'). */
export function summarize(events) {
  const features = {}
  const turns = []
  let prompts = null
  const row = name => (features[name] ??= { feature: name, calls: 0, w: 0, w_in: 0, w_out: 0, ms: 0, blocked: 0, failed: 0, usage: {}, prompts: new Set() })
  for (const e of events) {
    if (e.kind === 'prompts') prompts = e
    else if (e.kind === 'call') {
      const r = row(e.feature || 'other')
      const w = weighted(e.usage)
      r.calls += 1
      r.w += w.total
      r.w_in += w.input
      r.w_out += w.output
      r.ms += e.ms || 0
      if (e.blocked) r.blocked += 1
      if (e.ok === false) r.failed += 1
      add(r.usage, e.usage)
      if (e.prompt) r.prompts.add(e.prompt)
    } else if (e.kind === 'turn') turns.push(e)
  }
  for (const t of turns) {
    const name = t.agent ? (t.feature && t.feature !== 'main' ? t.feature : 'agent') : 'main turns'
    const r = row(name)
    const w = weighted(t.usage)
    r.calls += 1
    r.w += w.total
    r.w_in += w.input
    r.w_out += w.output
    r.ms += t.ms || 0
    r.turn = true
    r.main = !t.agent
    if (!t.agent) r.hook_ms = (r.hook_ms || 0) + (t.hook_ms || 0)
    add(r.usage, t.usage)
  }
  return { features, turns, prompts }
}

/**
 * A plain Claude Code transcript, per prompt the person typed: the turn's time (Claude Code's turn_duration) and its
 * price-weighted tokens (each API response counted once), as harness/cost.py counts them.
 */
export function plainTurns(lines) {
  const prompts = []
  const durs = []
  const per = new Map()
  for (const r of lines) {
    if (r.type === 'user' && !r.isSidechain && !r.isMeta) {
      const c = r.message?.content
      if (typeof c === 'string' && !c.startsWith('<') && r.timestamp) prompts.push({ ts: r.timestamp, text: c })
    }
    if (r.type === 'system' && r.subtype === 'turn_duration') durs.push({ ts: r.timestamp, ms: r.durationMs || 0 })
    if (r.type === 'assistant' && !r.isSidechain) {
      const m = r.message || {}
      const u = m.usage
      if (!u) continue
      const k = m.id || r.uuid
      const d = per.get(k) || { ts: r.timestamp, usage: {} }
      for (const f of Object.keys(PRICE)) d.usage[f] = Math.max(d.usage[f] || 0, u[f] || 0)
      per.set(k, d)
    }
  }
  const bucket = ts => { let b = -1; prompts.forEach((p, i) => { if (ts >= p.ts) b = i }); return b }
  const out = prompts.map(p => ({ text: p.text, ms: 0, w: 0, usage: {} }))
  for (const d of per.values()) { const b = bucket(d.ts); if (b >= 0) { out[b].w += weighted(d.usage).total; add(out[b].usage, d.usage) } }
  for (const d of durs) { const b = bucket(d.ts); if (b >= 0) out[b].ms += d.ms }
  return out
}
