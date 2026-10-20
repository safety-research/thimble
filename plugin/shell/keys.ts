// keys.ts: a key pressed in the prompt box, answered in time.
//
// Claude Code raises prompt.edit for each edit the person makes in the prompt box, one at a time, and shows the edit at
// once; a hook's answer then replaces it. Each hook has 50 ms of its own time for its answer. The clock stops while a
// `$` call or `next` is in flight, but it runs while the hook waits for anything else: the work of the key before it,
// and the hooks worker while it draws (the plugin's hooks all run in one worker, and a state write redraws the rows
// that read it). Past the 50 ms the engine runs the hook's .catch, and when that has no answer either, the key
// stays in the prompt as typed. So a key that opened v's line, but whose answer came late, left its letter in the prompt.
//
// Here a key is two parts:
//   decide   what the key comes to, from reads alone: the box to answer (null: the key types as the editor made it)
//   work     what the key does (opens a line, closes the tray, turns a card), run after the answer is given
// The hook answers as soon as the key is decided. The work runs only when that answer was in time, so a key is either
// taken (no letter, its work done) or typed (the letter, no work): never both. The key after it is decided once that
// work is done (v, then 1 picks in v's line). When the worker is too busy for even the decision, the hook's .catch
// answers the same decision within its own grace (a second); past that too, the key types and its work does not run.
//
// A key typed before the answer to the key before it came is raised on the box as the person saw it: v taken from an
// empty prompt, then i typed at once, comes as an edit of "v" to "vi", while the editor has since taken the v out and
// shows "i". Its answer is laid over that "i" as a change from "vi". So such a key is decided on the box the shell
// answered (i on an empty prompt), and its box is given back with the taken letters in place, so the change lands on
// the box the editor shows. A letter typed so, straight after a key that may begin a word (the verb keys), is that
// word: it is answered at once with the letter given back, and the key's work is undone after it.
//
// The plugin has one prompt.edit hook (shell.tsx; the open detail's keys are decided inside it, first). It keeps one
// slot and answers in a function of its own:
//   const k = keyTake(slot, e, fresh, (on) => typesNow(on), (on) => decide($, on))
//   const t = await k.turn
//   const inTime = !next.signal.aborted
//   keyAnswered(slot, k, t, inTime)
//   if (t.box || !inTime) return t.box ?? { text: e.text, cursor: e.cursor }
//   return next(e)
// called from its hook with fresh true and from the hook's .catch with fresh false. `on` is the edit the key is decided
// on: the edit itself, or the edit on the box the shell answered the key before.

export type PromptBox = { text: string; cursor: number }
/** What a key comes to: the box the shell answers (null: the key types), and its work, run once the answer stands.
 *  A key that types and begins something (the + of a stretch) may carry the decorations its work will want on it.
 *  A taken key whose letter may begin a word carries `word`: what undoes its work when a letter follows it at once. */
export type KeyTurn = { box: PromptBox | null; work?: () => unknown; decorations?: unknown[]; word?: () => unknown }
/** The part of prompt.edit's input a key is decided from. */
export type KeyEdit = { key?: { key: string; ctrl?: true; meta?: true; shift?: true }; text: string; cursor: number; start?: number; end?: number; inputText: string }
/** A key one taker is deciding or has decided: its hook and that hook's .catch read the one decision. `after` is the
 *  box as the person's edit left it. */
export type HeldKey = { sig: string; turn: Promise<KeyTurn>; done: boolean; after: PromptBox }
/** The letters a key took from an empty prompt: the box its edit left (the letters, the cursor after them), and the
 *  key's turn. */
export type Took = PromptBox & { turn: KeyTurn }
/** The key a taker holds now, and what the key before it took (null: nothing, or its answer never stood). Claude Code
 *  raises one edit at a time, so one of each is enough. */
export type KeySlot = { held: HeldKey | null; took: Took | null }

/** The work of the keys answered so far, in order: a key is decided after it. */
let chain: Promise<unknown> = Promise.resolve()

export const keySlot = (): KeySlot => ({ held: null, took: null })

const afterOf = (e: KeyEdit): PromptBox => {
  const start = e.start ?? e.cursor
  return { text: `${e.text.slice(0, start)}${e.inputText}${e.text.slice(e.end ?? start)}`, cursor: start + e.inputText.length }
}

/** An edit made before the answer to the key before it came, when that key took its letters from an empty prompt and
 *  this edit changes nothing of them: the edit on the empty box the shell answered (`on`), and a box decided on it
 *  given back with the letters in place (`back`). Null for any other edit. */
export function earlyEdit(took: Took | null, e: KeyEdit): { on: KeyEdit; back: (b: PromptBox) => PromptBox } | null {
  if (!took || e.text !== took.text || e.cursor !== took.cursor) return null
  const n = took.text.length
  const start = e.start ?? e.cursor, end = e.end ?? start
  if (took.cursor !== n || start < n || end < start) return null
  return {
    on: { ...e, text: e.text.slice(n), cursor: e.cursor - n, start: start - n, end: end - n },
    back: b => ({ text: `${took.text}${b.text}`, cursor: b.cursor + n }),
  }
}

/**
 * The key this edit is: a new one for the hook (`fresh`), the one the hook holds for its .catch. `typesNow`: the edit
 * types whatever the shell holds (a key in a prompt with words in it), so it is decided at once, without waiting for
 * the work of the key before it. Both it and `decide` get the edit the key is decided on.
 */
export function keyTake(slot: KeySlot, e: KeyEdit, fresh: boolean, typesNow: (on: KeyEdit) => boolean, decide: (on: KeyEdit) => Promise<KeyTurn>): HeldKey {
  const sig = JSON.stringify([e.key ?? null, e.text, e.cursor, e.start ?? null, e.end ?? null, e.inputText])
  if (!fresh && slot.held && slot.held.sig === sig) return slot.held
  const early = earlyEdit(slot.took, e)
  const word = slot.took?.turn.word
  slot.took = null
  const on = early?.on ?? e
  const run = () => Promise.resolve().then(() => decide(on)).catch((): KeyTurn => ({ box: null }))
  let turn: Promise<KeyTurn>
  if (early && word && on.text === '' && /^\p{L}+$/u.test(on.inputText) && !on.key?.ctrl && !on.key?.meta) {
    // a letter straight after a key that may begin a word: the word as the person typed it (the key's letters given
    // back), and the key's work undone
    turn = Promise.resolve({ box: afterOf(e), work: word })
  } else turn = typesNow(on) ? run() : chain.then(run)
  if (early) turn = turn.then(t => (t.box ? { ...t, box: early.back(t.box) } : t))
  slot.held = { sig, turn, done: false, after: afterOf(e) }
  return slot.held
}

/** The answer is given: the key's work runs next in line. A box given too late never stood (the key typed), so its
 *  work does not run; a key that types does its work either way. Once per key. A key that took its letters from an
 *  empty prompt is kept for the key after it. */
export function keyAnswered(slot: KeySlot, k: HeldKey, t: KeyTurn, inTime: boolean): void {
  if (k.done || (t.box && !inTime)) return
  k.done = true
  if (t.box && t.box.text === '' && k.after.text !== '') slot.took = { ...k.after, turn: t }
  const work = t.work
  if (work) chain = chain.then(() => work()).catch(() => undefined)
}

/** For tests: no work waiting, and nothing held. */
export function resetKeys(...slots: KeySlot[]): void {
  chain = Promise.resolve()
  for (const s of slots) Object.assign(s, keySlot())
}
