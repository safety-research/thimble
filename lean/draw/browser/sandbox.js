// sandbox.js: run object programs in the browser, sandboxed, and get their drawings back.
//
// The program runs in a Worker inside an iframe with `sandbox="allow-scripts"` (an opaque origin: no cookies, no
// storage, no access to this page) whose Content-Security-Policy allows no connection of any kind, so the program
// can reach neither the network nor the page: only the toolkit (kit.js) and the object's data. A program that runs
// past its time limit is stopped by ending the worker.

export function makeSandbox(kitSource, { limit = 2000 } = {}) {
  const csp = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:"
  const inner = `
    const KIT = ${JSON.stringify(kitSource)};
    const WORKER = KIT + '\\n;onmessage = e => { const m = e.data; let d; try { d = DrawKit.run(m.program, m.data, m.opts) } catch (err) { d = { error: { name: "SandboxError", message: String(err && err.message || err) } } } postMessage({ id: m.id, drawing: d }) }';
    const url = URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }));
    let worker = null, timer = null, pending = null;
    const start = () => { worker = new Worker(url); worker.onmessage = e => { clearTimeout(timer); const p = pending; pending = null; parent.postMessage(e.data, '*'); next() } };
    const queue = [];
    const next = () => {
      if (pending || !queue.length) return;
      pending = queue.shift();
      timer = setTimeout(() => {
        worker.terminate(); start();
        const p = pending; pending = null;
        parent.postMessage({ id: p.id, drawing: { kit: 1, w: p.opts.w, h: p.opts.h, regions: [], cites: {}, examples: {}, warnings: [],
          error: { name: 'TimeLimit', message: 'the program ran past its time limit and was stopped' },
          root: { t: 'frame', tone: 'bad', grow: 1, title: [{ s: 'program error', tone: 'bad', b: true }], kid: { t: 'text', runs: [{ s: 'TimeLimit: the program was stopped, so nothing was drawn', tone: 'dim' }] } } } }, '*');
        next();
      }, (p => (p.opts.limit || ${limit}) + 1500)(pending));
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
  const waiting = new Map()
  let ready
  const isReady = new Promise(r => { ready = r })
  addEventListener('message', e => {
    if (e.source !== iframe.contentWindow) return
    const m = e.data || {}
    if (m.ready) { ready(); return }
    const w = waiting.get(m.id)
    if (w) { waiting.delete(m.id); w(m.drawing) }
  })
  document.body.appendChild(iframe)
  return {
    /** Run `object.program` on `object.data`; resolves with the drawing. */
    async run(object, opts = {}) {
      await isReady
      const id = ++seq
      return new Promise(res => {
        waiting.set(id, res)
        iframe.contentWindow.postMessage({ id, program: String(object.program || ''), data: JSON.parse(JSON.stringify(object.data ?? {})), opts: { w: opts.w, h: opts.h, mode: opts.mode, limit: opts.limit || limit } }, '*')
      })
    },
  }
}
