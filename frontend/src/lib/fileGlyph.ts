// The glyph of a file by its name, as the Files tree, the file tabs and the chips that point into a file draw it.
import type { IconName } from '../components/Icon'

// A file's kind by its name, the glyph each kind takes: the first pattern that matches wins.
const GLYPHS: [RegExp, IconName][] = [
  [/\.(jsonl?|ndjson|geojson|jsonc)$/i, 'braces'],
  [/\.(csv|tsv|xlsx?|parquet|feather|arrow)$/i, 'table'],
  [/\.(db|sqlite3?|duckdb)$/i, 'forge'],
  [/\.(md|markdown|mdx)$/i, 'markdown'],
  [/\.(sh|bash|zsh|fish)$/i, 'terminal'],
  [/\.ipynb$/i, 'notebook'],
  [/\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)$/i, 'image'],
  [/\.(zip|gz|tgz|tar|bz2|xz|7z|whl|zst)$/i, 'archive'],
  [/\.(ya?ml|toml|ini|cfg|conf|env|lock|properties)$|^(dockerfile|makefile|\.gitignore|\.env|\.editorconfig)$/i, 'sliders'],
  [/\.(py|pyi|js|mjs|cjs|jsx|ts|tsx|go|rs|java|kt|c|h|cc|cpp|hpp|rb|php|swift|scala|r|jl|lua|pl|sql|html?|css|scss|xml|vue|svelte)$/i, 'code'],
  [/\.(txt|text|rst|log|pdf|rtf|tex|docx?)$/i, 'doc'],
]

/** The glyph of a file, by its kind as its name says (VS Code's way): braces for JSON and
 * JSON lines, a grid for tables, a cylinder for databases, the markdown mark, a terminal for a shell script, a notebook,
 * a picture, an archive, sliders for configuration, angle brackets for source code, a page with lines for text, and a
 * bare page for anything else. */
export function glyphOf(name: string): IconName {
  const base = name.slice(name.lastIndexOf('/') + 1)
  for (const [re, glyph] of GLYPHS) if (re.test(base)) return glyph
  return 'page'
}
