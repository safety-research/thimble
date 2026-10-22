"""What a shell command put in front of Claude of each file it names, for coverage (coverage.py).

A file is read only when some of its lines reached Claude: `cat`, `head`, `tail` or `sed` printed them, and what came
after in the pipeline passed them on. A search (`grep`, `rg`, `sed -n '/re/p'`) shows only the lines that matched, so it
leaves the file searched. A program that computes (`python`, `jq`, `awk`, …), named with the file or holding it in its
code (a here-document), leaves it computed: the program went over the file, taken as all of it, as code that opens a
file mostly does, and what it printed of it is not known. A command that only names, lists or counts files (`wc`,
`ls`, `find`, `git ls-files`, `grep -c`, `grep -l`) and a command whose output goes to a file leave it named. What the
rule cannot tell, it does not count as read.

    shows(command, known, root, cwd, lines_of) -> [(file, how, (first, last) or None, program)]
        how is "read" (with the lines it printed), "searched", "computed" or "named"

`known` is the root's files as a Known index (or a list, indexed on the call): a folder of a million files is looked up
by name and by folder, never scanned once per word of a command.
"""
from __future__ import annotations

import bisect
import functools
import os
import re
from pathlib import Path
from typing import Callable, Iterable

SEARCHES = {"grep", "egrep", "fgrep", "zgrep", "rg", "ag", "ack"}
# programs that compute over the files their code or their arguments name
COMPUTES = re.compile(r"^(?:python[\d.]*|pypy3?|jq|g?awk|mawk|node|perl|ruby|Rscript|sqlite3|duckdb|mlr|datamash)$")
# programs that pass on the lines they get (head, tail and sed narrow them; uniq -c counts them)
PASSES = {"cat", "less", "more", "cut", "column", "nl", "tr", "fold", "fmt", "expand", "sort", "tee", "uniq", "head", "tail", "sed"}
WRAPPERS = {"!", "{", "}", "if", "then", "else", "elif", "do", "while", "until", "time", "sudo", "command", "nohup", "exec",
            "env", "builtin", "nice"}

Range = Callable[[int, int], "tuple[int, int]"]


# ------------------------------------------------------------------ the command as pipelines


def pipelines(cmd: str) -> list[list[dict]]:
    """The command as its pipelines, each a list of stages {words, out, bodies}: `out` when the stage's output goes to
    a file rather than to Claude, `bodies` the text of its heredocs."""
    cmd = cmd.replace("\\\n", " ")
    pipes: list[list[dict]] = [[]]
    stage: dict = {"words": [], "out": False, "bodies": []}
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
                stage["out"] = stage["out"] or w not in ("/dev/stdout", "/dev/stderr", "/dev/tty")
            elif redirect != "skip":
                stage["words"].append(w)
            redirect = None
        word, has = [], False

    def end_stage(new_pipe: bool) -> None:
        nonlocal stage
        end_word()
        if stage["words"] or stage["out"] or any(s is stage for _, s in pending):
            pipes[-1].append(stage)
        stage = {"words": [], "out": False, "bodies": []}
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
        return "named", None  # it edits the file and prints nothing
    quiet = any(a in ("--quiet", "--silent") or (re.match(r"^-[A-Za-z]+$", a) and "n" in a) for a in args)
    script = next((args[j + 1] for j, a in enumerate(args) if a in ("-e", "--expression") and j + 1 < len(args)), None)
    if script is None:
        script = next((a for a in args if not a.startswith("-")), "")
    if not quiet:
        return "read", None  # every line, as the script changed it
    m = re.match(r"^\s*(\d+)\s*(?:,\s*(\d+|\$)\s*)?p", script)
    if not m:
        return ("searched", None) if script.lstrip().startswith("/") else ("named", None)
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
    all of them), ("searched", None), ("computed", None) or ("named", None)."""
    if COMPUTES.match(prog):
        return "computed", None
    if prog in SEARCHES:
        return ("named" if counts_only(args) else "searched"), None
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
    return "named", None


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


_TOKEN = re.compile(r"[\w./*?\[\]{}~+-]+")
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
    screenshots is not indexed by name unless a command names a screenshot."""

    def __init__(self, files: list[str]):
        """`files` sorted, each once (sources.list_files gives them so)."""
        self.files = files
        self.set = set(files)
        self._globs: dict[str, set[str]] = {}
        self._names: dict[str, dict[str, list[str]]] = {}

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
        out: dict[str, list[str]] = {}
        for f in self.files:
            name = f[f.rfind("/") + 1:]
            dot = name.rfind(".")
            out.setdefault(name[dot:].lower() if 0 < dot < len(name) - 1 else "", []).append(f)
        return out

    def under(self, folder: str) -> list[str]:
        """The files at any depth under a folder; every file for `.`."""
        if folder in (".", ""):
            return self.files
        lo = bisect.bisect_left(self.files, folder + "/")
        hi = bisect.bisect_left(self.files, folder + "0")  # "0" is the character after "/"
        return self.files[lo:hi]

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

    def _folders_in(self, folder: str) -> list[str]:
        """The folders directly in a folder."""
        return [d for d in self._folders_under(folder) if "/" not in d[len(folder) + 1 if folder else 0:]]

    def glob(self, pat: str) -> set[str]:
        """The files a glob names, matched one part of the path at a time as the shell matches it: `*`, `?` and
        `[...]` within one name, `**` alone as a part for any number of folders. Each result is kept, since a command
        and the commands after it repeat their words."""
        got = self._globs.get(pat)
        if got is None:
            got = self._globs[pat] = self._glob(pat)
        return got

    def _glob(self, pat: str) -> set[str]:
        here = [""]  # the folders the parts so far name
        parts = pat.split("/")
        for k, part in enumerate(parts):
            last = k == len(parts) - 1
            wild = re.search(r"[*?\[]", part)
            if part == "**" and last:
                return {f for d in here for f in self.under(d)}
            if part == "**" and k == len(parts) - 2:
                # `**/name`: the name is matched against the files under these folders that end as it ends, of the
                # extensions that can end so (`*.json` tries the .json files, `x*2` none of the .png files)
                rx, end = _glob_rx(parts[-1]), re.split(r"[*?\]]", parts[-1])[-1]
                low = end.lower()
                return {f for e, fs in self.by_ext.items() if not e or e.endswith(low) or low.endswith(e)
                        for f in fs if f.endswith(end) and rx.match(f, f.rfind("/") + 1)
                        and any(not d or f.startswith(d + "/") for d in here)}
            if part == "**":
                here = sorted({*here, *(d2 for d in here for d2 in self._folders_under(d))})
            elif not wild:
                paths = [f"{d}/{part}" if d else part for d in here]
                if last:
                    return {p for p in paths if p in self.set}
                here = [p for p in paths if p in self.folders]
            elif last:
                rx = _glob_rx(part)
                return {f for d in here for f in self._files_in(d, part[:wild.start()]) if rx.match(f, f.rfind("/") + 1)}
            else:
                rx = _glob_rx(part)
                here = [d2 for d in here for d2 in self._folders_in(d) if rx.match(d2, d2.rfind("/") + 1)]
        return set()


def as_known(known: "Known | Iterable[str]") -> Known:
    return known if isinstance(known, Known) else Known(sorted(set(known)))


def named(text: str, known: "Known | Iterable[str]", root: str, cwd: str | None = None,
          values: dict[str, list[str]] | None = None) -> set[str]:
    """The source files a command's words name, by path, folder or glob. A path resolves from the command's folder
    first, so `cat x.csv` names that folder's x.csv and not every x.csv under the root, and `*` stays within one folder;
    a path that does not resolve matches by its end, as after a `cd`. A shell variable takes the values the command
    gave it (`values`), else stands for one folder or name."""
    root = root.rstrip("/")
    K = as_known(known)
    if not cwd:
        here = "."
    elif cwd == root or cwd.startswith(root + "/") or root.startswith(cwd.rstrip("/") + "/"):
        here = os.path.relpath(cwd, root)
    else:
        here = "\0"  # a folder beside the root: its paths resolve only by their end
    hit: set[str] = set()
    tokens: set[str] = set()
    # a heredoc's body is not shell (no `values`): a `$` in it only ends a word
    for t in (_TOKEN if values is None else _SHELL_TOKEN).findall(text):
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
            hit |= K.glob(rel) or K.glob("**/" + re.sub(r"^(?:\./)+", "", t))
        elif "." in t or "/" in t:
            if rel in K.set:
                hit.add(rel)
                continue
            folder_word = t.endswith("/") or "." not in Path(t).name
            if folder_word:
                under = K.under(rel)
                if under:
                    hit.update(under)
                    continue
            tt = t.rstrip("/")
            # a path that resolves by its end, as after a `cd`: a file whose path ends with the word, or a word that
            # ends with the file's path; and for a folder's word, every file under a folder whose path ends with it
            hit |= K.ending(tt)
            if folder_word:
                for d in K.folders:
                    if d == tt or d.endswith("/" + tt):
                        hit.update(K.under(d))
    return hit


# ------------------------------------------------------------------ a whole command


def shows(cmd: str, known: "Known | Iterable[str]", root: str, cwd: str | None,
          lines_of: Callable[[str], int]) -> list[tuple[str, str, tuple[int, int] | None, str]]:
    """What the command put in front of Claude of each source file it names: (file, how, (first, last), program), how
    being "read" with the lines it printed, "searched" or "named". The `thimble` command keeps its own record, so its
    stages and heredocs are left out here."""
    out: list[tuple[str, str, tuple[int, int] | None, str]] = []
    known = as_known(known)
    values = variables(cmd)
    for pipe in pipelines(cmd):
        sent = not pipe[-1]["out"]
        for k, st in enumerate(pipe):
            prog, args = program(st["words"])
            if prog == "cd" and args and args[0] != "-":
                cwd = os.path.normpath(os.path.join(cwd or root, os.path.expanduser(args[0])))
                continue
            if prog == "thimble":
                continue
            for body in st["bodies"]:
                code = "computed" if COMPUTES.match(prog or "") else "named"
                out.extend((f, code, None, prog or "a heredoc") for f in sorted(named(body, known, root, None)))
            files = named(" ".join(search_operands(args) if prog in SEARCHES else args), known, root, cwd, values) if prog else set()
            if not files:
                continue
            how, rng = stage_shows(prog, args)
            narrow: list[Range] = [rng] if rng else []
            by = prog  # the program that decided what reached Claude
            for later in pipe[k + 1:]:
                if how in ("named", "computed"):
                    break
                p2, a2 = program(later["words"])
                if p2 in SEARCHES:
                    how, by = ("named" if counts_only(a2) else "searched"), p2
                elif p2 in ("head", "tail", "sed") and how == "read":
                    how, r2 = stage_shows(p2, a2)
                    narrow += [r2] if r2 else []
                    by = by if how == "read" else p2
                elif p2 not in PASSES or (p2 == "uniq" and any(a in ("-c", "--count") for a in a2)):
                    how, by = "named", p2 or "a pipe"
            if not sent and how in ("read", "searched"):
                how, by = "named", f"{prog} > a file"  # its output went to a file
            for f in sorted(files):
                if how != "read":
                    out.append((f, how, None, by))
                    continue
                a, b = 1, lines_of(f) or 10 ** 9
                for r in narrow:
                    a, b = r(a, b)
                out.append((f, "read", (a, b), by) if a <= b else (f, "named", None, by))
    return out
