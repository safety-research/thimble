// compose.mjs: the post-turn pass, composed from its lenses. Pure: the observer (observer.ts) reads the texts from the
// registry and hands them in.
//
// A lens's fragment (prompts/lens-<name>/<version>.md) has up to three kinds of section, split by a comment line:
//   its instructions first (what it gives, its principles, its examples, its part of the reply);
//   `<!-- digest -->`, the template of what it needs to know of the state, filled by the lens's digest();
//   `<!-- when NAME -->`, a rule that holds this turn when the lens's when() names it (a backoff, a line open).
// The system prompt is the frame (prompts/observer/<version>.md) with every enabled lens's instructions at {{LENSES}}
// and the reply's skeleton at {{SKELETON}}: it changes only when a version or the set of lenses changes, so the
// prompt cache serves it. The message is the turn template (prompts/observer-turn/) with the new turn, its objects,
// and every lens's digest and rules: it never holds the session before this turn.
import { fill } from '../prompts/registry.mjs'

/** A fragment's sections: {body, digest, when: {name: text}}. */
export function sectionsOf(text) {
  const parts = String(text || '').split(/^<!--\s*([a-z][a-z -]*?)\s*-->\s*$/m)
  const out = { body: parts[0].trim(), digest: null, when: {} }
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i].trim()
    const t = String(parts[i + 1] || '').trim()
    if (name === 'digest') out.digest = t
    else if (name.startsWith('when ')) out.when[name.slice(5).trim()] = t
  }
  return out
}

/** The reply's skeleton: each enabled lens's keys once, in order. */
export function skeletonOf(lenses) {
  const seen = new Set()
  const keys = []
  for (const l of lenses) {
    if (seen.has(l.skeleton)) continue
    seen.add(l.skeleton)
    keys.push(l.skeleton)
  }
  return `{${keys.join(', ')}}`
}

/**
 * The system prompt: the frame with the lenses' instructions. Returns {text, chars: {lens: characters}, shared}.
 * @param {string} frame  @param {{lens: any, text: string}[]} parts  the enabled lenses with their fragments
 */
export function composeSystem(frame, parts) {
  const chars = {}
  const bodies = parts.map(p => {
    const b = sectionsOf(p.text).body
    chars[p.lens.name] = b.length + 2
    return b
  })
  const text = fill(frame, { LENSES: bodies.join('\n\n'), SKELETON: skeletonOf(parts.map(p => p.lens)) })
  const shared = text.length - Object.values(chars).reduce((s, n) => s + n, 0)
  return { text, chars, shared: Math.max(0, shared) }
}

/**
 * The pass's message: the turn template filled, with each lens's digest and its rules this turn. Returns {text, chars:
 * {lens: characters of its digest and rules}, shared}.
 * @param {string} template  @param {Record<string, unknown>} vals  the turn's values (QUESTION, STEPS, ANSWER, ...)
 * @param {{lens: any, text: string}[]} parts  @param {any} st  the state the digests read
 */
export function composeTurn(template, vals, parts, st) {
  const chars = {}
  const digests = []
  const rules = []
  for (const p of parts) {
    const s = sectionsOf(p.text)
    let n = 0
    if (s.digest) {
      const d = fill(s.digest, p.lens.digest(st) || {})
      digests.push(d)
      n += d.length + 2
    }
    for (const w of p.lens.when(st) || []) {
      if (!s.when[w]) continue
      rules.push(s.when[w])
      n += s.when[w].length + 2
    }
    chars[p.lens.name] = n
  }
  const text = fill(template, { ...vals, DIGEST: digests.join('\n\n'), RULES: rules.length ? `\n${rules.join('\n\n')}\n` : '' })
  const shared = text.length - Object.values(chars).reduce((s, n) => s + n, 0)
  return { text, chars, shared: Math.max(0, shared) }
}

/**
 * Each lens's share of the pass, in characters: what it put in (its fragment, its digest and rules) and what came out
 * for it (its raw part of the reply). `lean stats` prices the shares.
 */
export function sharesOf({ system, turn, lenses, raw, rawText = '' }) {
  const out = {}
  let given = 0
  for (const l of lenses) {
    const o = l.raw(raw)
    const n = o == null ? 0 : JSON.stringify(o).length
    given += n
    out[l.name] = { in: (system.chars[l.name] || 0) + (turn.chars[l.name] || 0), out: n }
  }
  return { lenses: out, shared_in: system.shared + turn.shared, shared_out: Math.max(0, String(rawText).length - given) }
}
