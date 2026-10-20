// The notes lens: zero to two notes to Claude, which it reads with the person's next prompt and the person never sees.
// Its fragment is the registry's lens-notes; its digest is the notes Claude already has; its merge queues each note
// (the observer drops one Claude already has).
const bullets = xs => (xs.length ? xs.map(x => `- ${x}`).join('\n') : '(none)')

export default {
  name: 'notes',
  feature: 'lens-notes',
  skeleton: '"notes": []',
  /** Its part of the reply, as parseAnswer read it: [{note, rests_on?}]. */
  read: reply => (reply?.notes ?? []).slice(0, 2),
  /** Its raw part of the reply, for its share of the output. */
  raw: d => d?.notes,
  digest: st => ({ NOTES: bullets((st.notesGiven || []).slice(-30)) }),
  when: () => [],
  async merge(notes, ctx) {
    for (const n of notes) ctx.note({ from: 'observer', ...n })
  },
}
