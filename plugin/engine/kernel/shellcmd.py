"""What a shell command did with each file of the folder it names, for coverage (coverage.py).

    read      some of its lines reached Claude: `cat`, `head`, `tail` or `sed` printed them, and what came after in the
              pipeline passed them on
    searched  a search (`grep`, `rg`, `sed -n '/re/p'`) went over it and showed only the lines that matched
    computed  a program went over its content and only its results came back: code (`python`, `jq`, `awk`, …) that
              names the file in its arguments, in a here-document or in the script it runs; a count (`wc`,
              `grep -c`, `grep -l`); a program that decodes a video, a sound, an image or a PDF (`ffmpeg`,
              `pdftotext`, …), whose frames, text or facts Claude reads in place of the file; a stage that takes the
              lines and is not known to pass them on; or a command whose output went to a file. Code is taken to go
              over all of a file it names, as code that opens a file mostly does
    listed    only its name came up: a listing (`ls`, `find`), or a program thimble does not know

A folder a command names stands for its files only for a search, which goes into it; any other program only lists it.
What the rule cannot tell, it does not count as read.

    shows(command, known, root, cwd, lines_of, scripts) -> [(path, how, (first, last) or None, program)]

`path` is a file, or a folder with a trailing `/` (`runs/`, `./` for the root) that stands for its files: a folder of
a million screenshots is one entry, never a million. `known` is the root's files as a Known index (or a list, indexed
on the call), looked up by name and by folder, never scanned once per word of a command. `scripts` keeps the scripts
the session's commands wrote with a here-document (`cat > scan.py <<'PY'`), so a later `python3 scan.py` goes over
the files the script names.

`shows_sets` gives the same entries, but the files one program searched, listed or went over whole are one entry
whose `path` is a Files: code that globs 15,000 files is one entry, which coverage adds in one step.
"""
from __future__ import annotations

import bisect
import functools
import itertools
import os
import re
from pathlib import Path
from typing import Callable, Iterable, TypeVar

SEARCHES = {"grep", "egrep", "fgrep", "zgrep", "rg", "ag", "ack"}
# programs that compute over the files their code or their arguments name
COMPUTES = re.compile(r"^(?:python[\d.]*|pypy3?|jq|g?awk|mawk|node|perl|ruby|Rscript|sqlite3|duckdb|mlr|datamash)$")
# of those, the ones that run a script file: its first word that is no option (`python3 -I scan.py data.jsonl`)
SCRIPTED = re.compile(r"^(?:python[\d.]*|pypy3?|node|perl|ruby|Rscript)$")
# programs that count what they read and print only the counts
COUNTS = {"wc", "md5sum", "sha1sum", "sha256sum", "sha512sum", "cksum", "cmp"}
# programs that decode a media or document file: Claude sees what they extract (frames, text, a duration), not the file
DECODES = {"ffmpeg", "ffprobe", "mediainfo", "exiftool", "sox", "soxi", "pdftotext", "pdftoppm", "pdfinfo", "pdfimages",
           "tesseract", "identify", "convert", "magick", "whisper"}
SCRIPT_MAX_BYTES = 1 << 20
# programs that pass on the lines they get (head, tail and sed narrow them; uniq -c counts them)
PASSES = {"cat", "less", "more", "cut", "column", "nl", "tr", "fold", "fmt", "expand", "sort", "tee", "uniq", "head", "tail", "sed"}
WRAPPERS = {"!", "{", "}", "if", "then", "else", "elif", "do", "while", "until", "time", "sudo", "command", "nohup", "exec",
            "env", "builtin", "nice"}

Range = Callable[[int, int], "tuple[int, int]"]


# ------------------------------------------------------------------ the command as pipelines


def pipelines(cmd: str) -> list[list[dict]]:
    """The command as its pipelines, each a list of stages {words, out, to, bodies}: `out` when the stage's output goes
    to a file rather than to Claude, `to` the files it goes to, `bodies` the text of its heredocs."""
    cmd = cmd.replace("\\\n", " ")
    pipes: list[list[dict]] = [[]]
    stage: dict = {"words": [], "out": False, "to": [], "bodies": []}
    word: list[str] = []
    has = False
    redirect: str | None = None  # what the next word is: "out", "skip" or "heredoc"
    pending: list[tuple[str, dict]] = []
    i, n = 0, len(cmd)

    def end_word() -> None:
        nonlocal word, has, redirect
        if has:
            w = "".join(word)
            if redirect == "heredoc":
                pending.append((w, stage))
            elif redirect == "out":
                if w not in ("/dev/stdout", "/dev/stderr", "/dev/tty"):
                    stage["out"] = True
                    stage["to"].append(w)
            elif redirect != "skip":
                stage["words"].append(w)
            redirect = None
        word, has = [], False

    def end_stage(new_pipe: bool) -> None:
        nonlocal stage
        end_word()
        if stage["words"] or stage["out"] or any(s is stage for _, s in pending):
            pipes[-1].append(stage)
        stage = {"words": [], "out": False, "to": [], "bodies": []}
        if new_pipe and pipes[-1]:
            pipes.append([])

    while i < n:
        c = cmd[i]
        if c == "'":
            j = cmd.find("'", i + 1)
            j = n if j < 0 else j
            word.append(cmd[i + 1:j])
            has, i = True, j + 1
            continue
        if c == '"':
            j = i + 1
            while j < n and cmd[j] != '"':
                if cmd[j] == "\\" and j + 1 < n:
                    j += 1
                elif cmd.startswith("$(", j):
                    # a command substitution in the quotes (`echo "$d: $(sqlite3 $d/forge.db 'select …')"`) is a command
                    # of its own, whose output the word holds: its pipelines go before this one
                    k = _subst_end(cmd, j + 2)
                    pipes[-1:-1] = pipelines(cmd[j + 2:k - 1])
                    j = k
                    continue
                word.append(cmd[j])
                j += 1
            has, i = True, j + 1
            continue
        if c == "\\" and i + 1 < n:
            word.append(cmd[i + 1])
            has, i = True, i + 2
            continue
        if c == "#" and not has:
            j = cmd.find("\n", i)
            i = n if j < 0 else j
            continue
        if c in " \t":
            end_word()
            i += 1
            continue
        if c == "\n":
            end_stage(True)
            i += 1
            for delim, owner in pending:
                body = []
                while i < n:
                    j = cmd.find("\n", i)
                    line = cmd[i:] if j < 0 else cmd[i:j]
                    i = n if j < 0 else j + 1
                    if line.strip() == delim:
                        break
                    body.append(line)
                owner["bodies"].append("\n".join(body))
            pending.clear()
            continue
        if c == ">" or (c == "&" and cmd[i + 1:i + 2] == ">"):
            fd = "1"
            if c == "&":
                fd, i = "&", i + 1
            elif has and "".join(word).isdigit():
                fd, word, has = "".join(word), [], False
            end_word()
            i += 1
            if cmd[i:i + 1] in (">", "|"):
                i += 1
            if cmd[i:i + 1] == "&":  # >&2, 2>&1: into another of the command's own outputs, which Claude reads too
                i += 1
                redirect = "skip"
            else:
                redirect = "out" if fd in ("1", "&") else "skip"
            continue
        if c == "<":
            end_word()
            if cmd.startswith("<<<", i):
                redirect, i = "skip", i + 3
            elif cmd.startswith("<<", i):
                i += 3 if cmd[i + 2:i + 3] == "-" else 2
                redirect = "heredoc"
            else:
                i += 1  # input from a file: the file stays a word of the stage, which reads it
            continue
        if c == "|":
            two = cmd[i + 1:i + 2]
            end_stage(two == "|")
            i += 2 if two in ("|", "&") else 1
            continue
        if c == "&":
            end_stage(True)
            i += 2 if cmd[i + 1:i + 2] == "&" else 1
            continue
        if c in ";()`" or (c == "$" and cmd[i + 1:i + 2] == "("):
            end_stage(True)
            i += 2 if c == "$" else 1
            continue
        word.append(c)
        has = True
        i += 1
    end_stage(True)
    return [p for p in pipes if p]


def _subst_end(cmd: str, i: int) -> int:
    """The index after the `)` that closes a command substitution whose text starts at `i`: parentheses nest, and
    quoted text holds none that count."""
    depth, n = 1, len(cmd)
    while i < n:
        c = cmd[i]
        if c == "\\":
            i += 2
            continue
        if c in "'\"":
            j = cmd.find(c, i + 1)
            i = n if j < 0 else j + 1
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if not depth:
                return i + 1
        i += 1
    return n


def program(words: list[str]) -> tuple[str, list[str]]:
    """A stage's program (its base name) and its arguments, past assignments and wrappers such as sudo and xargs."""
    i = 0
    while i < len(words):
        w = words[i]
        if w in WRAPPERS or re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w):
            i += 1
        elif w == "timeout":
            i += 2 if i + 1 < len(words) and re.match(r"^[\d.]+[smhd]?$", words[i + 1]) else 1
        elif w == "xargs":
            i += 1
            while i < len(words) and words[i].startswith("-"):
                i += 2 if words[i] in ("-n", "-I", "-P", "-L", "-d", "-s", "-E", "-a") else 1
        else:
            break
    if i >= len(words):
        return "", []
    prog, args = words[i].rsplit("/", 1)[-1], words[i + 1:]
    if prog == "git" and args[:1] == ["grep"]:
        prog, args = "grep", args[1:]
    return prog, args


# ------------------------------------------------------------------ what one stage shows


def _count(args: list[str]) -> tuple[str, int]:
    """head's or tail's count: ("n", 20); ("+", 5) for `tail -n +5`; ("-", 3) for `head -n -3`; ("c", 0) for bytes."""
    for j, a in enumerate(args):
        v = None
        if a in ("-n", "--lines") and j + 1 < len(args):
            v = args[j + 1]
        elif a.startswith("--lines="):
            v = a[8:]
        elif re.match(r"^-n[+-]?\d+$", a):
            v = a[2:]
        elif re.match(r"^-\d+$", a):
            v = a[1:]
        elif re.match(r"^\+\d+$", a):
            v = a
        elif a in ("-c", "--bytes") or re.match(r"^-c\d+$", a) or a.startswith("--bytes="):
            return "c", 0
        if v is not None and re.match(r"^[+-]?\d+$", v):
            return ("+" if v[0] == "+" else "-" if v[0] == "-" else "n"), abs(int(v))
    return "n", 10


def _sed(args: list[str]) -> tuple[str, Range | None]:
    if any(a.startswith("--in-place") or (not a.startswith("--") and re.match(r"^-[A-Za-z]*i", a)) for a in args):
        return "computed", None  # it edits the file and prints nothing
    quiet = any(a in ("--quiet", "--silent") or (re.match(r"^-[A-Za-z]+$", a) and "n" in a) for a in args)
    script = next((args[j + 1] for j, a in enumerate(args) if a in ("-e", "--expression") and j + 1 < len(args)), None)
    if script is None:
        script = next((a for a in args if not a.startswith("-")), "")
    if not quiet:
        return "read", None  # every line, as the script changed it
    m = re.match(r"^\s*(\d+)\s*(?:,\s*(\d+|\$)\s*)?p", script)
    if not m:
        return ("searched", None) if script.lstrip().startswith("/") else ("computed", None)
    x, y = int(m.group(1)), m.group(2)
    if y == "$":
        return "read", (lambda a, b: (a + x - 1, b))
    last = int(y) if y else x
    return "read", (lambda a, b: (a + x - 1, min(b, a + last - 1)))


def counts_only(args: list[str]) -> bool:
    """A search that prints only names or counts: -c, -l, -L, -q, --files."""
    for a in args:
        if a in ("--count", "--count-matches", "--files-with-matches", "--files-without-match", "--quiet", "--silent", "--files"):
            return True
        if a.startswith("--") or not a.startswith("-") or len(a) < 2 or a[1].isdigit():
            continue
        for ch in a[1:]:
            if ch in "ABCmefgtTMd":  # a flag whose value follows
                break
            if ch in "clLq":
                return True
    return False


# a search's long options whose value is the next word, unless written with "="
SEARCH_VALUED = {"--regexp", "--file", "--max-count", "--context", "--after-context", "--before-context", "--glob",
                 "--iglob", "--type", "--type-not", "--include", "--exclude", "--exclude-dir", "--max-depth", "--threads",
                 "--max-columns", "--encoding", "--devices", "--directories", "--label"}


def search_operands(args: list[str]) -> list[str]:
    """A search's words that name what it searches: its operands after the pattern (`grep -o '"cost":[0-9.]*' a.jsonl`
    searches a.jsonl; its pattern is no file and no glob). The pattern is the value of -e or -f when given, else the
    first word that is no option; a short flag whose value follows (`-A 3`, `-g '*.py'`, `-m5`) and a long one in
    SEARCH_VALUED take that value; `--` ends the options."""
    out: list[str] = []
    pattern_given = False
    pattern_seen = False
    i, opts = 0, True
    while i < len(args):
        a = args[i]
        i += 1
        if opts and a == "--":
            opts = False
            continue
        if opts and a.startswith("--"):
            name = a.split("=", 1)[0]
            if name in ("--regexp", "--file"):
                pattern_given = True
            if name in SEARCH_VALUED and "=" not in a:
                i += 1
            continue
        if opts and a.startswith("-") and len(a) > 1 and not a[1].isdigit():
            for k, ch in enumerate(a[1:], 1):
                if ch in "ABCmefgtTMd":  # a flag whose value follows, in this word or the next
                    pattern_given = pattern_given or ch in "ef"
                    i += 0 if k + 1 < len(a) else 1
                    break
            continue
        if not pattern_given and not pattern_seen:
            pattern_seen = True
            continue
        out.append(a)
    return out


def stage_shows(prog: str, args: list[str]) -> tuple[str, Range | None]:
    """What one stage does with the lines it gets: ("read", the lines it prints as a function of their range, None for
    all of them), ("searched", None), ("computed", None) or ("listed", None)."""
    if COMPUTES.match(prog) or prog in COUNTS or prog in DECODES:
        return "computed", None
    if prog in SEARCHES:
        if "--files" in args:  # `rg --files` lists the names it would search
            return "listed", None
        return ("computed" if counts_only(args) else "searched"), None
    if prog in ("cat", "tac", "nl", "less", "more", "bat", "batcat"):
        return "read", None
    if prog in ("head", "tail"):
        k, v = _count(args)
        if k == "c":
            return "read", None
        if prog == "head":
            return "read", ((lambda a, b: (a, b - v)) if k == "-" else (lambda a, b: (a, min(b, a + v - 1))))
        return "read", ((lambda a, b: (a + v - 1, b)) if k == "+" else (lambda a, b: (max(a, b - v + 1), b)))
    if prog == "sed":
        return _sed(args)
    return "listed", None


def script_of(prog: str, args: list[str]) -> str | None:
    """The script file a program runs: an interpreter's first word that is no option (`python3 -I scan.py x.jsonl`),
    or the file after `-f` (`awk -f count.awk`, `jq -f q.jq`); None for code given inline (`-c`, `-e`, `-m`, a cluster
    that ends in e such as perl's `-ne`) or read from stdin (`python3 - x.jsonl <<'PY'`)."""
    if SCRIPTED.match(prog):
        skip = False
        for a in args:
            if skip:
                skip = False
            elif a in ("-", "-c", "-e", "-E", "-m", "--eval", "--print", "-p") or re.fullmatch(r"-[A-Za-z]+e", a):
                return None
            elif a in ("-X", "-W", "-r", "--require"):
                skip = True
            elif not a.startswith("-"):
                return a
        return None
    if COMPUTES.match(prog) and "-f" in args[:-1]:
        return args[args.index("-f") + 1]
    return None


# ------------------------------------------------------------------ the files a command names


def _glob_rx(pat: str) -> re.Pattern[str]:
    """A shell glob as a regex over a relative path: * and ? stay within one folder, ** crosses folders."""
    out, i = [], 0
    while i < len(pat):
        if pat.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pat.startswith("**", i):
            out.append(".*")
            i += 2
        elif pat[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pat[i] == "?":
            out.append("[^/]")
            i += 1
        elif pat[i] == "[" and pat.find("]", i + 1) > 0:
            j = pat.find("]", i + 1)
            body = pat[i + 1:j]
            out.append("[" + ("^" + body[1:] if body.startswith("!") else body) + "]")
            i = j + 1
        else:
            out.append(re.escape(pat[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


def _literal_parts(pat: str) -> list[str]:
    """The parts of a glob that every name or path it matches holds as written: the text between its wildcards, as
    fnmatch (Grep's globs) and _glob_rx (the shell's) both read it. The `/` after `**` is no part (`**/a.json` matches
    `a.json`). A `[` that a `]` follows opens a set up to that `]`; after a set that one of them ends elsewhere (`[]`,
    `[!]`, a `\\` before the `]`), no part is known."""
    out, run, i, n = [], "", 0, len(pat)
    while i < n:
        c = pat[i]
        if c not in "*?[" or (c == "[" and "]" not in pat[i + 1:]):
            run += c
            i += 1
            continue
        if run:
            out.append(run)
            run = ""
        if c == "[":
            j = pat.find("]", i + 1)
            if pat[i + 1:j] in ("", "!") or pat[j - 1] == "\\":
                return out
            i = j + 1
        elif c == "?":
            i += 1
        else:
            j = i
            while j < n and pat[j] == "*":
                j += 1
            i = j + 1 if j - i > 1 and pat.startswith("/", j) else j
    return out + [run] if run else out


# a word of code: in code, braces are interpolation or a literal (`f"{d}/{x}.png"`), never part of a file's name
_TOKEN = re.compile(r"[\w./*?\[\]~+-]+")
_SHELL_TOKEN = re.compile(r"[\w./*?\[\]{}~+$-]+")
_VAR = re.compile(r"\$\{?([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?])\}?")


def variables(cmd: str) -> dict[str, list[str]]:
    """The values a command gives its shell variables: `R=runs/a` and `for r in a b; do`. A variable set twice keeps
    each value."""
    out: dict[str, list[str]] = {}
    for m in re.finditer(r"(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=(\"[^\"]*\"|'[^']*'|[^\s;&|)]*)", cmd):
        out.setdefault(m.group(1), []).append(m.group(2).strip("'\""))
    for m in re.finditer(r"\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;\n]*?)\s*(?:;|\n)\s*do\b", cmd):
        words = re.findall(r"\"[^\"]*\"|'[^']*'|\S+", m.group(2))
        out.setdefault(m.group(1), []).extend(w.strip("'\"") for w in words)
    return out


def _expand(t: str, values: dict[str, list[str]]) -> list[str]:
    """A word with shell variables as the paths it can stand for: each variable the command set takes its values, and
    one it did not set stands for any one folder or name (`runs/$r/forge.db` is `runs/*/forge.db`, never every file
    under runs/). A word that is only variables the command did not set (`$f`) names nothing."""
    unset = [m.group(1) for m in _VAR.finditer(t) if not values.get(m.group(1))]
    if unset and not re.search(r"[A-Za-z0-9]", _VAR.sub("", t)):
        return []
    outs = [t]
    for name in dict.fromkeys(m.group(1) for m in _VAR.finditer(t)):
        vals = [v for v in values.get(name, []) if "$" not in v] or ["*"]
        rx = re.compile(r"\$\{?" + re.escape(name) + r"(?![A-Za-z0-9_])\}?")
        outs = [rx.sub(lambda _m, v=v: v, o) for o in outs for v in vals][:64]
    return [o for o in outs if "$" not in o]


class Known:
    """The root's files, relative paths in a sorted list. The files under a folder are one range of that list, and so
    are the names in a folder that start with the same letters, so a path, a folder and a glob are looked up by bisect,
    folder by folder as the shell matches a glob, and never by a pass over every file for each word of a command. A
    file named only by the end of its path (`meta.json` after a `cd` the command hid) is looked up among the files
    with its extension, which are indexed by name when a word first asks for that extension: a folder of a million
    screenshots is not indexed by name unless a command names a screenshot. A part of a glob that can match at any
    depth (`**/*r0123*`, `*/made/x`) is looked up once by the names that hold its literal pieces (_like), and a Grep's
    glob is tried only on the files that hold one (candidates), each when that costs less than walking the folders or
    testing the files it would go over: a lookup that costs more stops. Every file is indexed by name only once the
    walks that index could have spared cost as much as making it (_names_index)."""

    def __init__(self, files: list[str]):
        """`files` sorted, each once (sources.list_files gives them so)."""
        self.files = files
        self.set = set(files)
        self._globs: dict[str, frozenset[str]] = {}
        self._sets: dict[frozenset[str], frozenset[str]] = {}  # each glob's files, one set for equal ones
        self._names: dict[str, dict[str, list[str]]] = {}
        self._walked = 0  # what the walks a lookup in _named could have spared cost so far (_names_index)

    @functools.cached_property
    def folders(self) -> set[str]:
        out: set[str] = set()
        for f in self.files:
            d = f
            while "/" in d:
                d = d.rsplit("/", 1)[0]
                if d in out:
                    break
                out.add(d)
        return out

    @functools.cached_property
    def folder_list(self) -> list[str]:
        return sorted(self.folders)

    @functools.cached_property
    def by_ext(self) -> dict[str, list[str]]:
        """The files by extension, lower case with its dot (`.png`), or "" for a name with none."""
        raw: dict[str, list[str]] = {}  # by the extension as written: one lookup per file, lower case once per extension
        for f in self.files:
            dot = f.rfind(".")
            e = f[dot:] if f.rfind("/") + 1 < dot < len(f) - 1 else ""
            fs = raw.get(e)
            if fs is None:
                fs = raw[e] = []
            fs.append(f)
        out: dict[str, list[str]] = {}
        for e, fs in raw.items():
            low = e.lower()
            out[low] = sorted(out[low] + fs) if low in out else fs
        return out

    def has_folder(self, folder: str) -> bool:
        """Whether some file lies under the folder (a relative path, no trailing `/`)."""
        i = bisect.bisect_left(self.files, folder + "/")
        return i < len(self.files) and self.files[i].startswith(folder + "/")

    def under(self, folder: str) -> list[str]:
        """The files at any depth under a folder; every file for `.`."""
        if folder in (".", ""):
            return self.files
        lo, hi = self.span(folder)
        return self.files[lo:hi]

    def span(self, folder: str) -> tuple[int, int]:
        """Where the files under a folder are in the sorted list: files[lo:hi]; all of them for `.`."""
        if folder in (".", ""):
            return 0, len(self.files)
        lo = bisect.bisect_left(self.files, folder + "/")
        return lo, bisect.bisect_left(self.files, folder + "0", lo)  # "0" is the character after "/"

    @functools.cached_property
    def _named(self) -> tuple[dict[str, list[str]], list[str], str, list[int]]:
        """The files by their name, and each name once, joined (_joined)."""
        by: dict[str, list[str]] = {}
        for f in self.files:
            name = f[f.rfind("/") + 1:]
            fs = by.get(name)
            if fs is None:
                by[name] = [f]
            else:
                fs.append(f)
        names = list(by)
        return (by, names, *_joined(names))

    def _names_index(self, walk: int) -> tuple[dict[str, list[str]], list[str], str, list[int]] | None:
        """The files by name (_named), for a lookup that could spare a walk of `walk` steps (a test of a file or a step
        into a folder, each about what indexing one file costs): made once the walks it could have spared, this one
        with them, cost as much as indexing every file; None before, so a session that globs or Greps a few times
        never pays for it. A walk shorter than 1/64 of the files, about what a pass over their names costs, is one no
        lookup could spare, and does not count."""
        if "_named" not in self.__dict__:
            if walk < len(self.files) >> 6:
                return None
            self._walked += walk
            if self._walked < len(self.files):
                return None
        return self._named

    def candidates(self, pat: str, folder: str = "") -> Iterable[str]:
        """The files under a folder ("" or `.` for all) that a Grep's glob can match by name or by path, for the
        caller to test. Each literal piece of the glob (_literal_parts, cut at each `/`) lies in the file's name or in
        the name of a folder above it, so the files that hold a piece are found by name (_held), for the piece that
        costs the least, when that costs less than half a test of each of the folder's own files (the files found are
        tested after); else the folder's files are tested. A glob into a root of 150,000 files costs a test of the
        files that hold its rarest piece; `*.json` into a folder of 150 files costs a test of those 150."""
        folder = "" if folder == "." else folder
        lo, hi = self.span(folder or ".")
        pieces = {p for part in _literal_parts(pat) for p in part.split("/") if p and p not in folder}
        most = (hi - lo) // 2
        held = None
        if pieces and self._names_index(hi - lo) is not None:
            names, folders = self._named[2], self._folder_names[2]
            if most >= 2 * len(pieces) * _passes(names, folders):  # each piece counted, then found
                held = _cheapest(sorted(pieces), lambda p: names.count(p) + folders.count(p),
                                 lambda p, n: self._held(p, folder, n), most, lambda h: h[0])
        if held is None:
            return self.files[lo:hi]
        _, named, spans = held
        out = {f for fs, a, b in named for f in fs[a:b]}
        for a, b in spans:
            out.update(self.files[a:b])
        return out

    def _held(self, piece: str, folder: str, most: int
              ) -> tuple[int, list[tuple[list[str], int, int]], list[tuple[int, int]]] | None:
        """Where the files under a folder ("" for all) are whose name holds `piece`, or the name of a folder between
        them and it: (what finding them cost, the files of each such name as (its files, from, to), and each such
        folder's span of the sorted files), or None once that costs more than `most`. Each name found costs one, and
        each file it gives; the names are each found once by str.find over all the names joined (_named,
        _folder_names), and the files or folders of a name under the folder by bisect (_within)."""
        by, names, text, starts = self._named
        ks = _holding(text, starts, piece, most)
        if ks is None:
            return None
        cost = len(ks)
        named: list[tuple[list[str], int, int]] = []
        for k in ks:
            got = by[names[k]]
            a, b = _within(got, folder)
            cost += b - a
            if cost > most:
                return None
            named.append((got, a, b))
        by, names, text, starts = self._folder_names
        ks = _holding(text, starts, piece, most - cost)
        if ks is None:
            return None
        cost += len(ks)
        spans: list[tuple[int, int]] = []
        for k in ks:
            got = by[names[k]]
            a, b = _within(got, folder)
            for d in got[a:b]:
                s, e = self.span(d)
                cost += 1 + e - s
                if cost > most:
                    return None
                spans.append((s, e))
        return cost, named, spans

    def ending(self, tail: str) -> set[str]:
        """The files whose path is `tail` or ends with `/tail`, and the files whose path `tail` ends with (a path to a
        file of the root through a link or another folder: `/work/link/runs/a.json` names `runs/a.json`)."""
        name = tail.rsplit("/", 1)[-1]
        dot = name.rfind(".")
        ext = name[dot:].lower() if 0 < dot < len(name) - 1 else ""
        index = self._names.get(ext)
        if index is None:
            index = self._names[ext] = {}
            for f in self.by_ext.get(ext, []):
                index.setdefault(f[f.rfind("/") + 1:], []).append(f)
        hit = {f for f in index.get(name, []) if f == tail or f.endswith("/" + tail)}
        at = tail.find("/")
        while at >= 0:
            if tail[at + 1:] in self.set:
                hit.add(tail[at + 1:])
            at = tail.find("/", at + 1)
        return hit

    def _files_in(self, folder: str, head: str) -> list[str]:
        """The files directly in a folder whose names start with `head`; each subfolder's files are passed over by one
        bisect."""
        base = folder + "/" if folder else ""
        start = base + head
        out = []
        i = bisect.bisect_left(self.files, start)
        while i < len(self.files) and self.files[i].startswith(start):
            f = self.files[i]
            sub = f.find("/", len(base))
            if sub < 0:
                out.append(f)
                i += 1
            else:
                i = bisect.bisect_left(self.files, f[:sub] + "0", i)  # "0" is the character after "/"
        return out

    def _folders_under(self, folder: str) -> list[str]:
        """The folders at any depth under a folder (every folder for the root)."""
        if not folder:
            return self.folder_list
        lo = bisect.bisect_left(self.folder_list, folder + "/")
        return self.folder_list[lo:bisect.bisect_left(self.folder_list, folder + "0", lo)]

    def _count_under(self, folder: str) -> int:
        """How many folders _folders_under gives."""
        if not folder:
            return len(self.folder_list)
        lo = bisect.bisect_left(self.folder_list, folder + "/")
        return bisect.bisect_left(self.folder_list, folder + "0", lo) - lo

    @functools.cached_property
    def _folders_in(self) -> dict[str, list[str]]:
        """The folders directly in each folder ("" for the root)."""
        out: dict[str, list[str]] = {}
        for d in self.folder_list:
            out.setdefault(d[:d.rfind("/")] if "/" in d else "", []).append(d)
        return out

    @functools.cached_property
    def _folder_names(self) -> tuple[dict[str, list[str]], list[str], str, list[int]]:
        """The folders by their name (`steps`), and each name once, joined (_joined)."""
        by: dict[str, list[str]] = {}
        for d in self.folder_list:
            by.setdefault(d[d.rfind("/") + 1:], []).append(d)
        names = list(by)
        return (by, names, *_joined(names))

    def folders_called(self, name: str) -> list[str]:
        """The folders at any depth with this name."""
        return self._folder_names[0].get(name, [])

    def _like(self, index: tuple[dict[str, list[str]], list[str], str, list[int]], part: str,
              most: int) -> list[str] | None:
        """The paths at any depth in an index by name (_named for files, _folder_names for folders) whose name a part
        of a glob matches (`steps`, `*.json`, `r01*`), or None once finding them costs more than `most`. Each name
        found costs one, and each path it gives: only the names that hold the part's rarest literal piece are found
        (_cheapest), and each is tested once, so one test of `step0*.json` stands for every file of that name. A part
        with no literal piece (`*`) is not looked up."""
        by, names, text, starts = index
        if not re.search(r"[*?\[]", part):
            got = by.get(part, [])
            return got if len(got) <= most else None
        pieces = sorted(set(_literal_parts(part)))
        if not pieces or most < 2 * len(pieces) * _passes(text):  # each piece counted, then found
            return None
        ks = _cheapest(pieces, text.count, lambda p, n: _holding(text, starts, p, n), most, len)
        if ks is None:
            return None
        rx = _glob_rx(part)
        out: list[str] = []
        cost = len(ks)
        for k in ks:
            if rx.match(names[k]):
                got = by[names[k]]
                cost += len(got)
                if cost > most:
                    return None
                out.extend(got)
        return out

    def glob(self, pat: str) -> frozenset[str]:
        """The files a glob names, matched one part of the path at a time as the shell matches it: `*`, `?` and
        `[...]` within one name, `**` alone as a part for any number of folders. Each result is kept, since a command
        and the commands after it repeat their words, and globs that name the same files give the same set."""
        got = self._globs.get(pat)
        if got is None:
            got = self._glob(pat)
            got = self._globs[pat] = self._sets.setdefault(got, got)
        return got

    def _glob(self, pat: str) -> frozenset[str]:
        """Known.glob's files, made as a frozenset where they are found (a copy of 150,000 names costs 10 ms), from a
        list (a generator's steps cost more than a list's)."""
        here = [""]  # the folders the parts so far name
        parts = pat.split("/")
        k = 0
        while k < len(parts):
            part = parts[k]
            last = k == len(parts) - 1
            wild = re.search(r"[*?\[]", part)
            if part == "**" and last:
                return frozenset([f for d in here for f in self.under(d)])
            if part == "**" and k == len(parts) - 2:
                # `**/name`: the files under these folders whose name matches, looked up by name once for all of them
                # (`*r0123*` finds the names that hold `r0123`) when that costs less than half a test of each file it
                # spares; else tested one by one, first by how they end (`*.json`: `.json`, a test that costs half a
                # step): the files under these folders, or the files of the extensions that can end so, when they are
                # fewer than half of those (each is then checked to be under one of the folders)
                tops = _outermost(here)
                above = set(tops)
                rx, end = _glob_rx(parts[-1]), re.split(r"[*?\]]", parts[-1])[-1]
                low = end.lower()
                ending = [fs for e, fs in self.by_ext.items() if not e or e.endswith(low) or low.endswith(e)]
                spans = [self.span(d) for d in tops]
                n_ending, n_under = sum(map(len, ending)), sum(b - a for a, b in spans)
                walk = min(n_ending, n_under) // 2
                index = self._names_index(walk)
                found = None if index is None else self._like(index, parts[-1], walk)
                if found is not None:
                    return frozenset(found) if "" in above else frozenset([f for f in found if _below(f, above)])
                if "" in above or 2 * n_ending <= n_under:
                    return frozenset([f for fs in ending for f in fs
                                      if f.endswith(end) and rx.match(f, f.rfind("/") + 1)
                                      and ("" in above or _below(f, above))])
                return frozenset([f for a, b in spans for f in self.files[a:b]
                                  if f.endswith(end) and rx.match(f, f.rfind("/") + 1)])
            if part == "**" and parts[k + 1] == "**":  # `**/**` is `**`
                k += 1
                continue
            if part == "**" or (wild and not last):
                found = self._looked_up(parts, k, here)
                if found is not None:
                    k, got = found
                    if k == len(parts) - 1:
                        return got
                    here = got
                    k += 1
                    continue
            if part == "**":
                here = sorted({*here, *(d2 for d in here for d2 in self._folders_under(d))})
            elif not wild:
                paths = [f"{d}/{part}" if d else part for d in here]
                if last:
                    return frozenset([p for p in paths if p in self.set])
                here = [p for p in paths if p in self.folders]
            elif last:
                rx = _glob_rx(part)
                return frozenset([f for d in here for f in self._files_in(d, part[:wild.start()])
                                  if rx.match(f, f.rfind("/") + 1)])
            else:
                rx = _glob_rx(part)
                here = [d2 for d in here for d2 in self._folders_in.get(d, ()) if rx.match(d2, d2.rfind("/") + 1)]
            k += 1
        return frozenset()

    def _looked_up(self, parts: list[str], k: int, here: list[str]) -> tuple[int, frozenset[str] | list[str]] | None:
        """Part k of a glob (`**`, or a pattern before the last part) and the parts after it up to the first that
        names something (`made` in `*/made/x` and in `**/*/made/x`), found by that name once for all of `here` (_like),
        each then checked against the parts above it, when finding them costs less than half the folders to walk
        through from `here` (a check costs more than a step of the walk): (j, the folders parts[k..j] name), or (j, the
        files) when part j is the last. None to walk instead."""
        deep = parts[k] == "**"
        j = k + 1 if deep else k
        while j < len(parts) - 1 and parts[j] != "**" and not _literal_parts(parts[j]):
            j += 1
        name, last = parts[j], j == len(parts) - 1
        if name == "**" or not _literal_parts(name):
            return None
        tops = set(here)
        walk = (sum(self._count_under(d) for d in _outermost(tops)) if deep
                else sum(len(self._folders_in.get(d, ())) for d in tops))
        index = self._names_index(walk) if last else self._folder_names
        found = None if index is None else self._like(index, name, walk // 2)
        if found is None:
            return None
        above = [_glob_rx(p) for p in parts[k + 1 if deep else k:j]]
        got = [p for p in found if _ends(p, above, tops, deep)]
        return j, frozenset(got) if last else got


def as_known(known: "Known | Iterable[str]") -> Known:
    return known if isinstance(known, Known) else Known(sorted(set(known)))


def _joined(items: list[str]) -> tuple[str, list[int]]:
    """The items in one string, a NUL after each (no path holds one), and where each starts."""
    return "\0".join(items) + "\0", list(itertools.accumulate((len(x) + 1 for x in items), initial=0))


def _within(paths: list[str], folder: str) -> tuple[int, int]:
    """Where the paths under a folder ("" for all) are in a sorted list of paths: paths[a:b]."""
    if not folder:
        return 0, len(paths)
    a = bisect.bisect_left(paths, folder + "/")
    return a, bisect.bisect_left(paths, folder + "0", a)  # "0" is the character after "/"


def _holding(text: str, starts: list[int], part: str, most: int) -> list[int] | None:
    """Which of the joined items (_joined) hold `part`, each once, found by str.find; None once more than `most` do."""
    out, i = [], text.find(part)
    while i >= 0:
        if len(out) >= most:
            return None
        k = bisect.bisect_right(starts, i) - 1
        out.append(k)
        i = text.find(part, starts[k + 1])
    return out


_T = TypeVar("_T")


def _cheapest(pieces: list[str], count: Callable[[str], int], find: Callable[[str, int], "_T | None"], most: int,
              cost: Callable[[_T], int]) -> _T | None:
    """What `find(piece, limit)` gives (None once finding costs more than the limit) for the piece that costs the
    least, when that is at most `most`; else None. The pieces are tried from the one the fewest names hold (`count`:
    str.count over the joined names, at C speed, at least as many as hold it), each only until it costs more than
    the cheapest so far, so a piece that most names hold (`.json`) is not looked for one name at a time."""
    best = None
    for n, p in sorted((count(p), p) for p in pieces):
        if n > most:
            break
        got = find(p, most)
        if got is not None:
            best, most = got, cost(got)
    return best


def _passes(*texts: str) -> int:
    """What a pass over joined names costs, in the unit a lookup counts (a name or a path it finds): one for each
    1,024 characters. A lookup whose budget is less does not start, so a Grep into a folder of 150 files, among
    150,000 names, tests those 150 files rather than pass over all the names."""
    return sum(len(t) for t in texts) >> 10


def _below(d: str, tops: set[str]) -> bool:
    """Whether a folder is in one of `tops`, at any depth."""
    at = d.find("/")
    while at >= 0:
        if d[:at] in tops:
            return True
        at = d.find("/", at + 1)
    return False


def _ends(path: str, above: list[re.Pattern[str]], tops: set[str], deep: bool) -> bool:
    """Whether the folders right above `path` have names that `above` matches, in order, and the folder above those
    is one of `tops`, or with `deep` (after a `**`) one of them or in one."""
    names = path.split("/")
    m = len(above)
    if len(names) < m + 1 or not all(rx.match(n) for rx, n in zip(above, names[-1 - m:-1])):
        return False
    up = "/".join(names[:-1 - m])
    return up in tops or deep and ("" in tops or _below(up, tops))


def _outermost(folders: Iterable[str]) -> list[str]:
    """The folders that are in none of the others ("" is the root, which holds them all)."""
    have = set(folders)
    if "" in have:
        return [""]
    out = []
    for d in sorted(have):
        at = d.find("/")
        while at >= 0 and d[:at] not in have:
            at = d.find("/", at + 1)
        if at < 0:
            out.append(d)
    return out


def _here(cwd: str | None, root: str) -> str:
    """The command's folder relative to the root (`.` for the root); "\\0" for a folder beside the root, whose paths
    resolve only by their end."""
    root = root.rstrip("/")
    if not cwd:
        return "."
    if cwd == root or cwd.startswith(root + "/") or root.startswith(cwd.rstrip("/") + "/"):
        return os.path.relpath(cwd, root)
    return "\0"


class Files:
    """The files a command's words name: the set of each glob, as Known.glob keeps it (the same set for every word
    that globs the same files), and the files named one by one. Kept apart, code that globs 140,000 files and opens one
    more makes no copy of the 140,000, and coverage adds a glob's set once, however many commands name it."""

    __slots__ = ("globs", "files")

    def __init__(self, globs: Iterable[frozenset[str]] = (), files: Iterable[str] = ()):
        self.globs = tuple(globs)
        self.files = frozenset(files)

    def __bool__(self) -> bool:
        return bool(self.files) or any(self.globs)

    def every(self) -> set[str]:
        """All of them, each once."""
        return set(self.files).union(*self.globs)


def named(text: str, known: "Known | Iterable[str]", root: str, cwd: str | None = None,
          values: dict[str, list[str]] | None = None) -> tuple[Files, set[str]]:
    """The files and the folders a command's words name: (files, folders), each a path relative to the root. A file is
    named by its path or a glob; a folder by its path, and it stands for its files without listing them. A path
    resolves from the command's folder first, so `cat x.csv` names that folder's x.csv and not every x.csv under the
    root, and `*` stays within one folder; a path that does not resolve matches by its end, as after a `cd`. A shell
    variable takes the values the command gave it (`values`), else stands for one folder or name."""
    root = root.rstrip("/")
    K = as_known(known)
    here = _here(cwd, root)
    files: set[str] = set()
    globbed: list[frozenset[str]] = []
    folders: set[str] = set()
    tokens: set[str] = set()
    # a heredoc's body is not shell (no `values`): a `$` in it only ends a word; in code, a word right after an
    # interpolation (`f"{d}/forge.db"`, `` `${run}/a.json` ``) is a path whose start the code fills in, which stands for
    # any one folder or name, as a shell variable the command did not set does
    for m in (_TOKEN if values is None else _SHELL_TOKEN).finditer(text):
        t = m.group(0)
        if values is None and m.start() and text[m.start() - 1] == "}" and t[:1] in "/._-":
            t = "*" + t
        tokens.update(_expand(t, values) if values is not None and "$" in t else [t])
    for t in tokens:
        t = t.strip("'\"")
        if len(t) < 3:
            continue
        if t.startswith(root + "/"):
            t, rel = t[len(root) + 1:], os.path.normpath(t[len(root) + 1:])
        else:
            rel = os.path.normpath(os.path.join(here, t))
        if "*" in t or "?" in t:
            got = K.glob(rel) or K.glob("**/" + re.sub(r"^(?:\./)+", "", t))
            if got and all(g is not got for g in globbed):
                globbed.append(got)
        elif "." not in t and "/" not in t:
            # a bare word: a shell word names the file or the folder it is (`ls shots`, `cat Makefile`); in code it is
            # mostly a name of the code's own (`runs = []`), so code names a file only by a path or a name with a dot
            if values is not None and not t.startswith("-"):
                if rel in K.set:
                    files.add(rel)
                elif K.has_folder(rel):
                    folders.add(rel)
        else:
            if rel in K.set:
                files.add(rel)
                continue
            folder_word = t.endswith("/") or "." not in Path(t).name
            if folder_word and K.has_folder(rel):
                folders.add(rel)
                continue
            tt = t.rstrip("/")
            # a path that resolves by its end, as after a `cd`: a file whose path ends with the word, or a word that
            # ends with the file's path; and for a folder's word, a folder whose path ends with it
            files |= K.ending(tt)
            if folder_word:
                folders.update(d for d in K.folders_called(tt[tt.rfind("/") + 1:]) if d == tt or d.endswith("/" + tt))
    return Files(globbed, files), folders


# ------------------------------------------------------------------ a whole command


def _script_key(word: str, cwd: str | None, root: str) -> str:
    """A script's path as a key: a word that starts at a variable or the home folder stays as written (the same word
    names the same file in the session's later commands), any other is made absolute from the command's folder."""
    if word[:1] in ("$", "~"):
        return os.path.normpath(word)
    return os.path.normpath(os.path.join(cwd or root, word))


def _script_text(key: str, scripts: dict[str, str]) -> str:
    """A script's text: as a command of the session wrote it with a here-document, else as the file holds it now (a
    script Claude wrote with its Write tool), up to SCRIPT_MAX_BYTES; "" when neither is known, or when the path is no
    regular file (a pipe or /dev/stdin would wait for input that never comes)."""
    if key in scripts:
        return scripts[key]
    if key[:1] != "/" or not os.path.isfile(key):
        return ""
    try:
        with open(key, "rb") as f:
            return f.read(SCRIPT_MAX_BYTES).decode("utf-8", "replace")
    except OSError:
        return ""


def shows(cmd: str, known: "Known | Iterable[str]", root: str, cwd: str | None, lines_of: Callable[[str], int],
          scripts: dict[str, str] | None = None) -> list[tuple[str, str, tuple[int, int] | None, str]]:
    """What the command did with each file and folder it names: (path, how, (first, last), program), how being "read"
    (with the lines it printed), "searched", "computed" (with the lines it went over, or None for all) or "listed"; a
    folder's path ends with `/`. `scripts` keeps the scripts the session's commands wrote, from one command to the next.
    The `thimble` command keeps its own record, so its stages and heredocs are left out here."""
    return [(f, how, span, prog) for path, how, span, prog in shows_sets(cmd, known, root, cwd, lines_of, scripts)
            for f in ((path,) if isinstance(path, str) else sorted(path.every()))]


def shows_sets(cmd: str, known: "Known | Iterable[str]", root: str, cwd: str | None, lines_of: Callable[[str], int],
               scripts: dict[str, str] | None = None) -> list[tuple["str | Files", str, tuple[int, int] | None, str]]:
    """shows, with the files one program searched, listed or went over whole as one entry, a Files, in place of one
    entry per file (shows lists its files in their order, where the entry stands)."""
    out: list[tuple[str | Files, str, tuple[int, int] | None, str]] = []
    known = as_known(known)
    scripts = {} if scripts is None else scripts
    values = variables(cmd)

    def code(text: str, prog: str) -> None:
        """Code went over the files it names; a folder it names, it only lists."""
        files, folders = named(text, known, root, None)
        if files:
            out.append((files, "computed", None, prog))
        out.extend((d + "/", "listed", None, prog) for d in sorted(folders))

    for pipe in pipelines(cmd):
        sent = not pipe[-1]["out"]
        for k, st in enumerate(pipe):
            prog, args = program(st["words"])
            if prog == "cd" and args and args[0] != "-":
                cwd = os.path.normpath(os.path.join(cwd or root, os.path.expanduser(args[0])))
                continue
            if prog == "thimble":
                continue
            computes = bool(COMPUTES.match(prog or ""))
            written = st["to"] + ([a for a in args if not a.startswith("-")] if prog == "tee" else [])
            for body in st["bodies"]:
                if computes:
                    # code the program runs, also when its output goes to a file (`python3 - <<'PY' > rows.json`)
                    code(body, prog)
                elif written:
                    # a here-document written to a file (`cat > scan.py <<'PY'`): a script for a later command to run
                    for to in written:
                        scripts[_script_key(to, cwd, root)] = body
                else:
                    files, folders = named(body, known, root, None)
                    if files:
                        out.append((files, "listed", None, prog or "a heredoc"))
                    out.extend((d + "/", "listed", None, prog or "a heredoc") for d in sorted(folders))
            script = script_of(prog, args) if computes else None
            if script:
                code(_script_text(_script_key(script, cwd, root), scripts), prog)
            if not prog:
                continue
            files, folders = named(" ".join(search_operands(args) if prog in SEARCHES else args), known, root, cwd, values)
            if prog in SEARCHES:
                # a search of `.`, or a recursive one with no path, searches the command's folder
                ops = search_operands(args)
                here = _here(cwd, root)
                if (any(o in (".", "./") for o in ops) or (prog in ("rg", "ag", "ack") and not ops)) and (
                        here == "." or known.has_folder(here)):
                    folders.add(here)
            if not files and not folders:
                continue
            how, rng = stage_shows(prog, args)
            narrow: list[Range] = [rng] if rng else []
            by = prog  # the program that decided what reached Claude
            for later in pipe[k + 1:]:
                if how in ("listed", "computed"):
                    break
                p2, a2 = program(later["words"])
                if p2 in SEARCHES:
                    how, by = ("computed" if counts_only(a2) else "searched"), p2
                elif p2 in ("head", "tail", "sed") and how == "read":
                    how, r2 = stage_shows(p2, a2)
                    narrow += [r2] if r2 else []
                    by = by if how == "read" else p2
                elif p2 not in PASSES or (p2 == "uniq" and any(a in ("-c", "--count") for a in a2)):
                    # a stage that takes the lines and is not known to pass them on went over them
                    how, by = "computed", p2 or "a pipe"
            if not sent and how in ("read", "searched"):
                how, by = "computed", f"{prog} > a file"  # it went over the lines, and its output went to a file
            # a folder stands for its files only for a search, which goes into it; any other program only lists it
            out.extend((d + "/", "searched" if how == "searched" else "listed", None, by) for d in sorted(folders))
            if how not in ("read", "computed") or (how == "computed" and not narrow):
                if files:
                    out.append((files, how, None, by))
                continue
            for f in sorted(files.every()):
                a, b = 1, lines_of(f) or 10 ** 9
                for r in narrow:
                    a, b = r(a, b)
                out.append((f, how, (a, b), by) if a <= b else (f, "listed", None, by))
    return out
