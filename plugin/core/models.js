// models.js: the Claude models thimble's own calls name ($.model.complete takes Claude Code's aliases), each with its
// full name, the id Anthropic's first-party API knows it by (a request a turn.step hook names takes an id, not an
// alias: marks/register.ts, the setting Checker), the effort levels Claude Code offers for it (the setting Checker's
// Effort), and its list price in dollars per million tokens, input and output (Anthropic's first-party API rates). The
// one place to change when an alias moves to a new model or a price changes. Pure: no `$`.
//
//   ALIASES                        the aliases, from the fastest model to the strongest
//   EFFORTS                        every effort level, from the least to the most, as Claude Code names them
//   modelOf(alias)                 -> {name, id, efforts, input, output}, or null for an alias not listed
//   modelById(id)                  -> the model a request names by its id (a context window's suffix, `[1m]`, aside),
//                                     or null
//   shownName(alias)               -> the model's name as Claude Code shows it (`Haiku 5.5`), or the alias itself
//   modelNamed(name)               -> the model by that name (`Haiku 5.5`: the setting Checker saves it so), or null
//   dollars(alias, input, output)  -> the list price of `input` and `output` tokens, or null
//   aboutDollars(x)                -> a rough price in words: 'about $4', 'about $0.30', 'under $0.01'
//   firstParty(flags)              -> whether Claude Code reaches Claude through Anthropic's first-party API, which
//                                     takes these ids: `flags`, the values of CLAUDE_CODE_USE_BEDROCK, _VERTEX and
//                                     _FOUNDRY, hold none that Claude Code reads as true (1, true, yes or on)

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

const MODELS = {
  haiku: { name: 'Claude Haiku 5.5', id: 'claude-haiku-5-5', efforts: EFFORTS, input: 0.1, output: 0.5 },
  sonnet: { name: 'Claude Sonnet 5.5', id: 'claude-sonnet-5-5', efforts: EFFORTS, input: 2, output: 10 },
  opus: { name: 'Claude Opus 5.5', id: 'claude-opus-5-5', efforts: EFFORTS, input: 4, output: 20 },
  fable: { name: 'Claude Fable 5.1', id: 'claude-fable-5-1', efforts: EFFORTS, input: 10, output: 50 },
}

export const ALIASES = Object.keys(MODELS)

export function modelOf(alias) {
  return MODELS[String(alias || '').toLowerCase()] ?? null
}

export function modelById(id) {
  const bare = String(id || '').replace(/\[[^\]]*\]$/, '').trim().toLowerCase()
  return Object.values(MODELS).find(m => m.id === bare) ?? null
}

export function shownName(alias) {
  return modelOf(alias)?.name.replace(/^Claude /, '') ?? String(alias)
}

export function modelNamed(name) {
  const a = ALIASES.find(x => shownName(x) === String(name ?? '').trim())
  return a ? modelOf(a) : null
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

export function firstParty(flags) {
  return !flags.some(v => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase()))
}
