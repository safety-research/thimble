// chips.tsx: the Client module that draws the squeeze chips under an answer (ui.ts names it by this file and hands it
// what to draw as props). It holds no logic of the chips: it draws them and sends the hooks module what the person
// did, and the hooks answer with the chips as they are now.
//
//   props: {items: [{id, n, name, levels, level, level0, ends, word, picked}], plus: what is typed after + (null when
//           nothing is), keys: whether the chips hold the keys (false while the tray holds them over the chips), held:
//           whether a click gave the chips the keyboard, revert: whether 0 has a version to take back, width, color,
//           ack}
//   in a frame in thimble's color, one row of chips, wrapped to the width, with the chips' keys, each where it acts and
//   drawn as the bar draws its keys (the bar names none of them, as the tray's keys are in its header): each chip its
//   digit (the key that picks it), its name, its two ends either side of its dots (`1 Length shorter ○●○○ longer`),
//   each dot a press that sets its level and each end a press that moves the chip one level toward it; the picked
//   chip's ends with the keys that do the same (`[ shorter ○●○○ ] longer`, ← and → once a click gave the chips the
//   keyboard), and its level in words where it stands away from the original or is picked (` · as written`), the
//   picked chip in thimble's color, as its frame and its keys are; once a click gave them the keyboard, `tab next chip`;
//   then `+ your own`, which adds a chip of the person's own (while its words are typed: `+ <words>▏ ↵ adds it · tab
//   lets it go`); `0 revert` while there is a version to take back; `esc back to the prompt` while they hold the
//   keyboard; then `s close` (not while words are typed after +, where s is a letter). While the tray holds the keys,
//   the same with no key.
//
// It sends {events: [{n, press}] | [{n, key}]}: a press on a chip's name or level words (`chip-<id>`, `word-<id>`), on
// one of its dots (`lvl-<id>-<i>`), on one of its ends (`step-<id>-down`, `step-<id>-up`), on + (`add`), on ↵ and tab
// after the typed words (`own-add`, `own-drop`), on 0 revert (`revert`), on tab next chip (`next`), on esc back to the
// prompt (`esc`), on s close (`close`); and each key while a click has given it the keyboard (Claude Code keeps tab,
// the arrows, enter and esc in its prompt otherwise; Escape gives the keyboard back). Each post carries every event the
// hooks have not answered yet, numbered; ui.ts handles each number once and answers the last as `ack`.
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
  const typing = plus != null
  // a key the person can press, in thimble's color as the hooks module read it (core/theme.ts accent())
  const keyColor = typeof props?.color === 'string' ? props.color : undefined
  // the chips name their keys while they hold them; the tray opened over them holds them
  const keyed = props?.keys !== false
  const held = !!props?.held
  const press = (id: string, label: string, kids: Any[]) => E.Button({ key: id, plain: true, label, onPress: () => send({ press: id }), children: kids })
  const key = (s: string) => E.Text({ key: 'k', color: keyColor, bold: true, children: s })
  const said = (s: string) => E.Text({ key: 'w', dimColor: true, children: s })
  // a key and its words, a press that does what the key does, in a box of its own so that it wraps whole; its words
  // alone while the tray holds the keys
  const action = (id: string, k: string, words: string, last = false) => E.Box({ key: `c-${id}`, flexDirection: 'row', ...(last ? {} : { marginRight: 3 }), children: [
    press(id, `${k} ${words}`, keyed ? [key(k), said(` ${words}`)] : [said(words)]),
  ] })
  // the keys that move the picked chip a level: [ and ], or ← and → while a click gave the chips the keyboard
  const [down, up] = held ? ['←', '→'] : ['[', ']']
  const chip = (c: Item) => {
    const tone = c.picked ? { color: keyColor } : { dimColor: true }
    const last = c.levels.length - 1
    const dots = c.levels.map((lv, i) => press(`lvl-${c.id}-${i}`, `${c.name}: ${lv}`, [E.Text({ ...tone, children: i === c.level ? '●' : '○' })]))
    // the ends, either side of the dots: a press moves the chip one level toward that end, as [ and ] do, whose keys
    // the picked chip's ends name
    const [lo = '', hi = ''] = Array.isArray(c.ends) ? c.ends : [c.levels[0], c.levels[last]]
    const keys = c.picked && keyed
    const end = (way: 'down' | 'up', words: string) => press(`step-${c.id}-${way}`, `${c.name}: one level toward ${words}`, way === 'down'
      ? [...(keys ? [key(`${down} `)] : []), said(`${words} `)]
      : keys ? [key(` ${up}`), said(` ${words}`)] : [said(` ${words}`)])
    const away = c.level0 === undefined || c.level !== c.level0
    return E.Box({ key: `c-${c.id}`, flexDirection: 'row', marginRight: 3, children: [
      press(`chip-${c.id}`, `${c.name}: ${c.word}`, [...(keyed ? [E.Text({ key: 'n', color: keyColor, bold: true, children: `${c.n} ` })] : []), E.Text({ key: 'name', ...tone, bold: c.picked, children: `${c.name} ` })]),
      end('down', lo),
      ...dots,
      end('up', hi),
      ...(c.picked || away ? [press(`word-${c.id}`, `${c.name}: ${c.word}`, [E.Text({ bold: c.picked, ...(c.picked ? { color: keyColor } : {}), children: ` · ${c.word}` })])] : []),
    ] })
  }
  // + your own; while its words are typed, them, then what ↵ and tab do there
  const add = E.Box({ key: 'c-add', flexDirection: 'row', marginRight: 3, children: typing
    ? [
      press('add', 'add a chip of your own', [E.Text({ color: keyColor, bold: true, children: `+ ${plus}▏` })]),
      press('own-add', 'add it', [key(' ↵'), said(' adds it')]),
      E.Text({ key: 'sep', dimColor: true, children: ' · ' }),
      press('own-drop', 'let it go', [key('tab'), said(' lets it go')]),
    ]
    : [press('add', 'add a chip of your own', [keyed ? key('+') : said('+'), said(' your own')])] })
  const width = Number(props?.width) || surface.columns || 80
  // in a frame in thimble's color, so the chips read as a control apart from the answer's text
  return E.Box({ key: 'frame', borderStyle: 'single', borderColor: keyColor, paddingX: 1, width, children: [
    E.Box({ key: 'chips', flexDirection: 'row', flexWrap: 'wrap', children: [
      ...items.map(chip),
      ...(held && !typing ? [action('next', 'tab', 'next chip')] : []),
      add,
      ...(props?.revert && !typing ? [action('revert', '0', 'revert')] : []),
      ...(held && !typing ? [action('esc', 'esc', 'back to the prompt')] : []),
      // s close last, so leaving is named where the person looks (not while words are typed after +, where s is a
      // letter)
      ...(typing ? [] : [action('close', 's', 'close', true)]),
    ] }),
  ] })
}

export default Chips
