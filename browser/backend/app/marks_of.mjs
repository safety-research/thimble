// marks_of.mjs: the marks of a turn's texts, found as the terminal plugin finds them (plugin/marks/message.js), for the
// server's check of a reply (marks.py). The page reads the same marks with the same module.
//
//   stdin   {"texts": ["…", …]}      the turn's texts in order, each the words between two calls
//   stdout  [{"piece", "k", "words", "sentence"}, …]   each mark: the text it is in, its place among that text's
//           marks (from 0), its words as written, and the sentence that holds it (sentenceOf)
import { marksIn, sentenceOf } from '../../../plugin/marks/message.js'

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => { input += d })
process.stdin.on('end', () => {
  const texts = JSON.parse(input || '{}').texts ?? []
  const out = []
  texts.forEach((text, piece) => marksIn(text).forEach((m, k) => out.push({ piece, k, words: m.words, sentence: sentenceOf(text, m) })))
  process.stdout.write(JSON.stringify(out))
})
