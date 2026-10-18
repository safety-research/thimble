// The actions lens: the actions it lights under the answer, today v (visualize) with one or two named proposals. Its
// merge puts them in the answer's record (shell/message.js verbsOf checks them); c is lit by thimble from the claims.
import { verbsOf } from '../../../shell/message.js'

export default {
  name: 'actions',
  feature: 'lens-actions',
  skeleton: '"verbs": {}',
  read: reply => {
    const v = reply?.verbs?.v
    return v ? verbsOf({ v }).v ?? null : null
  },
  raw: d => d?.verbs?.v,
  digest: () => ({}),
  when: () => [],
  async merge(v, ctx) {
    if (v) ctx.verbs.v = v
  },
}
