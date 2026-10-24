// chips.tsx: the Client module that draws the squeeze chips under an answer (ui.ts names it by this file and hands it
// what to draw as props). It holds no logic of the chips: it draws them and sends the hooks module what the person
// did, and the hooks answer with the chips as they are now.
//
//   props: {items: [{id, n, name, levels, level, level0, ends, word, picked}], plus: what is typed after + (null when
//           nothing is), example: what + may ask, catchup: {n, replies} (null when the row offers no catch-up),
//           older: which reply the chips stand under when it is not the newest (null), doing: {words, secs, glyph} while
//           a rewrite is on its way (null), width, ack}
//   first, dim, which reply they squeeze when it is an older one (`squeezing the reply from 11:33`); then one row of
//   chips, wrapped to the width: each its digit (a key, drawn as the bar draws its keys), its name, its two ends either
//   side of its dots, each end and dot a press (`1 Length shorter ○●○○ longer`), and its level in words where it
//   stands away from the original or is picked (` · as written`), the picked chip in the warning color; then the
//   catch-up, when replies piled up (`4 Catch up on 2 replies`); then `+`, which adds a chip of the person's own (its
//   example dim until a letter is typed); then `s close`, its key drawn as the bar draws its keys, which closes the
//   chips (not while words are typed after +, where s is a letter); last, while a rewrite is on its way, what it
//   writes and its seconds (`⠋ rewriting: Background new… 12s`) in the warning color
//
// It sends {events: [{n, press}] | [{n, key}]}: a press on a chip's name or level words (`chip-<id>`, `word-<id>`), on
// one of its dots (`lvl-<id>-<i>`), on the catch-up (`catchup`), on + (`add`), on s close (`close`); and each key while a click has given it the
// keyboard (Claude Code keeps tab, the arrows, enter and esc in its prompt otherwise; Escape gives the keyboard back). Each post carries every
// event the hooks have not answered yet, numbered; ui.ts handles each number once and answers the last as `ack`.
import type { ClientModule, ClientSurface } from 'claude-code'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Item = { id: string; n: number; name: string; levels: string[]; level: number; level0?: number; ends?: string[]; word: string; picked: boolean }
type Instance = { id: string; n: number; queue: Array<Record<string, unknown>> }
const instances = new WeakMap<object, Instance>()

const Chips: ClientModule<Any> = (props: Any, surface: ClientSurface) => {
  const E = surface.elements as Any
  let I = instances.get(surface)
  if (!I) {
    I = { id: Math.random().toString(36).slice(2, 10), n: 0, queue: [] }
    instances.set(surface, I)
  }
  const me = I
  const ack = Number(props?.ack?.[me.id]) || 0
  if (ack) me.queue = me.queue.filter(x => Number(x.n) > ack)
  const send = (ev: Record<string, unknown>) => {
    me.queue = [...me.queue, { n: ++me.n, ...ev }].slice(-20)
    surface.post({ client: me.id, events: me.queue })
  }
  surface.onKey(ev => {
    if (ev.ctrl || ev.meta) return
    send({ key: ev.key, ...(ev.shift ? { shift: true } : {}) })
  })

  const items: Item[] = Array.isArray(props?.items) ? props.items : []
  const plus = typeof props?.plus === 'string' ? props.plus : null
  // a key the person can press, in thimble's color as the hooks module read it (core/theme.ts accent())
  const keyColor = typeof props?.color === 'string' ? props.color : undefined
  const press = (id: string, label: string, kids: Any[]) => E.Button({ key: id, plain: true, label, onPress: () => send({ press: id }), children: kids })
  const chip = (c: Item) => {
    const tone = c.picked ? { color: 'warning' } : { dimColor: true }
    const last = c.levels.length - 1
    const dots = c.levels.map((lv, i) => press(`lvl-${c.id}-${i}`, `${c.name}: ${lv}`, [E.Text({ ...tone, children: i === c.level ? '●' : '○' })]))
    // the ends, either side of the dots: a press sets the chip at that end
    const [lo = '', hi = ''] = Array.isArray(c.ends) ? c.ends : [c.levels[0], c.levels[last]]
    const end = (i: number, words: string, pad: string) => press(`lvl-${c.id}-${i}`, `${c.name}: ${c.levels[i]}`, [E.Text({ dimColor: true, children: pad === 'l' ? `${words} ` : ` ${words}` })])
    const away = c.level0 === undefined || c.level !== c.level0
    return E.Box({ key: `c-${c.id}`, flexDirection: 'row', marginRight: 3, children: [
      press(`chip-${c.id}`, `${c.name}: ${c.word}`, [E.Text({ color: keyColor, bold: true, children: `${c.n} ` }), E.Text({ ...tone, bold: c.picked, children: `${c.name} ` })]),
      end(0, lo, 'l'),
      ...dots,
      end(last, hi, 'r'),
      ...(c.picked || away ? [press(`word-${c.id}`, `${c.name}: ${c.word}`, [E.Text({ bold: c.picked, ...(c.picked ? { color: 'warning' } : {}), children: ` · ${c.word}` })])] : []),
    ] })
  }
  const cu = props?.catchup && typeof props.catchup === 'object' ? props.catchup : null
  const catchup = cu ? [E.Box({ key: 'c-catchup', flexDirection: 'row', marginRight: 3, children: [
    press('catchup', `catch up on ${cu.replies} replies`, [E.Text({ color: keyColor, bold: true, children: `${cu.n} ` }), E.Text({ children: `Catch up on ${cu.replies} replies` })]),
  ] })] : []
  const example = typeof props?.example === 'string' ? props.example : ''
  const add = press('add', 'add a chip of your own', plus == null
    ? [E.Text({ dimColor: true, children: '+' })]
    : [E.Text({ color: 'warning', bold: true, children: `+ ${plus}▏` }), ...(plus || !example ? [] : [E.Text({ dimColor: true, children: example })])])
  // s close, its key as the bar draws its keys (props.color: core/theme.ts accent()), so leaving is named where the person looks
  const close = plus == null ? [E.Box({ key: 'c-close', flexDirection: 'row', marginLeft: 3, children: [
    press('close', 's close', [E.Text({ color: keyColor, bold: true, children: 's' }), E.Text({ dimColor: true, children: ' close' })]),
  ] })] : []
  const width = Number(props?.width) || surface.columns || 80
  const older = typeof props?.older === 'string' && props.older ? props.older : null
  const doing = props?.doing && typeof props.doing === 'object' ? props.doing : null
  const row = E.Box({ key: 'chips', flexDirection: 'row', flexWrap: 'wrap', width, children: [...items.map(chip), ...catchup, add, ...close] })
  if (!older && !doing) return row
  return E.Box({ flexDirection: 'column', width, children: [
    ...(older ? [E.Text({ key: 'older', dimColor: true, wrap: 'truncate-end', children: older })] : []),
    row,
    ...(doing ? [E.Text({ key: 'doing', color: 'warning', wrap: 'truncate-end', children: `${doing.glyph || '⠋'} ${doing.words}…${Number(doing.secs) >= 1 ? ` ${Math.floor(Number(doing.secs))}s` : ''}` })] : []),
  ] })
}

export default Chips
