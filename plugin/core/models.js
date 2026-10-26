// models.js: the Claude models thimble's own calls name ($.model.complete takes Claude Code's aliases), each with its
// full name and its list price in dollars per million tokens, input and output (Anthropic's first-party API rates).
// The one place to change when an alias moves to a new model or a price changes. Pure: no `$`.
//
//   modelOf(alias)                 -> {name, input, output}, or null for an alias not listed
//   dollars(alias, input, output)  -> the list price of `input` and `output` tokens, or null
//   aboutDollars(x)                -> a rough price in words: 'about $4', 'about $0.30', 'under $0.01'

const MODELS = {
  opus: { name: 'Claude Opus 5.5', input: 4, output: 20 },
  sonnet: { name: 'Claude Sonnet 5.5', input: 2, output: 10 },
  haiku: { name: 'Claude Haiku 5.5', input: 0.1, output: 0.5 },
}

export function modelOf(alias) {
  return MODELS[String(alias || '').toLowerCase()] ?? null
}

export function dollars(alias, input, output) {
  const m = modelOf(alias)
  if (!m) return null
  return (Math.max(0, Number(input) || 0) * m.input + Math.max(0, Number(output) || 0) * m.output) / 1e6
}

export function aboutDollars(x) {
  const v = Number(x)
  if (!Number.isFinite(v) || v < 0) return ''
  if (v < 0.01) return 'under $0.01'
  if (v < 1) return `about $${(Math.round(v * 20) / 20 || 0.01).toFixed(2)}`
  if (v < 10) return `about $${Math.round(v)}`
  return `about $${Math.round(v / 5) * 5}`
}
