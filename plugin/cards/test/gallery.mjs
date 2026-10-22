// gallery.mjs: card views of the shapes Claude draws, on made-up rows, for the layout and runner tests. Each entry is
// {name, title, rows, view}; test/golden/<name>.txt is what Claude Code's terminal drew for it at GOLDEN_WIDTH columns.

export const GOLDEN_WIDTH = 120

const agents = ['ada', 'bram', 'cleo', 'dov', 'eli', 'fay']
const runs = agents.flatMap((a, i) => [0, 1, 2].map(j => ({ agent: a, run: j + 1, tests: 10 + ((i * 7 + j * 3) % 13), failed: (i + j) % 4 === 0 ? (i % 3) + 1 : 0, minutes: 3 + ((i * 5 + j) % 9) })))

export const GALLERY = [
  {
    name: 'g01-table', title: 'Runs as a table', rows: runs,
    view: `function view(props, surface) {
  const { Box, Text } = surface.elements
  const head = Box({ gap: 2, children: [Text({ bold: true, children: 'agent'.padEnd(6) }), Text({ bold: true, children: 'run' }), Text({ bold: true, children: 'tests' }), Text({ bold: true, children: 'failed' })] })
  return Box({ flexDirection: 'column', children: [head, ...props.rows.slice(0, 8).map(r => Box({ gap: 2, children: [Text({ children: r.agent.padEnd(6) }), Text({ children: String(r.run).padStart(3) }), Text({ children: String(r.tests).padStart(5) }), Text({ color: r.failed ? '#cc3333' : undefined, children: String(r.failed).padStart(6) })] }))] })
}`,
  },
  {
    name: 'g02-bars', title: 'Minutes per agent', rows: runs,
    view: `function view(props, surface) {
  const { Box, Text } = surface.elements
  const by = {}
  for (const r of props.rows) by[r.agent] = (by[r.agent] || 0) + r.minutes
  return Box({ flexDirection: 'column', children: Object.entries(by).map(([a, m]) => Box({ children: [Box({ width: 8, children: [Text({ children: a })] }), Text({ color: '#5a6fd6', children: '█'.repeat(m) }), Text({ dimColor: true, children: ' ' + m + ' min' })] })) })
}`,
  },
  {
    name: 'g03-boxes', title: 'Three agents side by side', rows: runs,
    view: `function view(props, surface) {
  const { Box, Text } = surface.elements
  const pick = ['ada', 'bram', 'cleo']
  return Box({ gap: 1, children: pick.map(a => Box({ flexDirection: 'column', borderStyle: 'round', width: 30, paddingX: 1, children: [Text({ bold: true, children: a }), ...props.rows.filter(r => r.agent === a).map(r => Text({ children: 'run ' + r.run + ': ' + r.failed + ' failed of ' + r.tests }))] })) })
}`,
  },
  {
    name: 'g04-grow', title: 'Boxes that share the width', rows: runs,
    view: `function view(props, surface) {
  const { Box, Text } = surface.elements
  const notes = ['The first agent ran the suite three times and saw one failure each time it touched the parser.', 'The second agent only ran the unit tests.', 'The third agent ran everything twice, then stopped after a time-out in the network tests that it never ran again.']
  return Box({ gap: 2, children: notes.map((n, i) => Box({ flexDirection: 'column', flexGrow: 1, borderStyle: 'single', paddingX: 1, children: [Text({ bold: true, children: 'Agent ' + (i + 1) }), Text({ children: n })] })) })
}`,
  },
  {
    name: 'g05-timeline', title: 'A timeline of runs', rows: runs,
    view: `const keys = "jk"
function onKey(k, s, p) { const st = s.state || { sel: 0 }; s.setState({ sel: Math.max(0, Math.min(p.rows.length - 1, st.sel + (k === 'j' ? 1 : -1))) }) }
function view(props, surface) {
  const { Box, Text, Button } = surface.elements
  const st = surface.state || { sel: 0 }
  return Box({ flexDirection: 'column', children: props.rows.slice(0, 9).map((r, i) => Button({ key: 'r' + i, plain: true, onPress: () => surface.setState({ sel: i }), children: Text({ inverse: i === st.sel, wrap: 'truncate-end', children: '10:' + String(10 + i * 4).padStart(2, '0') + '  ' + r.agent.padEnd(5) + (r.failed ? ' ✗ ' : ' ✓ ') + 'run ' + r.run + ' of the full test suite with every optional plugin turned on and the slow network tests included as well' }) })) })
}`,
  },
  {
    name: 'g06-paragraph', title: 'A note in a frame', rows: runs,
    view: `function view(props, surface) {
  const { Box, Text } = surface.elements
  return Box({ flexDirection: 'column', width: '60%', borderStyle: 'round', paddingX: 1, children: [Text({ bold: true, children: 'What changed' }), Text({ children: 'Between the second and the third run the parser switched to a stricter mode, and from then on every run that read the old fixtures failed with the same error about a missing field, which the agents fixed one file at a time instead of all at once.' })] })
}`,
  },
  {
    name: 'g07-justify', title: 'Header and centered rows', rows: runs,
    view: `function view(props, surface) {
  const { Box, Text } = surface.elements
  return Box({ flexDirection: 'column', children: [
    Box({ justifyContent: 'space-between', children: [Text({ bold: true, children: 'Runs' }), Text({ dimColor: true, children: props.rows.length + ' in all' })] }),
    Box({ alignItems: 'center', gap: 1, children: [Box({ borderStyle: 'round', children: [Text({ children: 'big' })] }), Text({ children: 'centered next to a box' })] }),
    Box({ justifyContent: 'flex-end', children: [Text({ children: 'at the right' })] }),
    Box({ justifyContent: 'center', children: [Text({ children: 'in the middle' })] }),
    Box({ justifyContent: 'space-around', children: [Text({ children: 'a' }), Text({ children: 'b' }), Text({ children: 'c' })] }),
  ] })
}`,
  },
  {
    name: 'g08-heat', title: 'Failures as a heat strip', rows: runs,
    view: `function view(props, surface) {
  const { Box, Text } = surface.elements
  const shade = n => n === 0 ? '#e8f0e8' : n === 1 ? '#f2c4a0' : n === 2 ? '#e0805a' : '#b0302a'
  return Box({ flexDirection: 'column', children: ['ada', 'bram', 'cleo', 'dov'].map(a => Text({ children: [Text({ bold: true, children: a.padEnd(6) }), ...props.rows.filter(r => r.agent === a).map(r => Text({ color: shade(r.failed), children: '▇▇▇ ' })), Text({ dimColor: true, children: ' runs 1 to 3' })] })) })
}`,
  },
  {
    name: 'g09-chips', title: 'Chips that wrap', rows: runs,
    view: `function view(props, surface) {
  const { Box, Text } = surface.elements
  return Box({ flexWrap: 'wrap', gap: 1, children: props.rows.map((r, i) => Box({ borderStyle: 'single', paddingX: 1, children: [Text({ children: r.agent + ' #' + r.run + ' ' + r.minutes + 'm' })] })) })
}`,
  },
  {
    name: 'g10-master', title: 'A list and its detail', rows: runs,
    view: `const keys = "jk"
function onKey(k, s) { const st = s.state || { sel: 0 }; s.setState({ sel: st.sel + (k === 'j' ? 1 : -1) }) }
function view(props, surface) {
  const { Box, Text } = surface.elements
  const st = surface.state || { sel: 2 }
  const r = props.rows[Math.max(0, Math.min(props.rows.length - 1, st.sel))]
  return Box({ gap: 2, children: [
    Box({ flexDirection: 'column', width: 24, children: props.rows.slice(0, 6).map((x, i) => Text({ inverse: i === st.sel, children: (x.agent + ' run ' + x.run).padEnd(22) })) }),
    Box({ flexDirection: 'column', flexGrow: 1, borderStyle: 'round', paddingX: 1, children: [Text({ bold: true, children: r.agent + ', run ' + r.run }), Text({ children: r.tests + ' tests, ' + r.failed + ' failed, ' + r.minutes + ' minutes. The run read the fixtures from the shared folder and wrote its log next to them, so later runs could compare their output with this one.' })] }),
  ] })
}`,
  },
  {
    name: 'g11-spark', title: 'Sparklines', rows: runs,
    view: `function view(props, surface) {
  const { Box, Text } = surface.elements
  const bars = '▁▂▃▄▅▆▇█'
  const series = a => props.rows.filter(r => r.agent === a).map(r => r.minutes)
  return Box({ flexDirection: 'column', children: ['ada', 'bram', 'cleo', 'dov', 'eli', 'fay'].map(a => Box({ gap: 1, children: [Text({ children: a.padEnd(5) }), Text({ color: '#3a7bd5', children: series(a).map(m => bars[Math.min(7, m - 3)]).join('') }), Text({ dimColor: true, children: '⣿⣶⣤⣀ ' + series(a).join(' / ') })] })) })
}`,
  },
  {
    name: 'g12-buttons', title: 'Pages and buttons', rows: runs,
    view: `const keys = "np"
function onKey(k, s) { const st = s.state || { page: 0 }; s.setState({ page: Math.max(0, Math.min(2, st.page + (k === 'n' ? 1 : -1))) }) }
function view(props, surface) {
  const { Box, Text, Button } = surface.elements
  const st = surface.state || { page: 0 }
  const rows = props.rows.slice(st.page * 6, st.page * 6 + 6)
  return Box({ flexDirection: 'column', children: [
    Box({ gap: 2, children: [Button({ onPress: () => surface.setState({ page: Math.max(0, st.page - 1) }), children: 'previous' }), Button({ onPress: () => surface.setState({ page: Math.min(2, st.page + 1) }), children: 'next' }), Button({ plain: true, onPress: () => surface.setState({ page: 0 }), children: Text({ dimColor: true, children: 'first page' }) })] }),
    ...rows.map(r => Text({ children: r.agent + ' ' + r.run + ': ' + r.tests + ' tests' })),
    Text({ dimColor: true, children: 'page ' + (st.page + 1) + ' of 3' }),
  ] })
}`,
  },
  {
    name: 'g13-spacing', title: 'Margins and padding', rows: runs,
    view: `function view(props, surface) {
  const { Box, Text } = surface.elements
  return Box({ flexDirection: 'column', children: [
    Text({ children: 'top line' }),
    Box({ marginTop: 1, marginLeft: 4, borderStyle: 'double', paddingY: 1, paddingX: 2, children: [Text({ children: 'padded inside a double frame' })] }),
    Box({ marginLeft: 2, paddingLeft: 3, children: [Text({ children: 'indented 5' })] }),
    Box({ margin: 1, borderStyle: 'bold', children: [Text({ children: 'bold frame with margin 1' })] }),
    Text({ children: 'last line' }),
  ] })
}`,
  },
  {
    name: 'g14-percent', title: 'Columns in percent', rows: runs,
    view: `function view(props, surface) {
  const { Box, Text } = surface.elements
  const col = (w, t) => Box({ width: w, borderStyle: 'single', children: [Text({ children: t })] })
  return Box({ flexDirection: 'column', children: [
    Box({ children: [col('25%', 'a quarter'), col('50%', 'one half of the width'), col('25%', 'the last quarter')] }),
    Box({ children: [col('30%', 'thirty'), col('30%', 'thirty again'), Box({ flexGrow: 1, borderStyle: 'single', children: [Text({ children: 'the rest' })] })] }),
  ] })
}`,
  },
  {
    name: 'g15-align', title: 'Align and fixed height', rows: runs,
    view: `function view(props, surface) {
  const { Box, Text } = surface.elements
  return Box({ flexDirection: 'column', alignItems: 'center', children: [
    Text({ bold: true, children: 'Centered title' }),
    Box({ borderStyle: 'round', width: 40, height: 4, overflow: 'hidden', children: [Text({ children: 'This text is longer than the four rows of its box can hold, so the box cuts it at its bottom edge and the rest does not show at all, here or anywhere else.' })] }),
    Box({ flexDirection: 'column', alignItems: 'flex-end', width: 40, children: [Text({ children: 'right aligned' }), Text({ children: 'also right' })] }),
  ] })
}`,
  },
  {
    name: 'g16-wrapmodes', title: 'Cut text and wide characters', rows: runs,
    view: `function view(props, surface) {
  const { Box, Text } = surface.elements
  const long = 'agents/agent-07/session-2026-03-14T09-12-07/transcript-with-a-very-long-name.jsonl'
  return Box({ flexDirection: 'column', width: 40, children: [
    Text({ wrap: 'truncate-end', children: long }),
    Text({ wrap: 'truncate-middle', children: long }),
    Text({ wrap: 'truncate-start', children: long }),
    Text({ children: long }),
    Text({ children: '名前 テスト 結果: 通過 ✓ and 失敗 ✗ in one line of mixed width text that wraps' }),
  ] })
}`,
  },
]
