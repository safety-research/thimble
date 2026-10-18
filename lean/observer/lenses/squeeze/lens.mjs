// The squeeze lens: where the answer stands on squeeze's fixed chips (Report ↔ Interpret, Familiarity), so the person's
// first change starts from the right level. Its merge puts s's `at` in the answer's record, unlit.
import { verbsOf } from '../../../shell/message.js'

export default {
  name: 'squeeze',
  feature: 'lens-squeeze',
  skeleton: '"verbs": {}',
  read: reply => {
    const s = reply?.verbs?.s
    return s ? verbsOf({ s }).s ?? null : null
  },
  raw: d => d?.verbs?.s,
  digest: () => ({}),
  when: () => [],
  async merge(s, ctx) {
    if (s) ctx.verbs.s = s
  },
}
