// cli.mjs: Explore from a shell, until the shell's inline objects land, and the Node host the tests use.
//
//   node lean/verbs/explore/cli.mjs [OBJECT] [--keys "right right tab enter"] [--state id=value ...] [--select ID]
//                                   [--w 100] [--root DIR] [--text] [--light]
//
// OBJECT is an object's id or name in DIR/thimble/objects (default: the newest). It prints what Explore does: the
// view with its hint row, after pressing each key in --keys, or the note it would send Claude.
// nodeCtx(root) is the ctx run() takes, for Node: the kernel through the `lean` command, programs in the vm sandbox.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hex } from '../../draw/palette.js'
import { runProgram } from '../../draw/sandbox-node.mjs'
import { press, run } from './run.mjs'
import { viewLines } from './view.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const LEAN = join(HERE, '..', '..', 'bin', 'lean')

/** The ctx for run() and press() in Node, over the folder `root`. */
export function nodeCtx(root, o = {}) {
  const objects = () => {
    const d = join(root, 'thimble', 'objects')
    return existsSync(d) ? readdirSync(d).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(readFileSync(join(d, f), 'utf8'))) : []
  }
  const kernel = {
    resolve: async (ref, { n = 5 } = {}) => JSON.parse(execFileSync(o.lean || LEAN, ['resolve', ref, '--json', '-n', String(n)], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })),
    rows: async (ref, { n = 5, fields = [] } = {}) => execFileSync(o.lean || LEAN, ['rows', ref, '-n', String(n), '--first', '--width', '200', ...(fields.length ? ['--fields', fields.join(',')] : [])], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
      .split('\n').map(l => /^(\S+#\S+) {2}(.*)$/.exec(l)).filter(Boolean).map(m => { let value = m[2]; try { value = JSON.parse(m[2]) } catch (e) { /* a text row */ } return { ref: m[1], value } }),
    list: async () => objects(),
    load: async name => objects().find(x => x.id === name || x.id.replace(/^\d+-/, '') === name) || null,
  }
  const draw = { run: async (object, opts) => runProgram(object, opts) }
  return { kernel, draw, w: o.w || 100, h: o.h || 24, skill: join(HERE, 'SKILL.md'), check: `node ${join(HERE, 'cli.mjs')} --text` }
}

/** Lines of segments as text with 24-bit color, or plain. */
export function toAnsi(lines, { theme = 'dark', plain = false } = {}) {
  if (plain) return lines.map(l => l.map(x => x.s).join('').replace(/\s+$/, '')).join('\n')
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(';')
  const paper = hex('paper', theme)
  return lines.map(l => l.map(x => {
    const bg = x.sel ? hex('select', theme) : x.bg ? hex(x.bg, theme) : paper
    return `\x1b[${x.b ? '1;' : '0;'}${x.u ? '4;' : ''}38;2;${rgb(hex(x.tone || 'ink', theme))};48;2;${rgb(bg)}m${x.s}`
  }).join('') + '\x1b[0m').join('\n')
}

async function main() {
  const args = process.argv.slice(2)
  const flag = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d }
  const all = name => args.flatMap((a, i) => a === name ? [args[i + 1]] : [])
  const takes = ['--keys', '--state', '--select', '--w', '--root']
  const what = args.find((a, i) => !a.startsWith('--') && !(i > 0 && takes.includes(args[i - 1])))
  const root = flag('--root', process.cwd())
  const w = Number(flag('--w', 100))
  const ctx = nodeCtx(root, { w })
  const objs = await ctx.kernel.list()
  ctx.object = what ? await ctx.kernel.load(what) : objs.sort((a, b) => String(a.updated).localeCompare(String(b.updated))).pop() || null
  if (what && !ctx.object) { console.error(`no object ${what} in ${root}/thimble/objects`); process.exit(1) }
  ctx.state = Object.fromEntries(all('--state').map(s => { const [k, ...v] = s.split('='); let x = v.join('='); try { x = JSON.parse(x) } catch (e) { /* a word */ } return [k, x] }))
  ctx.region = flag('--select', null)
  ctx.open = args.includes('--open')
  const r = await run(ctx)
  if (!r.view) { console.log(r.text); console.log('\nnote to Claude: ' + r.note); return }
  let view = r.view
  for (const k of String(flag('--keys', '')).split(/\s+/).filter(Boolean)) view = await press(view, k, ctx)
  console.log(toAnsi(viewLines(view, { w }), { theme: args.includes('--light') ? 'light' : 'dark', plain: args.includes('--text') }))
  if (r.note) console.log('\nnote to Claude: ' + r.note)
  for (const x of view.drawing.warnings || []) console.log('warning: ' + x)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error(e && e.stack || e); process.exit(1) })
