// events.mjs: the lines thimble's telemetry writes to the session's events, and how `thimble stats` reads them. Pure.
//
// The session's events are one file, $THIMBLE_HOME/lean/events/<session>.jsonl: the one append-only log of the session,
// which the kernel writes its saves to (`thimble save`, the change feed the shell reads saves from) and telemetry writes
// its lines to. It is under THIMBLE_HOME, not the data folder's thimble/, because a session's log starts before any
// data folder is known (the first turn, the prompt versions in use, the observer's first look come before `thimble` has
// found a root, and the hooks learn the root only from the first object), and because the kernel writes nothing into a
// folder that holds no data (a coding session gets no thimble/ folder). Readers skip the kinds they do not know.
// Telemetry adds:
//
//   {kind: 'call', feature, prompt, model, usage, ms, blocked, ok, ...}   one model call thimble made: the observer's
//        pass (with `lenses`: each lens's characters in and out) and question step, a squeeze rewrite, a verb's call.
//        `blocked`: whether the main turn waited for it (thimble's calls run after the turn, so false).
//   {kind: 'turn', feature, agent, ms, usage, model, hook_ms, reason}     one turn: main's (feature 'main', or the verb
//        whose request started it, such as 'visualize'), or a subagent's (feature 'thread' for a side thread).
//        `hook_ms`: the time thimble's own hooks took inside a main turn, which is the latency thimble adds to it.
//   {kind: 'prompts', active: {feature: version}, problems}              the versions in use, once per session
//   {kind: 'prompt', feature, prompt, via}                               a text read on demand (`thimble guide cards`)
//   {kind: 'look', turn, lit, v, observer, prompts, skip?, shadow?}      one look of the observer after a turn: the verbs
//        it lit (`v`: its note and proposals, or null), or why it skipped. With `shadow` (THIMBLE_PROMPTS_SHADOW), what
//        a second pass with other versions would have lit; its call line carries the same `shadow`.
//   {kind: 'press', verb, row, lit}                                       the person pressed a verb under a message,
//        `lit`: whether it was lit then
//   {kind: 'key', key, on}                                               a key thimble took from the prompt, and what had
//        the keys (rest, card, tray, chips, proposals, detail): what people use
//   {kind: 'check', id, v, tried, total, failed, cut, ms, chars}          a save's card had its interactions tried once
//        (draw/exercise.mjs): how many, how many failed, the milliseconds it added to the save, and the characters of
//        the line Claude read about it (0 when all ran)

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

export const safeName = s => String(s || '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120) || 'none'

/** Where a session's events are. */
export const eventsFile = (home, session) => `${String(home).replace(/\/+$/, '')}/lean/events/${safeName(session)}.jsonl`

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

/**
 * A session's events summed per feature: calls (count, price-weighted tokens, seconds, how many blocked the main turn)
 * and turns (main and agents), with each lens's share of the observer's pass. The lens shares split the pass's input
 * by the characters each lens put in (its fragment, its part of the digest) and its output by the characters of its
 * part of the reply, so the lens rows add up to the pass, with the shared part (the frame and the turn) on its own row.
 */
export function summarize(events) {
  const features = {}
  const turns = []
  let prompts = null
  const reads = []
  const looks = []
  const presses = []
  const checks = []
  const row = name => (features[name] ??= { feature: name, calls: 0, w: 0, w_in: 0, w_out: 0, ms: 0, blocked: 0, failed: 0, usage: {}, prompts: new Set(), lenses: null })
  for (const e of events) {
    if (e.kind === 'prompts') prompts = e
    else if (e.kind === 'prompt') reads.push(e)
    else if (e.kind === 'look') looks.push(e)
    else if (e.kind === 'press') presses.push(e)
    else if (e.kind === 'check') checks.push(e)
    else if (e.kind === 'call') {
      // a shadow pass (the same turn with other versions, measured only) is a row of its own
      const r = row(e.shadow ? `${e.feature || 'other'} (shadow)` : e.feature || 'other')
      if (e.shadow) r.shadow = String(e.shadow)
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
      if (e.lenses && typeof e.lenses === 'object') {
        r.lenses ??= {}
        const tin = Object.values(e.lenses).reduce((s, x) => s + (x.in || 0), 0) + (e.shared_in || 0)
        const tout = Object.values(e.lenses).reduce((s, x) => s + (x.out || 0), 0) + (e.shared_out || 0)
        const part = (name, i, o) => {
          const L = (r.lenses[name] ??= { w: 0, w_in: 0, w_out: 0, ms: 0, prompts: new Set() })
          const fi = tin ? i / tin : 0
          const fo = tout ? o / tout : 0
          L.w_in += fi * w.input
          L.w_out += fo * w.output
          L.w += fi * w.input + fo * w.output
          L.ms += fo * (e.ms || 0)
          return L
        }
        for (const [name, x] of Object.entries(e.lenses)) {
          const L = part(name, x.in || 0, x.out || 0)
          if (x.prompt) L.prompts.add(x.prompt)
        }
        part('(shared: frame and turn)', e.shared_in || 0, e.shared_out || 0)
      }
    } else if (e.kind === 'turn') turns.push(e)
  }
  for (const t of turns) {
    const name = t.agent ? (t.feature && t.feature !== 'main' ? t.feature : 'agent') : t.feature === 'main' || !t.feature ? 'main turns' : `${t.feature} (main turns)`
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
  return { features, turns, prompts, reads, looks: looksOf(looks, presses), checks: checksOf(checks) }
}

/** The saves whose interactions were tried: how many, the tries, the failures, the median and largest milliseconds
 *  added to a save, and the characters Claude read about failures. Null with none. */
export function checksOf(list) {
  if (!list.length) return null
  const ms = list.map(c => Number(c.ms) || 0).sort((a, b) => a - b)
  return {
    saves: list.length,
    tried: list.reduce((n, c) => n + (c.tried || 0), 0),
    failed: list.filter(c => c.failed).length,
    cut: list.filter(c => c.cut).length,
    median_ms: ms[Math.floor((ms.length - 1) / 2)],
    max_ms: ms[ms.length - 1],
    chars: list.reduce((n, c) => n + (c.chars || 0), 0),
  }
}

/**
 * How often the observer lit v, and whether the person pressed it: looks that ran (not skipped), the ones that lit v,
 * and the presses of v that came when it was lit or dim; a shadow pass's looks counted apart, per spec.
 */
export function looksOf(looks, presses = []) {
  const count = list => ({ looks: list.filter(l => !l.skip).length, skipped: list.filter(l => l.skip).length, v_lit: list.filter(l => !l.skip && (l.v || (Array.isArray(l.lit) && l.lit.includes('v')))).length })
  const shadow = {}
  for (const l of looks.filter(x => x.shadow)) (shadow[l.shadow] ??= []).push(l)
  const v = presses.filter(p => p.verb === 'v')
  return {
    ...count(looks.filter(l => !l.shadow)),
    pressed_lit: v.filter(p => p.lit).length,
    pressed_dim: v.filter(p => !p.lit).length,
    shadow: Object.fromEntries(Object.entries(shadow).map(([k, list]) => [k, count(list)])),
  }
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
