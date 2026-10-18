// registry.mjs: the verbs, found by folder. A verb is a folder `lean/verbs/<name>/` that holds:
//
//   verb.json   {"key": "s", "name": "squeeze", "line": "one line on what it does", ...any other field}
//   run.mjs     export async function run(ctx) -> {object?, text?, note?, ask?}   (verb.mjs builds ctx)
//   SKILL.md    the verb's one-page skill for Claude; the plugin lists ./verbs/ as a skills folder
//   hint.mjs    optional: export function applies(object, {drawing}) -> a short phrase for THIS object, or null
//
// Nothing else registers a verb: adding the folder adds it, to the hint row, to the `?` list and to /verb. The
// registry keeps every field of verb.json as given and checks none against a schema.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const VERBS = fileURLToPath(new URL('../../verbs/', import.meta.url))

/**
 * Every verb folder under `dir`, in the order of their `order` field (absent: after those that have one), then by
 * name. A folder without verb.json or run.mjs is left out and said in `problems`; so is a second verb on one key.
 * @returns {{verbs: object[], problems: string[]}}
 */
export function listVerbs(dir = VERBS) {
  const verbs = []
  const problems = []
  let names = []
  try { names = readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name) } catch { names = [] }
  for (const folder of names.sort()) {
    const at = join(dir, folder)
    let spec
    try { spec = JSON.parse(readFileSync(join(at, 'verb.json'), 'utf8')) } catch (e) {
      problems.push(`${folder}: no readable verb.json (${String(e.message || e).slice(0, 120)})`)
      continue
    }
    if (!existsSync(join(at, 'run.mjs'))) { problems.push(`${folder}: no run.mjs`); continue }
    const verb = { ...spec, name: String(spec.name || folder), folder, dir: at, hasHint: existsSync(join(at, 'hint.mjs')), hasSkill: existsSync(join(at, 'SKILL.md')) }
    if (verb.key != null) verb.key = String(verb.key).slice(0, 1).toLowerCase()
    if (verb.key && !/^[a-z0-9]$/.test(verb.key)) { problems.push(`${folder}: key "${verb.key}" is not one letter or digit; it has no key`); delete verb.key }
    const taken = verb.key && verbs.find(v => v.key === verb.key)
    if (taken) { problems.push(`${folder}: key "${verb.key}" is ${taken.name}'s already; it has no key`); delete verb.key }
    verbs.push(verb)
  }
  const ord = v => (typeof v.order === 'number' ? v.order : 1e6)
  verbs.sort((a, b) => ord(a) - ord(b) || a.name.localeCompare(b.name))
  return { verbs, problems }
}

/** A verb by its name, folder or key. */
export function findVerb(verbs, word) {
  const w = String(word || '').trim().toLowerCase()
  if (!w) return null
  return verbs.find(v => v.name.toLowerCase() === w) || verbs.find(v => v.folder.toLowerCase() === w) || verbs.find(v => v.key === w) || null
}

/** The verb's phrase for this object: its hint.mjs's applies(object, {drawing}), or null (no hint.mjs, null, or it
 *  threw). `drawing` is the object as the person sees it, when the caller drew it. */
export async function phraseFor(verb, object, extra = {}) {
  if (!verb.hasHint) return null
  try {
    const mod = await import(pathToFileURL(join(verb.dir, 'hint.mjs')).href)
    const p = typeof mod.applies === 'function' ? await mod.applies(object, extra) : null
    return typeof p === 'string' && p.trim() ? p.trim().slice(0, 200) : null
  } catch { return null }
}

/**
 * Every verb with its phrase for this object and whether it is picked for the hint row. The rule, until the observer
 * ranks the row (lean/observer/, applied in the shell by object.js rankRow): the verbs the object names in its own
 * `hints` field first (Claude's ranking), then the verbs whose hint.mjs has a phrase for it, by their `order` field, at
 * most `max`. With none of either, none is picked: the row shows `? all` alone.
 */
export async function verbsFor(object, { dir = VERBS, max = 3, drawing = null } = {}) {
  const { verbs, problems } = listVerbs(dir)
  const out = []
  for (const v of verbs) {
    out.push({ key: v.key || null, name: v.name, line: String(v.line || ''), folder: v.folder, phrase: await phraseFor(v, object, { drawing }), extra: extraFields(v) })
  }
  const named = (Array.isArray(object?.hints) ? object.hints : []).map(h => findVerb(verbs, typeof h === 'string' ? h : h?.verb || h?.name)).filter(Boolean)
  const picked = []
  for (const v of named) if (!picked.includes(v.name)) picked.push(v.name)
  for (const v of out) if (picked.length < max && v.phrase && !picked.includes(v.name)) picked.push(v.name)
  for (const v of out) v.picked = picked.slice(0, max).includes(v.name)
  // the hint row's order: the picked ones in their picked order
  out.sort((a, b) => (a.picked === b.picked ? (a.picked ? picked.indexOf(a.name) - picked.indexOf(b.name) : 0) : a.picked ? -1 : 1))
  return { verbs: out, problems }
}

function extraFields(v) {
  const { key, name, line, folder, dir, hasHint, hasSkill, ...rest } = v
  return rest
}
