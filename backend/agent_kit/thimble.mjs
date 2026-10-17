// The `thimble` module of a JavaScript or TypeScript program that runs one of thimble's roles or tasks, the twin of
// thimble.py. A program loads it from the path thimble gives it:
//
//   const thimble = await import(process.env.THIMBLE_KIT_JS)
//   thimble.serve(async (input) => { ...; return 'what main hears' })
//
// It speaks the JSON lines docs/agents.md documents: the input comes first on stdin, the answers to requests after
// it, and the program's requests, log lines and output go on stdout. console.log, info and debug go to stderr, so
// stdout carries only these lines. thimble starts no Claude Code session for a program: a model call is ask(), and
// session() and options() throw (NO_SESSION).
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'

export const WORK = process.env.THIMBLE_WORK || '.'
export const CORPUS = process.env.THIMBLE_CORPUS || '.'
export const ROLE = process.env.THIMBLE_ROLE || ''
export const TASK = process.env.THIMBLE_TASK || ''
export const AGENT_DIR = process.env.THIMBLE_AGENT_DIR || '.'
const SLOT_RE = /\{\{([a-z_][a-z0-9_]*)\}\}/g

/** thimble refused or failed a request; the message says why. */
export class ThimbleError extends Error {}

for (const k of ['log', 'info', 'debug']) console[k] = (...args) => console.error(...args)

const waits = new Map()
let nextId = 1
let closed = false
let given
const input = new Promise((resolve) => { given = resolve })
const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (!msg || typeof msg !== 'object') return
  if ('input' in msg) given({ value: msg.input })
  else if (waits.has(msg.id)) {
    const wait = waits.get(msg.id)
    waits.delete(msg.id)
    if ('error' in msg) wait.reject(new ThimbleError(String(msg.error)))
    else wait.resolve(msg.result)
  }
})
lines.on('close', () => {
  closed = true
  given(null)
  for (const wait of waits.values()) wait.reject(new ThimbleError("thimble closed the program's input"))
  waits.clear()
})

function send(obj) {
  return new Promise((resolve) => process.stdout.write(JSON.stringify(obj) + '\n', () => resolve()))
}

/** The role's or task's input, which thimble sends first. */
export async function getInput() {
  const got = await input
  if (!got) throw new ThimbleError('thimble sent no input')
  return got.value
}

/** Send one request and wait for its answer; ThimbleError when thimble refuses or fails it. */
export function request(kind, payload) {
  if (closed) return Promise.reject(new ThimbleError("thimble closed the program's input"))
  const id = nextId++
  const answer = new Promise((resolve, reject) => waits.set(id, { resolve, reject }))
  send({ id, [kind]: payload })
  return answer
}

/** A line in the agent's thread, which the analyst sees. */
export function log(text) {
  return send({ log: String(text) })
}

/** What the role or task returns: for the orientation, the one line main hears; for a task, its output object. */
export function output(value) {
  return send({ output: value })
}

/** One of thimble's tools, called as the role calls it: {content, is_error}. */
export function tool(name, args = {}) {
  return request('tool', { name, args })
}

/** One model call on the analyst's own Claude: the object `schema` describes, or text without one. `images` are the
 * paths of pictures (PNG, JPEG, GIF or WebP) the model sees before the prompt. */
export function ask(prompt, { schema, model, images } = {}) {
  return request('ask', { prompt, ...(schema ? { schema } : {}), ...(model ? { model } : {}), ...(images?.length ? { images } : {}) })
}

// harness.NO_SESSION: thimble starts no Claude Code session for a program
export const NO_SESSION = "thimble starts no Claude Code session for a program: each model call runs as a subagent of the analyst's Claude Code session. Ask a model with `ask` instead."

/** Refused: thimble starts no Claude Code session for a program (NO_SESSION); ask() makes a model call. */
export async function session() {
  throw new ThimbleError(NO_SESSION)
}

/** thimble's own implementation of the task on `input`, on `model` in place of the task's own when given: the output
 * it returns. A role has none to lend. */
export function default_(input, { model } = {}) {
  return request('default', { input, ...(model ? { model } : {}) })
}
export { default_ as default }

/** The text of `path` (relative to the program's agent folder) with each {{slot}} filled from `slots`. */
export function prompt(path, slots = {}) {
  const text = readFileSync(isAbsolute(path) ? path : join(AGENT_DIR, path), 'utf8')
  return text.replace(SLOT_RE, (_, name) => {
    if (!(name in slots)) throw new ThimbleError(`${path}: no value for {{${name}}}`)
    return String(slots[name])
  })
}

/** Refused: an Agent SDK session of thimble's no longer exists (NO_SESSION); ask() makes a model call. */
export function options() {
  throw new ThimbleError(NO_SESSION)
}

/** Run a program: call `run` with the input, send what it returns as the output, and exit; exit 1 with the error on
 * stderr when it throws. */
export async function serve(run) {
  try {
    await output(await run(await getInput()))
  } catch (e) {
    console.error(e instanceof Error ? e.stack || e.message : String(e))
    process.exit(1)
  }
  process.exit(0)
}
