// chips.tsx: the Client module that draws the squeeze chips under an answer (ui.ts names it by this file and hands it
// what to draw as props). It holds no logic of the chips: it draws them and sends the hooks module what the person
// did, and the hooks answer with the chips as they are now.
//
//   props: {items: [{id, n, name, levels, level, level0, ends, word, picked}], plus: what is typed after + (null when
//           nothing is), width, ack}
//   in a frame in thimble's color, one row of chips, wrapped to the width: each its digit (a key, drawn as the bar draws its keys), its name, its two ends either
//   side of its dots, each end and dot a press (`1 Length shorter ○●○○ longer`), and its level in words where it
//   stands away from the original or is picked (` · as written`), the picked chip in thimble's color, as its frame
//   and its keys are; then `+`, which adds a chip of the person's own; then
//   `s close`, its key drawn as the bar draws its keys, which closes the chips (not while words are typed after +,
//   where s is a letter)
//
// It sends {events: [{n, press}] | [{n, key}]}: a press on a chip's name or level words (`chip-<id>`, `word-<id>`), on
// one of its dots (`lvl-<id>-<i>`), on + (`add`), on s close (`close`); and each key while a click has given it the
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
    const tone = c.picked ? { color: keyColor } : { dimColor: true }
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
      ...(c.picked || away ? [press(`word-${c.id}`, `${c.name}: ${c.word}`, [E.Text({ bold: c.picked, ...(c.picked ? { color: keyColor } : {}), children: ` · ${c.word}` })])] : []),
    ] })
  }
  const add = press('add', 'add a chip of your own', [E.Text(plus != null ? { color: keyColor, bold: true, children: `+ ${plus}▏` } : { dimColor: true, children: '+' })])
  // s close, its key as the bar draws its keys (props.color: core/theme.ts accent()), so leaving is named where the person looks
  const close = plus == null ? [E.Box({ key: 'c-close', flexDirection: 'row', marginLeft: 3, children: [
    press('close', 's close', [E.Text({ color: keyColor, bold: true, children: 's' }), E.Text({ dimColor: true, children: ' close' })]),
  ] })] : []
  const width = Number(props?.width) || surface.columns || 80
  // in a frame in thimble's color, so the chips read as a control apart from the answer's text
  return E.Box({ key: 'frame', borderStyle: 'single', borderColor: keyColor, paddingX: 1, width, children: [
    E.Box({ key: 'chips', flexDirection: 'row', flexWrap: 'wrap', children: [...items.map(chip), add, ...close] }),
  ] })
}

export default Chips
