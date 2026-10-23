// share.ts: sharing a fix as a public GitHub issue, from Your fixes (s). Claude writes a title, what was wrong and how
// it was fixed, in one model call (prompts/fix-draft.md). `thimble fix share ID` (engine/kernel/share.py) takes the
// person's names and values out of it with the privacy scan and gives GitHub's new-issue link with the text. o opens it
// in their browser; they read the text there, paste a screenshot if they want and press Submit on GitHub. thimble
// sends nothing.
//
//   drafted($, id)        Claude's title, wrong and fixed for one fix (the old submit flow reads its summary too)
//   shareFixes($, ids)    s in Your fixes: each fix drafted, then its GitHub link made (not opened)
//   openOnGitHub($, id)   o: GitHub's new-issue page with the fix's text, from the same draft, with no model call
//
//   state: fixShare (the fixes the last s shared, each with what the kernel said or why it did not)
import type { EngineInterface } from 'claude-code'

import { cut, cutWords } from '../core/text.js'
import { modelWhy } from '../core/why.js'
import { jsonIn } from '../observer/reply.mjs'
import { promptText } from '../prompts/prompts'
import { tracked } from '../telemetry/telemetry'
import { diffText, fixOf, jsonOf, kernelFix } from './fixes'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const SHARE = { plugin: 'thimble', key: 'fixShare' } as const

/** What `thimble fix share ID --json` said of one fix, or why it was not shared (`problem`). `note`: why Claude did
 *  not write the text, when it did not. */
export type Shared = {
  id: number; title: string; took?: string; opened?: boolean; url?: string; shortened?: boolean
  text?: string; note?: string; problem?: string
}
export type ShareState = { ids: number[]; items: Shared[]; pending: boolean }

export async function shareNow($: Engine): Promise<ShareState | null> {
  return ((await $.state.get(SHARE)).value ?? null) as ShareState | null
}

/** Claude's text for one fix: one model call over the person's words, what the fixer said, the change. A string is
 *  why there is none. */
export async function drafted($: Engine, id: number): Promise<{ title: string; wrong: string; fixed: string; summary: string } | string> {
  const f = await fixOf($, id)
  if (!f) return `There is no fix ${id}.`
  const diff = f.commit ? await diffText($, id) : ''
  const prompt = [
    "The person's words, each round:", ...(f.words || []).map((w, i) => `<round n="${i + 1}">${w}</round>`), '',
    `What the fix does, as its author said it: ${f.summary || '(nothing said)'}`, '',
    `Files: ${(f.files || []).map(x => `${x.path} +${x.add ?? 0} −${x.del ?? 0}`).join('; ') || 'none (a request with no code)'}`,
    `Tests: ${f.tests || 'not run'}`, '',
    'The change:', '<diff>', cut(diff, 24000), '</diff>',
  ].join('\n')
  let r: Any
  try {
    const system = await promptText($, 'fix-draft')
    const req = { model: 'opus', maxTokens: 2000, timeoutMs: 120000, system: [{ text: system, cache: true }], prompt }
    r = await tracked($, { feature: 'fix', prompt: 'fix-draft', doing: `writing fix ${id} to share`, model: req.model, extra: { fix: id } }, () => $.model.complete(req as Any))
  } catch (err) {
    return `Claude did not write the text: ${String((err as Error)?.message || err).slice(0, 200)}`
  }
  if (!r?.isAnswered) return `Claude did not write the text: ${modelWhy(r) || 'no answer'}`
  const d = jsonIn(String(r.text || '')) as Any
  const title = cutWords(String(d?.title || f.title || '').trim(), 72)
  const wrong = String(d?.wrong || '').trim()
  const fixed = String(d?.fixed || '').trim()
  if (!title) return 'Claude wrote no title.'
  return { title, wrong, fixed, summary: [wrong, fixed].filter(Boolean).join(' ') }
}

async function shareOne($: Engine, id: number, draft: { title: string; wrong: string; fixed: string } | null, open = false): Promise<Shared> {
  const args = ['share', String(id), '--json', ...(open ? ['--open'] : []), ...(draft ? ['--draft', '-'] : [])]
  const r = await kernelFix($, args, { ...(draft ? { stdin: JSON.stringify(draft) } : {}), timeoutMs: 180000, doing: `sharing fix ${id}` })
  const out = r.ok ? jsonOf<Any>(r.out) : null
  if (!out) return { id, title: (await fixOf($, id))?.title || `fix ${id}`, problem: `Fix ${id} was not shared: ${cut(r.err || 'thimble fix share gave nothing', 200)}` }
  return { id, title: String(out.title || ''), took: String(out.took || ''), opened: !!out.opened, url: String(out.url || ''), shortened: !!out.shortened, text: String(out.text || '') }
}

/** s in Your fixes: for each fix, Claude's text, then its GitHub link. Nothing is sent or opened. When Claude writes no
 *  text, the issue has the person's words and what the fixer said, and the pane says why. */
export async function shareFixes($: Engine, ids: number[]): Promise<void> {
  await $.state.set(SHARE, { ids, items: [], pending: true } as never)
  const items: Shared[] = []
  for (const id of ids) {
    const d = await drafted($, id)
    const one = await shareOne($, id, typeof d === 'string' ? null : { title: d.title, wrong: d.wrong, fixed: d.fixed })
    if (typeof d === 'string' && !one.problem) one.note = `${d.replace(/\.$/, '')}; the issue has your words and what the fix does.`
    items.push(one)
    await $.state.set(SHARE, { ids, items: [...items], pending: items.length < ids.length } as never)
  }
}

/** o: GitHub's new-issue page with the fix's text, the text it was made with (no model call), in the person's browser. */
export async function openOnGitHub($: Engine, id: number): Promise<string | null> {
  const one = await shareOne($, id, null, true)
  const s = await shareNow($)
  if (s) await $.state.set(SHARE, { ...s, items: s.items.map(x => (x.id === id ? { ...one, note: x.note } : x)) } as never)
  return one.problem ?? (one.opened ? null : 'No browser to open here: c copies the link, to open on your computer.')
}

/** c: the GitHub link on the clipboard, for a machine with no browser. */
export async function copyLink($: Engine, url: string): Promise<string> {
  let r: Any
  try {
    r = await $.ui.copy({ text: url })
  } catch (err) {
    r = { isCopied: false, reason: String((err as Error)?.message || err) }
  }
  return r?.isCopied ? 'Copied the GitHub link. Open it in a browser on your computer.' : `The link was not copied: ${r?.reason || 'no reason given'}. In a shell, thimble fix share prints it.`
}
