// A big label's ask (shell/labels.ts): the feed's label_ask line is read twice (while Claude's command runs, and after
// it), and an ask the person answered never comes back. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

import { askFromFeed, labelAskNow, setLabelAsk } from '../shell/labels'

/** The engine's state, all askFromFeed and labelAskNow use. */
function engine(): Any {
  const kept = new Map<string, unknown>()
  const key = (k: { plugin: string; key: string }) => `${k.plugin}/${k.key}`
  const drawn = { n: 0 }
  return { drawn, ui: { invalidate: () => { drawn.n++ } }, state: { get: async (k: Any) => ({ value: kept.get(key(k)) }), set: async (k: Any, v: unknown) => { kept.set(key(k), v) } } }
}

test('an answered ask stays answered when its feed line is read again; an ask for the rest offers no sample', async () => {
  const $ = engine()
  const ev = { kind: 'label_ask', name: 'spam', root: '/d', ask: 'a1', units: 420, sample: 300, text: 'Read 420 records with Claude', meta: '9 model calls', t: 1 }
  await askFromFeed($, ev)
  expect((await labelAskNow($))?.ask).toBe('a1')
  // the person's key (any of 1 2 0) takes it off the bar at once and redraws; then newSaves reads the same line after
  // the command ends
  await setLabelAsk($, null)
  expect($.drawn.n).toBe(1)
  await askFromFeed($, ev)
  expect(await labelAskNow($)).toBe(null)
  // Claude runs the label again after the sample: a new ask, for the rest
  await askFromFeed($, { ...ev, ask: 'a2', units: 120, sample: 0, rest: true, text: 'Read the other 120 records with Claude' })
  expect(await labelAskNow($)).toMatchObject({ ask: 'a2', rest: true, units: 120, text: 'Read the other 120 records with Claude' })
})
