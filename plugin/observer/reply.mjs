// reply.mjs: how the observer reads a look's reply. No `$`, no Node, no DOM: the hooks module imports it, and the tests
// run it under Node.
//
//   jsonIn(text)        -> the JSON object in a model's text (the first `{` to the last `}`), or null
//   parseAnswer(text)   -> {glosses, heads, claims, clusters} from the look's reply, read leniently, or null

export function jsonIn(text) {
  const t = String(text || '')
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(t.slice(a, b + 1))
  } catch {
    return null
  }
}

/** The look's reply, read leniently: each lens's part as given (each feature checks its own: explain/, claims/). */
export function parseAnswer(text) {
  const d = jsonIn(text)
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  const glosses = Array.isArray(d.glosses) ? d.glosses : []
  const heads = d.heads && typeof d.heads === 'object' && !Array.isArray(d.heads) ? d.heads : null
  const claims = Array.isArray(d.claims) ? d.claims : []
  const clusters = Array.isArray(d.clusters) ? d.clusters : []
  return { glosses, heads, claims, clusters }
}
