// merge.ts: g in Your fixes, after m marked two fixes or more: they become one fix, under the first one's id. Claude
// names the one fix from the fixes' titles, words and summaries (prompts/fix-merge.md); without an answer, the first
// fix's title stands. The person's key press merges, as y applies: a secret made at this press, its sha256 in
// asks/<id>.json, the secret to `thimble fix merge … --ask -` on stdin. A fix that was on stays on, and the session
// loads it again.
import type { EngineInterface } from 'claude-code'

import { cut, cutWords } from '../core/text.js'
import { jsonIn } from '../observer/reply.mjs'
import { promptText } from '../prompts/prompts'
import { type Fix, fixOf, jsonOf, kernelFix, pressKey, refreshFixes, reloadPlugins } from './fixes'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** Claude's title and summary for the merged fix, or null when no model answered. */
export async function mergeName($: Engine, fixes: Fix[]): Promise<{ title: string; summary: string } | null> {
  const prompt = fixes.map(f => [
    `Fix ${f.id}: ${f.title}${f.state === 'request' ? ' (a request with no code)' : ''}`,
    ...(f.words || []).map((w, i) => `${i ? 'Then' : 'The person asked'}: ${w}`),
    ...(f.summary ? [`What it does: ${f.summary}`] : []),
  ].join('\n')).join('\n\n')
  try {
    const system = await promptText($, 'fix-merge')
    const r = await $.model.complete({ model: 'opus', maxTokens: 800, timeoutMs: 90000, system: [{ text: system, cache: true }], prompt } as Any) as Any
    if (!r?.isAnswered) return null
    const d = jsonIn(String(r.text || '')) as Any
    const title = cutWords(String(d?.title || '').trim(), 60)
    return title ? { title, summary: String(d?.summary || '').trim() } : null
  } catch {
    return null
  }
}

/** g: the marked fixes become one, by the person's key. What went wrong, or null. */
export async function mergeFixes($: Engine, ids: number[]): Promise<string | null> {
  if (ids.length < 2) return 'Mark two fixes or more with m, then press g to merge them.'
  const fixes = (await Promise.all(ids.map(id => fixOf($, id)))).filter((f): f is Fix => !!f)
  const named = await mergeName($, fixes)
  const secret = await pressKey($, ids[0]!)
  const r = await kernelFix($, ['merge', ...ids.map(String), '--ask', '-', ...(named ? ['--title', named.title, '--summary', named.summary] : [])],
    { stdin: secret, timeoutMs: 300000, doing: `merging fixes ${ids.join(', ')}` })
  await refreshFixes($)
  if (!r.ok) return `Fixes ${ids.join(', ')} were not merged: ${cut(r.err || 'thimble fix merge gave nothing', 220)}`
  const d = jsonOf<Any>(r.out) ?? {}
  $.ui.toast(`Fixes ${ids.join(', ')} are now fix ${ids[0]}: ${d.title || ''}${d.redo?.length ? ` · fix ${d.redo.join(', ')} needs a redo` : ''}`)
  if (d.reload && !(await reloadPlugins($))) return 'thimble changed, and Claude Code did not load it again by itself. Type /reload-plugins.'
  return null
}
