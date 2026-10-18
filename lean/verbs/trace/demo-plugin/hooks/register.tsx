// The Trace verb in a Claude Code session, until the shell's t key lands. The slash command /t stands in for the key
// (the plugin's skill already takes the name /trace):
//
//   /t <what you see>        a number or the words of a citation in Claude's answers ("3,934", "REVIEW WANTED"), or a
//                            ref (q2#…@n, obj:…#/…, a row, a transcript block): the short path, drawn in the transcript
//   /t step <part>           t on one step of the trace shown last: trace on from there
//   /t full [question]       t on the trace itself: Claude writes the full trace for this case (one model call over
//                            this session, $.model.fork), checked in the sandbox before it is drawn
//   /t open [part]           the trace shown last in the browser, with the part selected (the draw contract's page
//                            and handoff: #o=<id>@<v>&r=<part>)
//
// The command is the person's own act, as the key will be, and it adds no tool for the model. What the person sees
// also reaches Claude as context (the verb's note), so a follow-up question knows what was traced.
// run.js and the renderer modules are copies (hooks/lib, sync.mjs); programs run in a Node child, sandbox-node.mjs,
// under --permission, as the draw demo does.
import type { Register } from 'claude-code'

import { paintGrid } from './lib/paint.js'
import { isRef, run } from './lib/run.js'
import { gridText, renderTerm } from './lib/term.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Shown = { object: Any; drawing: Any; grid: ReturnType<typeof renderTerm>; w: number }

const byArgs = new Map<string, Shown>()
const versions = new Map<string, number>()
let last: Shown | null = null
let theme: 'dark' | 'light' = 'dark'
let work = ''

function dirs($: Any) {
  const trace = String($.plugin.root).replace(/\/+$/, '').replace(/\/demo-plugin$/, '')
  const lean = trace.replace(/\/verbs\/trace$/, '')
  return { trace, draw: `${lean}/draw`, bin: `${lean}/bin/lean` }
}

async function sandbox($: Any, object: Any, w: number): Promise<Any> {
  const { draw } = dirs($)
  const r = await $.process.run(['node', '--permission', `--allow-fs-read=${draw}`, `${draw}/sandbox-node.mjs`], {
    stdin: JSON.stringify({ program: object.program, data: object.data, w, h: 24 }),
    timeoutMs: 20000,
  })
  if (r.exitCode !== 0) throw new Error(`the sandbox did not run: ${String(r.stderr).slice(0, 300)}`)
  return JSON.parse(r.stdout)
}

const digits = (s: string) => s.replace(/[,\s]/g, '').toLowerCase()

/** The newest citation in Claude's answers whose words hold what the person typed: {ref, label}; else the citation
 *  of the newest quote that holds those words, with the words to follow ({ref, label, text}), as selecting words in a
 *  quote and pressing t would give. */
async function citationFor($: Any, words: string): Promise<{ ref: string; label: string; text?: string } | null> {
  const msgs = (await $.session.messages({ as: 'api' })) as Any[]
  const want = digits(words.replace(/^["“]|["”]$/g, ''))
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'assistant') continue
    for (const b of [...(msgs[i].content || [])].reverse()) {
      if (b.type !== 'text') continue
      const links = [...String(b.text).matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/g)].reverse()
      const hit = links.find(m => digits(m[1]).replace(/^["“]|["”]$/g, '') === want) || links.find(m => digits(m[1]).includes(want))
      if (hit && isRef(hit[2].trim())) return { ref: hit[2].trim(), label: hit[1].replace(/^["“]|["”]$/g, '') }
    }
  }
  const plain = words.replace(/^["“]|["”]$/g, '')
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'assistant') continue
    for (const b of msgs[i].content || []) {
      if (b.type !== 'text') continue
      // a quote and its citation, in reading order: the first paragraph (or quoted block) of the newest answer that
      // holds the words, and the first ref after them
      for (const para of String(b.text).split(/\n\s*\n/)) {
        const at = para.toLowerCase().indexOf(plain.toLowerCase())
        if (at < 0) continue
        const link = [...para.slice(at).matchAll(/\]\(([^)\n]+)\)/g)].map(m => m[1].trim()).find(isRef)
        if (link) return { ref: link, label: plain, text: plain }
      }
    }
  }
  return null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 't',
      description: 'Trace a number, a quote or a line: where it came from and where it went (the t key)',
      argumentHint: '<a number or quote you see | ref> | step <part> | full [question]',
    })
    work = `${String((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')}/lean-trace`
    try {
      const row = (await $.config.list()).find((r: Any) => r.key === 'theme')
      theme = String(row?.value ?? 'dark').startsWith('light') ? 'light' : 'dark'
    } catch { theme = 'dark' }
    return next(e)
  })

  on('command.run', { command: 't' }, async ($, e) => {
    const d = dirs($)
    const args = e.args.trim()
    const session = String(await $.session.id())
    const w = Math.max(60, Math.min(140, e.presentation.columns - 4))
    const ctx: Any = {
      w,
      kernel: async (a: string[]) => {
        const r = await $.process.run([d.bin, ...a], { env: { LEAN_SESSION: session }, timeoutMs: 300000 })
        if (r.exitCode !== 0) throw new Error(String(r.stdout || r.stderr).trim().split('\n').slice(-1)[0])
        return r.stdout
      },
      draw: { runProgram: (o: Any, opt: Any) => sandbox($, o, opt?.w || w) },
      // a fork reads this session as Claude last sent it; a session resumed before its first request has nothing to
      // fork yet, so one plain completion on the session's model stands in
      model: async (prompt: string) => {
        let r: Any = await $.model.fork({ prompt })
        if (!r.isAnswered && r.reason === 'nothing-to-fork') r = await $.model.complete({ model: await $.session.model(), prompt, maxTokens: 16000 })
        if (!r.isAnswered) throw new Error(`no reply (${r.reason})`)
        return String(r.text)
      },
      skill: await $.fs.read(`${d.trace}/SKILL.md`),
      toolkit: await $.fs.read(`${d.draw}/TOOLKIT.md`),
    }
    const [head, ...rest] = args.split(/\s+/)
    if (head === 'open') {
      if (!last) return { text: 'Trace something first: /t <a number or quote you see>.' }
      const page = `${work}/trace.html`
      const built = await $.process.run(['node', `${d.draw}/browser/build.mjs`, page, 'none', '--objects', `${work}/objects`], { timeoutMs: 30000 })
      if (built.exitCode !== 0) return { text: `The browser page was not built: ${String(built.stderr || built.stdout).trim().split('\n')[0]}` }
      const hash = new URLSearchParams({ o: `${last.object.id}@${last.object.v}`, ...(rest[0] ? { r: rest[0] } : {}), w: String(last.w) })
      const url = `file://${page}#${hash}`
      const browser = await $.env.get('BROWSER')
      for (const argv of browser ? [[browser, url]] : [['xdg-open', url], ['open', url]]) {
        const r = await $.process.run(argv, { timeoutMs: 15000 }).catch(() => null)
        if (r && r.exitCode === 0) return { text: `Opened ${last.object.id}${rest[0] ? ' at ' + rest[0] : ''} in the browser.` }
      }
      return { text: `Could not open a browser. The page: ${url}` }
    }
    if (!args) return { text: 'Type /t and a number or quote from an answer (/t 3,934), or a ref. Then /t step <part> or /t full.' }
    if (head === 'full' || head === 'step') {
      if (!last) return { text: 'Trace something first: /t <a number or quote you see>.' }
      ctx.object = last.object
      ctx.drawing = last.drawing
      if (head === 'full') { ctx.full = true; ctx.ask = rest.join(' ') || undefined } else ctx.region = rest[0]
    } else if (isRef(head)) {
      ctx.ref = head
      if (rest.length) ctx.text = rest.join(' ').replace(/^["“]|["”]$/g, '')
    } else {
      const c = await citationFor($, args)
      if (!c) return { text: `No citation in Claude's answers shows "${args}". Type the number or words as the answer shows them, or a ref.` }
      ctx.ref = c.ref
      ctx.label = c.label
      if (c.text) ctx.text = c.text
    }
    const out = await run(ctx)
    const context: string[] = []
    if (out.note) context.push(out.note)
    if (!out.object) return { text: out.text || 'Nothing to draw.', context }
    const v = (versions.get(out.object.id) || 0) + 1
    versions.set(out.object.id, v)
    out.object.v = v
    await $.fs.write(`${work}/objects/${out.object.id}.json`, JSON.stringify(out.object)).catch(() => undefined)
    const drawing = await sandbox($, out.object, w)
    const grid = renderTerm(drawing, { w })
    last = { object: out.object, drawing, grid, w }
    byArgs.set(args, last)
    context.push(`It reads:\n${gridText(grid)}`)
    return { text: (out.text ? out.text + '\n' : '') + '```\n' + gridText(grid) + '\n```', context }
  })

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.command !== 't' || e.props.isErrored) return next(e)
    const shown = byArgs.get(e.props.args.trim())
    if (!shown) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const body = paintGrid(shown.grid, els, { theme, key: 'trace-' + e.props.args.trim().replace(/[^A-Za-z0-9]+/g, '-') })
    const parts = shown.grid.regions.filter((r: Any) => r.rects.length && r.meta?.ref).map((r: Any) => r.id)
    const hint = (shown.object.full ? '' : `/t full · /t step ${parts.slice(0, 4).join('|')}${parts.length > 4 ? '|…' : ''} · `) + '/t open [part]'
    return Box({ flexDirection: 'column', children: [body, Text({ dimColor: true, wrap: 'truncate-end', children: hint })] })
  })
}
