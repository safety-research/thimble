// sandbox.ts: runs a card's program in the page, sandboxed, for what the analyst does to the card (turns a knob,
// presses a part): the program runs again with the new state and the drawing comes back.
//
// The program runs in a Worker inside an iframe with `sandbox="allow-scripts"` (an opaque origin: no cookies, no
// storage, no access to this page) whose Content-Security-Policy allows no connection of any kind, so the program
// reaches neither the network nor the page: only the toolkit (the plugin's kit.js) and the card's data. A program that
// runs past its time limit is stopped by ending the worker. The server ran the same program once, in its own
// sandbox, for the drawing it keeps (cards/sandbox.py run_program); this one is only for what happens on the page.
import KIT_SOURCE from '../../../kit/kit.js?raw'
import type { Drawing } from './types'

const LIMIT_MS = 2000

export interface RunOpts {
  w: number
  h?: number
  mode?: string
  state?: Record<string, unknown>
  event?: Record<string, unknown>
  title?: string
  id?: string
}

let sandbox: { run: (program: string, data: unknown, opts: RunOpts) => Promise<Drawing> } | null = null

/** The page's one sandbox, made at its first use. */
export function programSandbox() {
  if (!sandbox) sandbox = makeSandbox(KIT_SOURCE)
  return sandbox
}

function makeSandbox(kitSource: string) {
  const csp = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:"
  const inner = `
    const KIT = ${JSON.stringify(kitSource)};
    const WORKER = KIT + '\\n;onmessage = e => { const m = e.data; let d; try { d = DrawKit.run(m.program, m.data, m.opts) } catch (err) { d = { error: { name: "SandboxError", message: String(err && err.message || err) } } } postMessage({ id: m.id, drawing: d }) }';
    const url = URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }));
    let worker = null, timer = null, pending = null;
    const start = () => { worker = new Worker(url); worker.onmessage = e => { clearTimeout(timer); pending = null; parent.postMessage(e.data, '*'); next() } };
    const queue = [];
    const next = () => {
      if (pending || !queue.length) return;
      pending = queue.shift();
      timer = setTimeout(() => {
        worker.terminate(); start();
        const p = pending; pending = null;
        parent.postMessage({ id: p.id, drawing: { kit: 1, w: p.opts.w, h: p.opts.h || 1, title: p.opts.title || '', regions: [], cites: {}, examples: {}, warnings: [],
          error: { name: 'TimeLimit', message: 'the program ran past its time limit and was stopped', fix: 'draw fewer rows or loop less' },
          root: { t: 'text', runs: [{ s: '× could not draw: the program ran past its time limit', tone: 'dim' }] } } }, '*');
        next();
      }, (pending.opts.limit || ${LIMIT_MS}) + 1500);
      worker.postMessage(pending);
    };
    start();
    addEventListener('message', e => { if (e.source !== parent) return; queue.push(e.data); next() });
    parent.postMessage({ ready: true }, '*');`
  const iframe = document.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden'
  iframe.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${inner.replace(/<\/script/gi, '<\\/script')}</script>`
  let seq = 0
  const waiting = new Map<number, (d: Drawing) => void>()
  let ready: () => void = () => undefined
  const isReady = new Promise<void>((r) => (ready = r))
  window.addEventListener('message', (e) => {
    if (e.source !== iframe.contentWindow) return
    const m = (e.data || {}) as { ready?: boolean; id?: number; drawing?: Drawing }
    if (m.ready) return ready()
    const w = m.id != null ? waiting.get(m.id) : undefined
    if (w && m.drawing) {
      waiting.delete(m.id!)
      w(m.drawing)
    }
  })
  document.body.appendChild(iframe)
  const plain = (v: unknown) => (v == null ? undefined : JSON.parse(JSON.stringify(v)))
  return {
    async run(program: string, data: unknown, opts: RunOpts): Promise<Drawing> {
      await isReady
      const id = ++seq
      return new Promise<Drawing>((res) => {
        waiting.set(id, res)
        iframe.contentWindow?.postMessage(
          { id, program, data: plain(data) ?? {}, opts: { w: opts.w, h: opts.h ?? 30, mode: opts.mode ?? 'inline', limit: LIMIT_MS, state: plain(opts.state), event: plain(opts.event), title: opts.title, id: opts.id, surface: 'browser' } },
          '*',
        )
      })
    },
  }
}
