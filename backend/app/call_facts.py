"""The coverage facts of stored tool calls: the twin of the terminal UI's tracker (plugin/hooks/term/tracker.ts), for
the calls thimble stored (calls.py) rather than the calls the terminal UI saw. The orientation's coverage line
(orient_checks.coverage) reads these facts, and coverage.py's rules make its line, as they make the Coverage view's.

A fact is coverage.py's: {path, how, lines?, pages?, total?, folder?, by, at}, `how` one of whole, part and searched,
the path relative to the corpus root. A failed call gives none, and only data files inside the corpus count
(coverage.is_data, the twin of activate.ts isDataFile). Per call, as factsOf gives them:

  Read   a stored output numbers the lines it showed and gives no line total, so the file is whole when the output
         showed its first line through its last (as Claude Code numbers them), else in part with the lines shown and
         the file's line count as `total` (for a file up to COUNT_MAX_BYTES); a PDF whole, or in part by its `pages`; a
         binary file (BINARY) searched; an output with no numbered line (an unchanged file) gives none
  Bash   bash_reads, the twin of bashReads: cat and less whole, head, tail and sed -n in part (sed without -n
         whole), wc, grep, rg, awk and jq searched (jq with the bare filter `.` whole), a program's file arguments and
         the data files its code names searched; a recursive grep or rg over a folder one folder fact; the files a
         `grep -l` or `rg -l` printed searched. A part read here also gets the file's line count as `total`
  Grep   searched; a folder one folder fact

The Bash rules are tracker.ts's, word for word: both read one case list,
plugin/hooks/term/tests/bash-read-cases.ts (the JSON array between its markers).
"""
from __future__ import annotations

import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

from . import config, coverage

# tracker.ts's readers: how each reads the files it names
WHOLE = frozenset(("cat", "less"))
PART = frozenset(("head", "tail", "sed"))
SEARCH = frozenset(("wc", "grep", "egrep", "fgrep", "rg", "awk", "gawk", "jq"))
PROGRAMS = frozenset(("python", "python3", "duckdb", "sqlite3", "csvcut", "mlr"))
PREFIXES = frozenset(("sudo", "time", "command", "nice", "nohup", "env", "exec"))  # words that run the next one
GREPS = frozenset(("grep", "egrep", "fgrep"))
# a data file a program's code names (`pd.read_csv('events.csv')`)
QUOTED_DATA = re.compile(r"""['"]([^'"\s]+\.(?:csv|tsv|jsonl|ndjson|parquet|arrow|feather|xlsx|sqlite|db|duckdb|json|"""
                         r"""log|txt|md|pdf|xml|html?|vtt|srt|eml))['"]""")
BINARY = frozenset(("db", "sqlite", "duckdb", "parquet", "arrow", "feather", "xlsx"))
GLOB_CHARS = re.compile(r"[*?\[\]{}$`]")  # a path the shell would expand
OUTPUT_LONG = re.compile(r"^--(?:out|output)[\w-]*$")
GREP_TAKES = ("--glob", "--type", "--type-not", "--max-count", "--context", "--after-context", "--before-context",
              "--max-depth", "--include", "--exclude", "--exclude-dir", "--color", "--colour", "--sort", "--threads")
LISTED_MAX = 200_000  # lines of a `grep -l` output read
COUNT_MAX_BYTES = 512 << 20  # a file past this size gets no line count (`total`) from a part read
_NUMBERED = re.compile(r"^\s*(\d+)(?:\t|→)")  # a line of a Read output: its number, then the file's line
_HEREDOC = re.compile(r"""^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1""")
_SED_LINES = re.compile(r"^\s*(\d+)(?:\s*,\s*(\d+))?\s*(?:p|\{\s*p)")
_CARD = re.compile(r"^card:([A-Za-z0-9_-]+)", re.M)  # the card an add_card or edit_card result names on a line


# --------------------------------------------------------------------------- Bash, as tracker.ts reads it


def shell_words(command: str) -> list[list[str]]:
    """A shell command as words, cut into its simple commands at `|`, `;`, `&&`, `||`, `&` and newlines; quotes and
    backslashes kept apart from the words they quote. A heredoc's body is one word of the command before it."""
    out: list[list[str]] = []
    cur: list[str] = []
    word = ""
    has = False
    n = len(command)

    def end() -> None:
        nonlocal word, has
        if has:
            cur.append(word)
        word = ""
        has = False

    def cut() -> None:
        nonlocal cur
        end()
        if cur:
            out.append(cur)
        cur = []

    i = 0
    while i < n:
        ch = command[i]
        if ch == "'":
            j = command.find("'", i + 1)
            word += command[i + 1:n if j < 0 else j]
            has = True
            i = n if j < 0 else j
        elif ch == '"':
            j = i + 1
            while j < n and command[j] != '"':
                j += 2 if command[j] == "\\" else 1
            word += re.sub(r"\\(.)", r"\1", command[i + 1:j])
            has = True
            i = j
        elif ch == "\\" and i + 1 < n:
            word += "" if command[i + 1] == "\n" else command[i + 1]
            has = command[i + 1] != "\n" or has
            i += 1
        elif ch == "<" and command.startswith("<<", i):
            # a heredoc: its body, up to the line that ends it, is one word of this command
            end()
            m = _HEREDOC.match(command[i:])
            if not m:
                i += 2
                continue
            body_at = command.find("\n", i)
            if body_at < 0:
                i += len(m.group(0))
                continue
            stop = re.compile(rf"\n[\t ]*{m.group(2)}[\t ]*(?:\n|\Z)").search(command, body_at)
            body_end = stop.start() if stop else n
            # the rest of the heredoc's first line belongs to the command (`python3 - <<'EOF' > out.txt`)
            for words in shell_words(command[i + len(m.group(0)):body_at]):
                cur.extend(words)
            cur.append(command[body_at + 1:body_end])
            i = stop.end() if stop else n
            cut()
            continue
        elif ch in "|;&\n":
            if ch == "&" and command[i + 1:i + 2] == ">":
                word += ch
                has = True
                i += 1
                continue
            cut()
            if ch in "|&" and command[i + 1:i + 2] == ch:
                i += 1
        elif ch.isspace():
            end()
        else:
            word += ch
            has = True
        i += 1
    cut()
    return out


def _option(words: list[str], i: int, short: str, long: Iterable[str]) -> tuple[str, int] | None:
    """The value a short or long option takes, and the index of its last word: the next word, or what follows `=` or
    the letter."""
    w = words[i]
    for name in long:
        if w == name:
            return (words[i + 1] if i + 1 < len(words) else ""), i + 1
        if w.startswith(f"{name}="):
            return w[len(name) + 1:], i
    if short and w == short:
        return (words[i + 1] if i + 1 < len(words) else ""), i + 1
    if short and w.startswith(short) and len(w) > len(short) and not w.startswith("--"):
        return w[len(short):], i
    return None


def _sed_lines(script: str) -> list[int] | None:
    """The lines a sed script prints (`A,Bp`, `Ap`, `A,B{p;…}`), or None."""
    m = _SED_LINES.match(script)
    if not m:
        return None
    a, b = int(m.group(1)), int(m.group(2) or m.group(1))
    return [a, b] if a > 0 and b >= a else None


def _count_arg(text: str) -> int | None:
    """head's line count as JavaScript's Number reads it, when it is a whole number."""
    t = text.strip()
    if not t:
        return 0
    try:
        v = float(int(t, 16)) if t.lower().startswith("0x") else float(t)
    except ValueError:
        return None
    return int(v) if v.is_integer() else None


def bash_reads(command: str) -> list[dict[str, Any]]:
    """The files a Bash command's readers name, each {reader, path, how, lines?, recursive?} (tracker.ts bashReads):
    never an output argument (after `>`, `>>`, `-o`, `--out*`, `--output*`, or a `tee`, which is no reader), never a
    glob the shell would expand."""
    out: list[dict[str, Any]] = []
    for whole in shell_words(command):
        words = list(whole)
        while words and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]) or words[0] in PREFIXES):
            words.pop(0)
        name = (words[0] if words else "").split("/")[-1]
        if name not in WHOLE and name not in PART and name not in SEARCH and name not in PROGRAMS:
            continue
        grep_like = name in GREPS or name == "rg"
        args: list[str] = []
        opts: list[str] = []
        n_arg: str | None = None
        lines: list[int] | None = None
        script_given = False
        quiet = False
        filt: str | None = None
        i = 1
        while i < len(words):
            w = words[i]
            # redirections: what follows a `>` is written; what follows a `<` is read
            if re.match(r"^\d*>{1,2}$|^&>$", w):
                i += 2
                continue
            if re.match(r"^\d*>{1,2}\S|^&>\S", w):
                i += 1
                continue
            if w == "<":
                if i + 1 < len(words) and words[i + 1]:
                    args.append(words[i + 1])
                i += 2
                continue
            if OUTPUT_LONG.match(w):
                i += 2
                continue
            if re.match(r"^--(?:out|output)[\w-]*=", w):
                i += 1
                continue
            if w == "-o" and not grep_like:
                i += 2
                continue
            if name in ("head", "tail"):
                got = _option(words, i, "-n", ("--lines",))
                if got:
                    n_arg, i = got[0], got[1] + 1
                    continue
                if re.match(r"^-\d+$", w):
                    n_arg = w[1:]
                    i += 1
                    continue
                got = _option(words, i, "-c", ("--bytes",))
                if got:
                    i = got[1] + 1
                    continue
            if name == "sed":
                if w in ("-n", "--quiet", "--silent"):
                    quiet = True
                    i += 1
                    continue
                if w.startswith("-i") or w == "--in-place":
                    args.clear()  # an edit, not a reading
                    opts.append("-i")
                    break
                got = _option(words, i, "-e", ("--expression",))
                if got:
                    script_given = True
                    lines = _sed_lines(got[0]) or lines
                    i = got[1] + 1
                    continue
            if name in ("awk", "gawk", "jq"):
                got = _option(words, i, "-f", ("--from-file",))
                if got:
                    script_given = True
                    i = got[1] + 1
                    continue
            if name == "jq":
                # options that take a name and a value: neither is the filter or a file
                if re.match(r"^--(?:arg|argjson|slurpfile|rawfile)$", w):
                    i += 3
                    continue
                if w == "--indent":
                    i += 2
                    continue
            if grep_like:
                got = _option(words, i, "-e", ("--regexp",)) or _option(words, i, "-f", ("--file",))
                if got:
                    script_given = True
                    i = got[1] + 1
                    continue
                # options that take a value: their value is no path
                got = _option(words, i, "", GREP_TAKES)
                if got:
                    i = got[1] + 1
                    continue
                if re.match(r"^-[gtTmABCM]$", w):
                    i += 2
                    continue
            if w.startswith("-") and w != "-":
                opts.append(w)
                i += 1
                continue
            args.append(w)
            i += 1
        if name == "sed" and "-i" in opts:
            continue
        files = args
        if name in ("sed", "awk", "gawk", "jq") or grep_like:
            # the first plain word is the script, the filter or the pattern, unless an option gave it
            if not script_given and files:
                if name == "sed":
                    lines = _sed_lines(files[0]) or lines
                filt = files[0]
                files = files[1:]
        is_grep = name in GREPS
        recursive = ("--files" not in opts) if name == "rg" else is_grep and any(
            re.match(r"^-[A-Za-z]*[rR]", o) or o in ("--recursive", "--dereference-recursive") for o in opts)
        if name == "rg" and "--files" in opts:
            continue
        if (name == "rg" or (is_grep and recursive)) and not files:
            files = ["."]
        if name in WHOLE or (name == "jq" and filt is not None and filt.strip() == "."):
            how = "whole"
        elif name in PART:
            how = "whole" if name == "sed" and not quiet else "part"
        else:
            how = "searched"
        if name == "head":
            k = _count_arg(re.sub(r"^\+", "", n_arg if n_arg is not None else "10"))
            if k is not None and k > 0:
                lines = [1, k]
        if name == "tail" and n_arg is not None and n_arg.startswith("+"):
            lines = None
        for f in files:
            if not f or f == "-" or GLOB_CHARS.search(f):
                continue
            r: dict[str, Any] = {"reader": name, "path": f, "how": how}
            if how == "part" and lines:
                r["lines"] = list(lines)
            if recursive:
                r["recursive"] = True
            out.append(r)
        # a program's code that names a data file (`python3 -c "…read_csv('x.csv')"`, a heredoc, a SQL string)
        if name in PROGRAMS:
            for w in words[1:]:
                for m in QUOTED_DATA.finditer(w):
                    if not GLOB_CHARS.search(m.group(1)):
                        out.append({"reader": name, "path": m.group(1), "how": "searched"})
    return out


def _lists_files(command: str) -> bool:
    """Whether a grep or rg of the command prints the names of the files it matched (`-l`)."""
    for words in shell_words(command):
        if (words[0].split("/")[-1] if words else "") in ("grep", "egrep", "fgrep", "rg") and any(
                re.match(r"^-[A-Za-z]*l[A-Za-z]*$", x) or x == "--files-with-matches" for x in words):
            return True
    return False


# --------------------------------------------------------------------------- the facts of a call


class _Corpus:
    """The corpus root as the rules read it: its path and realpath, and whether it is a code tree."""

    def __init__(self, root: Path) -> None:
        self.root = os.path.normpath(str(root))
        self.real = os.path.realpath(root)
        self.tree = coverage.code_tree(root)

    def placed(self, p: str) -> tuple[str, str] | None:
        """(path relative to the root, 'file' or 'dir') of a path a call gave, by its realpath; None outside the root
        or for what is neither (activate.ts absolute, relInside)."""
        full = p if p.startswith("/") else self.root + "/" + re.sub(r"^\./+", "", p)
        real = os.path.realpath(full)
        if real == self.real:
            rel = "."
        else:
            rel = _rel_inside(self.real, real)
            if rel is None:
                return None
        if os.path.isdir(real):
            return rel, "dir"
        if os.path.isfile(real):
            return rel, "file"
        return None

    def data(self, rel: str) -> bool:
        return coverage.is_data(rel, self.tree)


def _rel_inside(root: str, path: str) -> str | None:
    """activate.ts relInside: a path inside `root` as a relative path, or None."""
    if not path:
        return None
    r = root.rstrip("/")
    if not path.startswith("/"):
        rel = re.sub(r"^\./+", "", path)
        return rel if rel and ".." not in rel.split("/") else None
    if not path.startswith(f"{r}/"):
        return None
    rel = path[len(r) + 1:]
    return rel if rel and ".." not in rel.split("/") else None


def _lines_past(path: Path, n: int) -> bool:
    """Whether the file holds a line past its first `n` (a last line without a newline counts)."""
    if n <= 0:
        return path.stat().st_size > 0
    seen = 0
    with open(path, "rb") as f:
        for buf in iter(lambda: f.read(1 << 20), b""):
            at = 0
            while (j := buf.find(b"\n", at)) >= 0:
                seen += 1
                if seen == n:
                    return j + 1 < len(buf) or bool(f.read(1))
                at = j + 1
    return False


def _line_total(path: Path) -> int | None:
    """The file's lines as an editor numbers them, for a file up to COUNT_MAX_BYTES; None past it or unreadable."""
    from . import corpus  # noqa: PLC0415

    try:
        if path.stat().st_size > COUNT_MAX_BYTES:
            return None
        return corpus.line_count(path)
    except OSError:
        return None


def _read_facts(cp: _Corpus, inp: dict[str, Any], result: str) -> list[dict[str, Any]]:
    """A Read's fact, from its stored output (module note)."""
    where = cp.placed(str(inp.get("file_path") or ""))
    if where is None or where[1] != "file" or not cp.data(where[0]):
        return []
    rel = where[0]
    ext = coverage.ext_of(rel)
    if ext == "pdf":
        got = re.match(r"^\s*(\d+)(?:\s*-\s*(\d+))?\s*$", str(inp.get("pages") or ""))
        if got:
            a, b = int(got.group(1)), int(got.group(2) or got.group(1))
            if a > 0 and b >= a:
                return [{"path": rel, "how": "part", "pages": [a, b]}]
        return [{"path": rel, "how": "whole"}]
    if ext in BINARY:
        return [{"path": rel, "how": "searched"}]
    shown = [int(m.group(1)) for line in result.split("\n") if (m := _NUMBERED.match(line))]
    if not shown:
        return []
    full = Path(cp.real) / rel
    start, last = min(shown), max(shown)
    total = _line_total(full)
    try:
        whole = start <= 1 and (last >= total if total is not None else not _lines_past(full, last))
    except OSError:
        return []
    if whole:
        return [{"path": rel, "how": "whole"}]
    return [{"path": rel, "how": "part", "lines": [start, last], **({"total": total} if total is not None else {})}]


def _bash_facts(cp: _Corpus, command: str, result: str) -> list[dict[str, Any]]:
    """A Bash call's facts (module note)."""
    out: list[dict[str, Any]] = []
    named: set[str] = set()
    for r in bash_reads(command):
        where = cp.placed(r["path"])
        if where is None:
            continue
        rel, kind = where
        if kind == "dir":
            if r.get("recursive"):
                out.append({"path": rel, "how": "searched", "folder": True})
            continue
        if not cp.data(rel):
            continue
        named.add(rel)
        fact: dict[str, Any] = {"path": rel, "how": r["how"]}
        if r.get("lines"):
            fact["lines"] = r["lines"]
        if r["how"] == "part" and (total := _line_total(Path(cp.real) / rel)) is not None:
            fact["total"] = total
        out.append(fact)
    if _lists_files(command):
        for line in result.split("\n")[:LISTED_MAX]:
            p = line.strip()
            if not p or p in named:
                continue
            rel = _rel_inside(cp.real, p) if p.startswith("/") else re.sub(r"^\./+", "", p)
            if not rel or not cp.data(rel):
                continue
            named.add(rel)
            out.append({"path": rel, "how": "searched"})
    return out


def _grep_facts(cp: _Corpus, inp: dict[str, Any]) -> list[dict[str, Any]]:
    """A Grep call's fact: searched, a folder one folder fact."""
    where = cp.placed(str(inp.get("path") or "") or ".")
    if where is None:
        return []
    rel, kind = where
    if kind == "dir":
        return [{"path": rel, "how": "searched", "folder": True}]
    return [{"path": rel, "how": "searched"}] if cp.data(rel) else []


def _epoch(ts: Any) -> float | None:
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return None


def facts_of(root: Path, row: dict[str, Any], cp: _Corpus | None = None) -> list[dict[str, Any]]:
    """The facts of one stored call {name, input, result?, is_error?, ts?} over the corpus at `root` (module note),
    each `by` the agent, as the tracker gives a subagent's (the orientation is one), at the call's time. The paths are
    relative to the root, and a folder fact's root itself is `.`."""
    if row.get("is_error"):
        return []
    cp = cp or _Corpus(root)
    name = str(row.get("name") or "")
    inp = row.get("input") if isinstance(row.get("input"), dict) else {}
    result = row.get("result") if isinstance(row.get("result"), str) else ""
    if name == "Read":
        got = _read_facts(cp, inp, result)
    elif name == "Bash" and isinstance(inp.get("command"), str):
        got = _bash_facts(cp, inp["command"], result)
    elif name == "Grep":
        got = _grep_facts(cp, inp)
    else:
        return []
    at = _epoch(row.get("ts"))
    for f in got:
        f["by"] = "agent"
        if at is not None:
            f["at"] = at
    return got


# --------------------------------------------------------------------------- the searches of thimble's tools


def _short(name: str) -> str:
    return name.rsplit("__", 1)[-1]


def derived_of(c: str, rows: list[dict[str, Any]]) -> coverage.Derived:
    """What the calls' cards and labels searched (coverage.py `_derived`, for these calls alone): the reads of the cards
    an add_card or edit_card call made or changed (the card its result names), and the files of the labels an
    apply_label call ran over files (its `paths`, else the label's own)."""
    from . import concepts, notebook  # noqa: PLC0415

    ws = config.workspace_dir(c)
    root = config.corpus_dir(c)
    cards: set[str] = set()
    pats: list[Any] = []
    for row in rows:
        if row.get("is_error"):
            continue
        name = _short(str(row.get("name") or ""))
        inp = row.get("input") if isinstance(row.get("input"), dict) else {}
        if name in ("add_card", "edit_card"):
            cards.update(_CARD.findall(str(row.get("result") or "")[:30_000]))
            if name == "edit_card" and isinstance(inp.get("card"), str):
                cards.add(inp["card"].removeprefix("card:"))
        elif name == "apply_label" and str(inp.get("scope") or "files") == "files":
            paths = inp.get("paths")
            if not paths and isinstance(inp.get("name"), str):
                concept = concepts.find_concept(ws, inp["name"])
                paths = (concept or {}).get("glob")
            if paths:
                pats.append(paths)
    cells = [cell for _, nb in notebook._stored(ws) for cell in nb.get("cells") or []
             if isinstance(cell, dict) and str(cell.get("id")) in cards] if cards else []
    files, areas = coverage.card_searches(cells)
    out: coverage.Derived = (files, areas, [])
    for p in pats:
        coverage.label_searches(root, p, out)
    return out


def of_calls(c: str, rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], coverage.Derived]:
    """The facts of the stored calls `rows` in workspace `c` and what their cards and labels searched."""
    root = config.corpus_dir(c)
    cp = _Corpus(root)
    facts = [f for row in rows for f in facts_of(root, row, cp)]
    return facts, derived_of(c, rows)
