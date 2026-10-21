// Squeeze in the terminal (squeeze/term.ts): what 0 brings back. The original shows whole at once, its marks with it,
// and a card a squeeze changed is the original's again in the store too, so Claude and the browser read what the
// message shows. `claude plugin test plugin`. The kernel's `thimble save` is answered here, at process.run.
import { expect, test } from 'claude-code/testing'

import { promptStub } from './stubs'
import { applyRewrite } from '../squeeze/chips.mjs'
import { latestAsShown, setLevels } from '../squeeze/term'
import { newRecord, remark } from '../shell/message.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const ROOT = '/data'
const ROW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const ORIG_SOURCE = { title: 'Survival by fare', text: 'Fare bands, as made.', program: 'return k.text(data.t)' }
const SQUEEZED_SOURCE = { ...ORIG_SOURCE, text: 'Fare bands, squeezed.' }
const card = (v: number, source: Any, change: string) => ({ id: '02-fare', version: v, title: 'Survival by fare', source, history: [{ v: 1, at: 'a', change: 'made' }, ...(v > 1 ? [{ v, at: 'b', change }] : [])] })

/** The plugin's engine, as much of it as the squeeze uses here: state, a clock that runs nothing by itself, files, and
 *  `thimble save` (answered with v3, its spec kept). */
function engine(latestChange = 'squeeze: short'): Any {
  const kept = new Map<string, unknown>()
  const key = (k: Any) => `${k.plugin}/${k.key}/${k.id ?? ''}`
  const files: Record<string, string> = {
    [`${ROOT}/thimble/objects/02-fare.json`]: JSON.stringify(card(2, SQUEEZED_SOURCE, latestChange)),
    [`${ROOT}/thimble/objects/.versions/02-fare/v1.json`]: JSON.stringify(card(1, ORIG_SOURCE, '')),
  }
  const saves: { argv: string[]; spec: Any }[] = []
  const toasts: string[] = []
  return {
    files, saves, toasts,
    state: { get: async (k: Any) => ({ value: kept.get(key(k)) }), set: async (k: Any, v: unknown) => { kept.set(key(k), v) } },
    clock: { now: async () => 1000, after: () => undefined },
    fs: {
      exists: async (p: string) => p in files,
      read: async (p: string) => files[p] ?? promptStub(p) ?? '',
      write: async (p: string, c: string) => { files[p] = String(c) },
      list: async () => [],
    },
    env: { get: async (k: string) => ({ THIMBLE_HOME: '/home/t/.thimble', HOME: '/home/t' } as Any)[k] },
    plugin: { root: '/p' },
    session: { id: async () => 's-1', cwd: async () => ROOT, messages: async () => [] },
    ui: { toast: (t: string) => { toasts.push(String(t)) }, invalidate: () => undefined },
    process: {
      run: async (argv: string[]) => {
        if (!argv.includes('save')) return { exitCode: 0, stdout: '', stderr: '' }
        saves.push({ argv, spec: JSON.parse(files[argv[argv.indexOf('--from') + 1]!] ?? '{}') })
        return { exitCode: 0, stdout: `saved ${argv[argv.indexOf('save') + 1]} v3: thimble/objects/02-fare.json\n`, stderr: '' }
      },
    },
  }
}

/** A message squeezed once, its card changed by that squeeze (v1 under the original, v2 under the short version). */
function squeezed(): Any {
  const text = 'Most who paid the most fare survived: [72%](q1#band=top@share), and many more words after it here.'
  const rec = remark(newRecord({ row: ROW, session: 's-1', text }))
  const orig = { [ROW]: [{ id: '02-fare', v: 1, root: ROOT }] }
  const cards = { rows: { [ROW]: [{ id: '02-fare', v: 2, root: ROOT }] }, did: [{ id: '02-fare', did: 'edited', title: 'Survival by fare', v: 2 }] }
  return applyRewrite(rec, { text: 'Most top-fare passengers survived: [72%](q1#band=top@share).', at: { length: 0 }, cards, origCards: orig }, remark)
}

test('0 makes the original\'s card the latest version again, so the store reads what the message shows', async () => {
  const $ = engine()
  const back = { ...squeezed(), shown: null, squeeze: { ...squeezed().squeeze, at: {} } }
  expect(await latestAsShown($, back)).toEqual([])
  expect($.saves.length).toBe(1)
  expect($.saves[0]!.argv.slice(1)).toEqual(expect.arrayContaining(['save', '02-fare', '--change', 'squeeze: as written']))
  expect($.saves[0]!.spec).toEqual(ORIG_SOURCE)
  // the version the squeeze saved is shown: nothing to save
  $.saves.length = 0
  expect(await latestAsShown($, squeezed())).toEqual([])
  expect($.saves.length).toBe(0)
})

test('a card saved since by someone else stays the latest when 0 brings the original back', async () => {
  const $ = engine('changed')
  await latestAsShown($, { ...squeezed(), shown: null, squeeze: { ...squeezed().squeeze, at: {} } })
  expect($.saves.length).toBe(0)
})

test('0 shows the original whole at once: its text does not write itself in again, so its tail and marks never go', async () => {
  const $ = engine()
  await $.state.set({ plugin: 'thimble', key: 'msg', id: ROW }, squeezed())
  await setLevels($, ROW, {})
  expect((await $.state.get({ plugin: 'thimble', key: 'msg', id: ROW })).value.shown).toBe(null)
  const ui = (await $.state.get({ plugin: 'thimble', key: 'sqz', id: ROW })).value as Any
  expect(ui?.reveal ?? null).toBe(null)
})
