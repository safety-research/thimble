"""Runs a viewer's reader.py under thimble's reader contract (backend/app/view_host.py), without thimble.

A viewer is a folder with view.json (`scope`: globs of the files it claims, matched as thimble matches them) and
reader.py: build_index(paths) -> index, records(index, query) -> JSON, resolve(index, locator) -> {excerpt, label,
refs, key?, target?} or None, and optionally problems(index), hidden(index), unplaced(index). The reader imports
`thimble` for labels; this file provides that module (marked, kept, kept_unit, view_labels, progress) with the labels
of the viewer's labels.json, regex labels read line by line as thimble applies them.

    python3 viewhost.py <viewer> <op> [arg] [--root DIR] [--labels JSON] [--defs FILE] [--cache DIR] [--out FILE]

    op        files | index | records | resolve | problems | shown | rows
    arg       records: the query as JSON; resolve: <path>#L<n>, view:<slug>/<key>, a bare key, or a locator as JSON
    --root    the corpus the scope is relative to (default: the current folder)
    --labels  which labels are on and the filter: {"on": [name | {label, values}], "filter": {label, value} | null}
    --defs    the label definitions (default: <viewer>/labels.json): [{name, kind: regex, spec, labels, paths}]
    --cache   a folder for the index's pickle, kept while the reader and the claimed files are unchanged
    --out     rows: write rows.json there (views/SPEC.md) and print a summary in place of the rows

`rows` is the runner of the mod's terminal views: records(index, {"op": "rows"}), the reader's problems, hidden and
unplaced, the number of files read, and each label of labels.json with its value on every row's ref.

Prints one JSON object: {ok: true, result, ms} or {ok: false, error, traceback}.
"""
from __future__ import annotations

import builtins
import csv
import fnmatch
import hashlib
import importlib.util
import io
import json
import os
import pickle
import re
import sys
import time
import traceback
import types

# thimble's label colours (kernel_thimble.LABEL_COLOURS): 0 is the grey of a negative value, 1..12 the labels' own
LABEL_COLOURS = ["#a09c93", "#025ac3", "#d0750a", "#08632f", "#1392d4", "#897301", "#009c85", "#844500", "#013c77",
                 "#2aa02b", "#025a7c", "#622b01", "#0389a0"]
SHOWN_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp3", ".wav", ".mp4", ".mov", ".webm", ".pdf")
SKIP_SUFFIXES = ("-wal", "-shm", "-journal")  # sqlite side files, which no view claims (views.VIEW_SKIP)
PROBLEMS_SHOWN = 20  # problems the summary lists beside their count (views.PROBLEMS_SHOWN)


# ------------------------------------------------------------------------------------------------ the claimed files


def _glob_forms(pattern: str) -> tuple:
    bare = re.sub(r"(^|/)\*\*/", r"\1", pattern)
    return (pattern,) if bare == pattern else (pattern, bare)


def glob_matches(rel: str, pattern: str) -> bool:
    """views.glob_matches: the pattern against the path and its basename; `*` crosses folders, `**/` may be none."""
    if not pattern or pattern == "*":
        return True
    name = rel.rsplit("/", 1)[-1]
    return any(fnmatch.fnmatchcase(rel, p) or fnmatch.fnmatchcase(name, p) for p in _glob_forms(pattern))


def corpus_files(root: str) -> list:
    out = []
    for d, dirs, files in os.walk(root, followlinks=True):
        dirs[:] = sorted(x for x in dirs if not x.startswith("."))
        for f in files:
            if not f.startswith(".") and not f.endswith(SKIP_SUFFIXES):
                out.append(os.path.relpath(os.path.join(d, f), root).replace(os.sep, "/"))
    return sorted(out)


def claimed(root: str, scope: list) -> list:
    return [p for p in corpus_files(root) if any(glob_matches(p, g) for g in scope)]


# ------------------------------------------------------------------------------------------------ bytes read


class _Counted(io.FileIO):
    """A claimed file opened for reading, which records the byte ranges its reads returned."""

    def _note(self, start: int, n: int) -> None:
        if n:
            self.spans.append((start, start + n))

    def readinto(self, b):  # type: ignore[override]
        start = self.tell()
        n = super().readinto(b)
        self._note(start, n or 0)
        return n

    def read(self, size: int = -1):  # type: ignore[override]
        start = self.tell()
        data = super().read(size)
        self._note(start, len(data or b""))
        return data

    def readall(self):  # type: ignore[override]
        start = self.tell()
        data = super().readall()
        self._note(start, len(data or b""))
        return data


class _Reads:
    """While active, open() of a claimed file for reading goes through _Counted; counts() gives each file's bytes read,
    each byte once. A file read by other means (os.open, mmap, C code) counts as unread, as in thimble."""

    def __init__(self, paths: list) -> None:
        self.claimed = {os.path.realpath(p): p for p in paths}
        self.files: list = []
        self._open = builtins.open

    def open(self, file, mode="r", buffering=-1, encoding=None, errors=None, newline=None, closefd=True, opener=None):
        real = None
        if opener is None and isinstance(file, (str, bytes, os.PathLike)) and "r" in mode and set(mode) <= set("rbt"):
            real = os.path.realpath(os.fsdecode(file))
        if real not in self.claimed:
            return self._open(file, mode, buffering, encoding, errors, newline, closefd, opener)
        raw = _Counted(file, "r")
        raw.spans = []
        self.files.append((self.claimed[real], raw))
        top = io.BufferedReader(raw, buffering if buffering > 1 else io.DEFAULT_BUFFER_SIZE) if buffering != 0 else raw
        return top if "b" in mode else io.TextIOWrapper(top, encoding, errors, newline)

    def counts(self) -> dict:
        spans: dict = {}
        for path, raw in self.files:
            spans.setdefault(path, []).extend(raw.spans)
        out = {}
        for path in self.claimed.values():
            total, end = 0, -1
            for a, z in sorted(spans.get(path, [])):
                if z > end:
                    total += z - max(a, end)
                    end = z
            out[path] = total
        return out

    def __enter__(self):
        builtins.open = io.open = self.open
        return self

    def __exit__(self, *exc) -> None:
        builtins.open = io.open = self._open


# ------------------------------------------------------------------------------------------------ the thimble module


class Labels:
    """The labels context the `thimble` module reads: the definitions (regex labels over lines, as labels.json gives
    them), which are on with the values they highlight, and the filter."""

    def __init__(self, defs: list, root: str, state: dict | None) -> None:
        state = state or {}
        self.root = root
        self.defs = {}
        for d in defs:
            # a label the mod's label tool made keeps each record's value (`rows`), whatever its kind, and a record
            # it did not reach (a trial's) has none; another regex label is read line by line
            table = self._table(root, d.get("rows")) if d.get("rows") else None
            if table is None and d.get("kind", "regex") != "regex":
                continue
            i = len(self.defs)
            values = list(d.get("labels") or ["yes", "no"])
            self.defs[d["name"]] = {"name": d["name"], "rx": re.compile(d["spec"]) if table is None else None, "table": table,
                                    "values": values, "paths": list(d.get("paths") or ["*"]),
                                    "colour": LABEL_COLOURS[1 + i % (len(LABEL_COLOURS) - 1)]}
        self.on = []  # [(def, highlighted values)]
        for x in state.get("on") or []:
            name, vals = (x, None) if isinstance(x, str) else (x.get("label"), x.get("values"))
            if name in self.defs:
                d = self.defs[name]
                self.on.append((d, list(vals) if vals else d["values"][:1]))
        f = state.get("filter")
        self.filter = f if f and f.get("label") in self.defs else None
        self._lines: dict = {}

    @staticmethod
    def _table(root: str, rows: str):
        """{ref: value} of a label's rows file (helper/labels.py), None when it does not read."""
        try:
            with io.open(os.path.join(root, rows), encoding="utf-8") as fh:
                got = json.load(fh).get("rows") or {}
            return {str(ref): str(r.get("value")) for ref, r in got.items() if isinstance(r, dict)}
        except (OSError, ValueError, AttributeError):
            return None

    def _line(self, path: str, n: int):
        """The text of the record that starts on line n: the line, or a CSV row whole when a quoted cell runs on."""
        got = self._lines.get(path)
        if got is None:
            try:
                with io.open(os.path.join(self.root, path), "rb") as fh:
                    lines = fh.read().decode("utf-8", "replace").splitlines()
            except OSError:
                lines = []
            rows = {}
            if path.lower().endswith(".csv"):
                rd, start = csv.reader(io.StringIO("\n".join(lines))), 1
                try:
                    for _ in rd:
                        rows[start] = "\n".join(lines[start - 1:rd.line_num])
                        start = rd.line_num + 1
                except csv.Error:
                    pass
            got = self._lines[path] = (lines, rows)
        lines, rows = got
        return rows.get(n) or (lines[n - 1] if 0 < n <= len(lines) else None)

    @staticmethod
    def parts(ref: str):
        path, _, frag = str(ref).partition("#")
        m = re.match(r"L(\d+)", frag)
        return path, int(m.group(1)) if m else None

    def ran_over(self, d: dict, path: str) -> bool:
        return any(glob_matches(path, g) for g in d["paths"])

    def value(self, d: dict, ref: str):
        """The label's value on the record `ref` (its first line), None where the label did not run."""
        path, n = self.parts(ref)
        if d.get("table") is not None:
            if not self.ran_over(d, path):
                return None
            return d["table"].get(f"{path}#L{n}" if n is not None else str(ref).split("-L")[0])
        if n is None or not self.ran_over(d, path):
            return None
        text = self._line(path, n)
        if text is None:
            return None
        return d["values"][0] if d["rx"].search(text) else d["values"][-1]

    def view_labels(self) -> dict:
        def colour(d, v):
            return d["colour"] if d["values"].index(v) == 0 else LABEL_COLOURS[0]
        labels = [{"id": d["name"], "name": d["name"], "colour": d["colour"],
                   "values": [{"name": v, "colour": colour(d, v)} for v in vals if v in d["values"]]}
                  for d, vals in self.on]
        f = self.filter
        fd = self.defs[f["label"]] if f else None
        return {"labels": labels, "filter": {"label": f["label"], "value": f.get("value") or fd["values"][0],
                                             "colour": fd["colour"]} if f else None}

    def marked(self, ref) -> list:
        out = []
        for d, vals in self.on:
            v = self.value(d, str(ref))
            if v in vals:
                out.append({"label": d["name"], "value": v,
                            "colour": d["colour"] if d["values"].index(v) == 0 else LABEL_COLOURS[0]})
        return out

    def kept(self, ref) -> bool:
        if not self.filter:
            return True
        d = self.defs[self.filter["label"]]
        path, _ = self.parts(str(ref))
        if not self.ran_over(d, path):
            return True
        return self.value(d, str(ref)) == (self.filter.get("value") or d["values"][0])

    def kept_unit(self, refs) -> bool:
        if not self.filter:
            return True
        refs = [str(r) for r in refs]
        if not refs:
            return False
        d = self.defs[self.filter["label"]]
        ran = [r for r in refs if self.ran_over(d, self.parts(r)[0])]
        return not ran or any(self.kept(r) for r in ran)


def thimble_module(labels: Labels | None) -> types.ModuleType:
    """The `thimble` a reader imports, as kernel_thimble gives it inside a view's call."""
    mod = sys.modules.get("thimble")
    if mod is None or not getattr(mod, "_viewhost", False):
        mod = types.ModuleType("thimble")
        mod._viewhost = True
        sys.modules["thimble"] = mod
    none = Labels([], ".", None)
    ctx = labels or none
    mod.marked = ctx.marked
    mod.kept = ctx.kept
    mod.kept_unit = ctx.kept_unit
    mod.view_labels = ctx.view_labels
    mod.progress = lambda done=None, total=None, note=None: None
    return mod


# ------------------------------------------------------------------------------------------------ the host


class Viewer:
    def __init__(self, folder: str, root: str = ".", defs: str | None = None, cache: str | None = None) -> None:
        self.folder = os.path.abspath(folder)
        self.slug = os.path.basename(self.folder.rstrip("/"))
        self.root = os.path.abspath(root)
        with open(os.path.join(self.folder, "view.json"), encoding="utf-8") as f:
            self.view = json.load(f)
        self.scope = list(self.view.get("scope") or self.view.get("claims") or [])
        defs = defs or os.path.join(self.folder, "labels.json")
        self.defs = json.load(open(defs, encoding="utf-8")) if os.path.isfile(defs) else []
        self.cache = cache
        self.paths = claimed(self.root, self.scope)
        self._mod = None
        self._index = None
        self.reads: dict = {}

    def _reader(self):
        if self._mod is None:
            name = "thimble_view_" + self.slug.replace("-", "_")
            spec = importlib.util.spec_from_file_location(name, os.path.join(self.folder, "reader.py"))
            mod = importlib.util.module_from_spec(spec)
            sys.modules[name] = mod
            thimble_module(None)
            spec.loader.exec_module(mod)
            for fn in ("build_index", "records", "resolve"):
                if not callable(getattr(mod, fn, None)):
                    raise AttributeError(f"reader.py defines no function {fn}()")
            self._mod = mod
        return self._mod

    def _fingerprint(self) -> str:
        h = hashlib.sha1()
        for p in [os.path.join(self.folder, "reader.py")] + [os.path.join(self.root, p) for p in self.paths]:
            st = os.stat(p)
            h.update(f"{p}\0{st.st_size}\0{st.st_mtime_ns}\0".encode())
        return h.hexdigest()[:16]

    def index(self):
        if self._index is not None:
            return self._index
        mod = self._reader()
        pkl = None
        if self.cache:
            os.makedirs(self.cache, exist_ok=True)
            pkl = os.path.join(self.cache, f"{self.slug}-{self._fingerprint()}.pkl")
            if os.path.isfile(pkl):
                with open(pkl, "rb") as f:
                    self._index, self.reads = pickle.load(f)
                return self._index
        here = os.getcwd()
        os.chdir(self.root)
        try:
            parsed = [p for p in self.paths if not p.lower().endswith(SHOWN_SUFFIXES)]
            with _Reads(parsed) as reads:
                self._index = mod.build_index(list(self.paths))
            self.reads = reads.counts()
        finally:
            os.chdir(here)
        if pkl:
            for old in os.listdir(self.cache):
                if old.startswith(self.slug + "-") and old.endswith(".pkl"):
                    os.remove(os.path.join(self.cache, old))
            with open(pkl, "wb") as f:
                pickle.dump((self._index, self.reads), f)
        return self._index

    def _call(self, fn, *args, labels: dict | None = None):
        idx = self.index()
        here = os.getcwd()
        os.chdir(self.root)
        try:
            thimble_module(Labels(self.defs, self.root, labels) if labels else None)
            return fn(idx, *args)
        finally:
            thimble_module(None)
            os.chdir(here)

    def records(self, query=None, labels: dict | None = None):
        return self._call(self._reader().records, query or {}, labels=labels)

    def resolve(self, locator):
        return self._call(self._reader().resolve, locator_of(locator, self.slug))

    def _optional(self, name: str):
        fn = getattr(self._reader(), name, None)
        return self._call(fn) if callable(fn) else []

    def problems(self) -> list:
        got = self._optional("problems")
        return got.get("examples", []) if isinstance(got, dict) else list(got or [])

    def shown(self) -> dict:
        """What thimble draws above a view: the files, those not read to the end, the reader's problems and hidden
        files, and the fields view.json says it made rather than read."""
        self.index()
        sizes = {p: os.path.getsize(os.path.join(self.root, p)) for p in self.paths}
        hidden = self._optional("hidden")
        hid = {h.get("path") for h in hidden}
        unread = [p for p in self.paths if not p.lower().endswith(SHOWN_SUFFIXES) and p not in hid
                  and self.reads.get(p, 0) < sizes[p]]
        probs = self.problems()
        kinds = self.view.get("collections") or self.view.get("records") or []  # the mod's spec, or thimble's view.json
        derived = [{"record": r.get("name"), "field": f.get("name"), "derived": f.get("derived"), "from": f.get("from"),
                    "how": f.get("how")} for r in kinds for f in r.get("fields") or [] if f.get("derived")]
        return {"files": len(self.paths), "bytes": sum(sizes.values()), "unread": unread, "hidden": hidden,
                "missing": [g for g in self.scope if not any(glob_matches(p, g) for p in self.paths)],
                "problems": {"count": len(probs), "examples": probs[:PROBLEMS_SHOWN]},
                "unplaced": self._optional("unplaced"), "derived": derived}


    def rows(self) -> dict:
        """rows.json of a terminal view (views/SPEC.md): every row the reader gives for {"op": "rows"}, what it could
        not read or place, and each label's value on every row's ref where the label runs over the row's file, and on
        every unit, a row whose `refs` list the records it gathers."""
        got = self.records({"op": "rows"})
        if not isinstance(got, dict) or not isinstance(got.get("collections"), dict):
            raise ValueError('records(index, {"op": "rows"}) gave no {"collections": {...}}')
        labels = label_marks(self.defs, self.root, got["collections"], self.view)
        return {"collections": got["collections"], "problems": self.problems(), "hidden": self._optional("hidden"),
                "unplaced": self._optional("unplaced"), "files": len(self.paths), "labels": labels}



def label_marks(defs: list, root: str, collections: dict, view: dict) -> list:
    """rows.json's labels: each label's value on every row's ref where the label runs over the row's file, and on
    every unit, a row whose `refs` list the records it gathers."""
    ctx = Labels(defs, root, None)
    by = {c.get("name"): c.get("ref") or "ref" for c in view.get("collections") or []}
    refs = list(dict.fromkeys(str(r[by.get(name, "ref")]) for name, rows in collections.items() for r in rows
                              if isinstance(r, dict) and r.get(by.get(name, "ref"))))
    # a unit (a row listing the refs it gathers) takes the label's first value when any of its records has it, as
    # thimble's kept_unit keeps a unit
    keys = {c.get("name"): c.get("key") for c in view.get("collections") or []}
    units = [(f"{name}/{r.get(keys.get(name) or 'key')}", [str(x) for x in r["refs"]])
             for name, rows in collections.items() for r in rows
             if isinstance(r, dict) and isinstance(r.get("refs"), list)]
    labels = []
    for d in ctx.defs.values():
        marks = {ref: v for ref in refs if (v := ctx.value(d, ref)) is not None}
        unit_marks = {}
        for key, rs in units:
            got_vals = [v for x in rs if (v := marks.get(x, ctx.value(d, x))) is not None]
            if got_vals:
                unit_marks[key] = d["values"][0] if d["values"][0] in got_vals else got_vals[0]
        labels.append({"id": d["name"], "name": d["name"], "values": d["values"], "marks": marks, "units": unit_marks,
                       "colours": {d["values"][0]: d["colour"], d["values"][-1]: LABEL_COLOURS[0]}})
    return labels

def locator_of(x, slug: str = "") -> dict:
    """A locator as resolve() takes it: {path, fragment} for `<path>#<fragment>`, {key} for `view:<slug>/<key>` or a
    bare key, or the dict given."""
    if isinstance(x, dict):
        return x
    s = str(x)
    if s.startswith("view:"):
        return {"key": s[5:].split("/", 1)[1] if "/" in s[5:] else ""}
    if "#" in s:
        path, frag = s.split("#", 1)
        return {"path": path, "fragment": frag}
    return {"key": s}


def main(argv: list) -> int:
    args, opts = [], {}
    it = iter(argv)
    for a in it:
        if a.startswith("--"):
            opts[a[2:]] = next(it, "")
        else:
            args.append(a)
    if len(args) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    folder, op, arg = args[0], args[1], (args[2] if len(args) > 2 else None)
    t0 = time.monotonic()
    try:
        v = Viewer(folder, opts.get("root", "."), opts.get("defs"), opts.get("cache"))
        labels = json.loads(opts["labels"]) if opts.get("labels") else None
        if op == "files":
            result = v.paths
        elif op == "index":
            v.index()
            result = v.shown()
        elif op == "records":
            result = v.records(json.loads(arg) if arg else {}, labels)
        elif op == "resolve":
            result = v.resolve(json.loads(arg) if arg and arg.startswith("{") else arg)
        elif op == "problems":
            result = v.problems()
        elif op == "shown":
            result = v.shown()
        elif op == "rows":
            result = v.rows()
            if opts.get("out"):
                with open(opts["out"], "w", encoding="utf-8") as f:
                    json.dump(result, f, ensure_ascii=False, indent=1)
                    f.write("\n")
                result = {"out": opts["out"], "files": result["files"], "problems": len(result["problems"]),
                          "rows": {k: len(x) for k, x in result["collections"].items()},
                          "labels": {lab["name"]: sum(v == lab["values"][0] for v in lab["marks"].values())
                                     for lab in result["labels"]}}
        else:
            raise ValueError(f"unknown operation {op!r}")
        out = {"ok": True, "result": result, "ms": round((time.monotonic() - t0) * 1000)}
    except Exception as e:  # noqa: BLE001 — a reader's failure is the answer
        out = {"ok": False, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()[-3000:]}
    print(json.dumps(out, ensure_ascii=False, default=str))
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
