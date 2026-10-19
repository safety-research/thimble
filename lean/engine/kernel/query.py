"""Queries: Python that Claude runs over the sources like a notebook cell, kept with its code, inputs and output, and
with the source rows behind each row of its output.

    lean q "what it answers" <<'PY'
    ...
    PY

The code runs in the folder; its last expression (or a variable named `result`) is its output. Its namespace (copied
from thimble-lite's query kernel and extended):

    load(glob, fields=None)     a pandas DataFrame, one row per source row, with `_ref` (its stable id) and `_file`;
                                "x.db#table" (or table="table") reads one table of a database
    rows(glob)                  (ref, row) pairs one at a time, for files too large to load
    tally(df, by=None, **aggs)  a groupby that keeps each group's rows: columns `n` and `_refs`
    sample(df, n=3, seed=0)     n rows at random
    keep(name, obj) / use(name) pass a result to a later query, which records the name and the query that kept it.
                                A label is this: a query that gives rows a value (by a rule in code, or values Claude
                                wrote after reading the rows) and keeps it; each keep is a new version, and every value
                                built on it names the version it used
    use("q3")                   an earlier query's output, as the table it showed, with `_refs` (each row's source
                                rows) when it kept them: build on it without running it again
    pd, np, re, json, Counter, ROOT

Row lineage of the output (the last expression, or `result`), by how sure it is:

    exact      the output has `_ref` (one source row per output row) or `_refs` (a list); tally() gives `_refs`
    matched    found by key: the output's key columns (its index, or its text columns) select rows of a frame the
               query made, and a count column of the output equals the number of rows for every output row
    key        found by key, but no column of the output counts rows, so the match could not be checked
    superset   found by key, and a count column disagrees: the rows hold more than the value counted
    loop       records built in a loop (`out.append({...})`, then a table of them): each output row rests on the rows
               its own iteration held when it appended the record (what it loaded and filtered for it); a count that
               equals the rows of one of those frames opens that frame's rows (`cells`)
    query      no row lineage: each value rests on every row the query read
"""
from __future__ import annotations

import ast
import contextlib
import hashlib
import io
import json
import math
import os
import re
import sys
import time
import traceback
import weakref
import zlib
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import quote

from . import refs as R
from . import sources as S
from .store import Store, pack_record, pickle_path, prune_cache, read_pickle, thimble_home, unpack_record, write_pickle

CUT = 12000  # characters of a query's printed output Claude reads
SHOW = 3000  # characters of the result (the last expression) shown when it is a long table; the query keeps it all
TABLE_MAX = 5000  # rows of an output table kept
RESULT_BYTES = 50_000_000  # a result table up to this size in memory is kept whole for use("q3")
SUMMARY_MAX = 40  # a dict of up to this many values reads as a summary: each value rests on the rows the query read


def slug(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "-", name.strip()).strip("-").lower() or "kept"


def next_id(st: Store) -> tuple[str, Path]:
    """A new query id, claimed by creating its file, so two queries run at once never share one."""
    d = st.sub("queries")
    n = max([int(p.stem[1:]) for p in d.glob("q*.json") if p.stem[1:].isdigit()], default=0) + 1
    while True:
        p = d / f"q{n}.json"
        try:
            fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            os.write(fd, b'{"running": true}\n')
            os.close(fd)
            return f"q{n}", p
        except FileExistsError:
            n += 1


def get(st: Store, qid: str) -> dict[str, Any] | None:
    """A query's record, its row lineage unpacked (store.pack_record)."""
    q = st.read_json(st.dir / "queries" / f"{qid}.json")
    if not q or q.get("running"):
        return None
    try:
        return unpack_record(q)
    except (KeyError, IndexError, TypeError, ValueError, zlib.error) as e:
        # a packed lineage that does not read: the record without it, so its output still shows, and a resolve says why
        # it has no rows and how to get them back
        out = {k: v for k, v in q.items() if k != "packed"}
        out["unreadable"] = (f"{qid}'s record keeps its rows packed, and they did not read ({type(e).__name__}): "
                             f"`lean q --rerun {qid}` runs it again and keeps them")
        return out


# ------------------------------------------------------------------ the namespace


CACHE_MIN = 200_000  # bytes: a source file bigger than this keeps its parsed frame in the cache
PARALLEL_MIN = 64_000_000  # bytes of files not yet in the cache: a load over this parses them in worker processes
PARALLEL_MAX = 8  # worker processes at most


def _frame_cache(st: Store, rel: str):
    """Where one source file's parsed frame is kept: its columns one after another in one file (frames2/<key>.cols),
    with an index of where each starts, so a load that names its fields reads only those columns."""
    p = st.root / rel
    s = p.stat()
    key = hashlib.sha1(f"{rel}:{s.st_size}:{s.st_mtime_ns}".encode()).hexdigest()[:16]
    return st.cache / "frames2" / f"{key}.cols"


def _save_frame(cp: Path | str, df) -> None:
    """A frame into the cache by columns: each column pickled after the one before, then the index of their places
    (`<file>.json`) written last, so a frame without its index is never read. Both written whole, then renamed."""
    import pickle

    cp = Path(cp)
    cp.parent.mkdir(parents=True, exist_ok=True)
    tmp = cp.with_name(f"{cp.name}.{os.getpid()}.tmp")
    cols, at = [], 0
    with open(tmp, "wb") as f:
        for c in df.columns:
            b = pickle.dumps(df[c], protocol=pickle.HIGHEST_PROTOCOL)
            f.write(b)
            cols.append({"name": c, "at": at, "len": len(b)})
            at += len(b)
    os.replace(tmp, cp)
    idx = cp.with_suffix(".json")
    tmpi = idx.with_name(f"{idx.name}.{os.getpid()}.tmp")
    tmpi.write_text(json.dumps({"rows": int(len(df)), "cols": cols}))
    os.replace(tmpi, idx)


def _load_frame(cp: Path, fields: list[str] | None):
    """A cached frame: every column, or with `fields` only `_ref`, `_file` and those, in the frame's own order. None
    when it is not in the cache (or cannot be read)."""
    import pickle

    import pandas as pd

    idx = cp.with_suffix(".json")
    if not idx.exists() or not cp.exists():
        return None
    try:
        meta = json.loads(idx.read_text())
        want = None if fields is None else {"_ref", "_file", *fields}
        parts = {}
        with open(cp, "rb") as f:
            for c in meta["cols"]:
                if want is not None and c["name"] not in want:
                    continue
                f.seek(c["at"])
                parts[c["name"]] = pickle.loads(f.read(c["len"]))
        df = pd.DataFrame(parts) if parts else pd.DataFrame(index=pd.RangeIndex(meta["rows"]))
        if len(df) != meta["rows"]:
            return None
    except Exception:  # noqa: BLE001 — a cache that does not read is parsed again
        return None
    try:
        # read now: the cache keeps the frames read most recently (store.prune_cache)
        os.utime(idx)
    except OSError:
        pass
    return df


def _parse_frame(root: Path, rel: str, table: str | None):
    """One source file as a frame: each row's value (a record's fields, else its text), with `_ref` and `_file`."""
    import pandas as pd

    recs, refs = [], []
    for row in S.iter_rows(root, rel, table=table):
        v = row.value
        recs.append(v if isinstance(v, dict) else {"text": v})
        refs.append(row.ref)
    df = pd.DataFrame.from_records(recs) if recs else pd.DataFrame()
    df.insert(0, "_ref", refs)
    df.insert(1, "_file", rel)
    return df


def _cache_frame(args: tuple[str, str, str]) -> str | None:
    """A worker's part of a parallel load: one file parsed and its frame written to the cache (written whole, then
    renamed, so no reader sees half of it). Returns an error in words, or None."""
    root, rel, cp = args
    try:
        _save_frame(cp, _parse_frame(Path(root), rel, None))
        return None
    except Exception as e:  # noqa: BLE001 — the parent parses the file itself then
        return f"{type(e).__name__}: {e}"


def _warm_cache(st: Store, files: list[str], info: dict[str, Any] | None = None) -> None:
    """Before a load reads many big files that are not in the cache yet, parse them in worker processes, a few at a
    time, so a corpus of gigabytes is read once in a fraction of the time. Only where processes fork cheaply (Linux); a
    file a worker could not parse is parsed by the load itself, as before."""
    if not sys.platform.startswith("linux"):
        return
    todo = []
    for rel in files:
        try:
            size = (st.root / rel).stat().st_size
            cp = _frame_cache(st, rel)
        except OSError:
            continue
        if size > CACHE_MIN and not cp.with_suffix(".json").exists():
            todo.append((size, rel, cp))
    if len(todo) < 2 or sum(x[0] for x in todo) < PARALLEL_MIN:
        return
    st.cache_dir()
    import multiprocessing as mp
    from concurrent.futures import ProcessPoolExecutor

    n = max(1, min(PARALLEL_MAX, (os.cpu_count() or 2) - 1, len(todo)))
    if n < 2:
        return
    # the biggest first, so the last worker does not start on a big file at the end
    todo.sort(key=lambda x: -x[0])
    try:
        with ProcessPoolExecutor(max_workers=n, mp_context=mp.get_context("fork")) as ex:
            list(ex.map(_cache_frame, [(str(st.root), rel, str(cp)) for _, rel, cp in todo], chunksize=1))
        if info is not None:
            info["cached"] = info.get("cached", 0) + len(todo)
    except Exception:  # noqa: BLE001 — the load parses what is missing itself
        pass


def make_namespace(st: Store, info: dict[str, Any]) -> dict[str, Any]:
    import numpy as np
    import pandas as pd

    pd.set_option("display.width", 160)
    pd.set_option("display.max_columns", 14)
    pd.set_option("display.max_colwidth", 60)
    pd.set_option("display.max_rows", 60)

    def load(pattern: str, fields: list[str] | None = None, table: str | None = None) -> "pd.DataFrame":
        """Every row of the files a path or glob names, with `_ref` (cite it) and `_file`. `x.db#table` (or
        table="name") reads one table of a database."""
        if "#" in pattern:
            pattern, table = pattern.split("#", 1)
        files = S.expand_glob(st.root, pattern)
        if not files:
            raise FileNotFoundError(f"no source file matches {pattern!r} under {st.root}")
        if not table:
            _warm_cache(st, files, info)
        frames = []
        for rel in files:
            cp = _frame_cache(st, rel) if not table else None
            # a load that names its fields reads only those columns of a cached frame
            df = _load_frame(cp, list(fields) if fields else None) if cp is not None else None
            if df is None:
                df = _parse_frame(st.root, rel, table)
                if cp is not None and (st.root / rel).stat().st_size > CACHE_MIN:
                    try:
                        st.cache_dir()
                        _save_frame(cp, df)
                        info["cached"] = info.get("cached", 0) + 1
                    except Exception:  # noqa: BLE001
                        pass
            if fields:
                df = df[[c for c in ["_ref", "_file", *fields] if c in df.columns]]
            info["loads"].append({"path": rel, "rows": int(len(df)), "table": table})
            frames.append(df)
        out = pd.concat(frames, ignore_index=True) if len(frames) > 1 else frames[0]
        info["frames"].append(out)
        return out

    def rows(pattern: str):
        """(ref, row) for each row of the files a path or glob names, one at a time."""
        for rel in S.expand_glob(st.root, pattern):
            n = 0
            for row in S.iter_rows(st.root, rel):
                n += 1
                yield row.ref, row.value
            info["loads"].append({"path": rel, "rows": n, "table": None, "via": "rows"})

    def tally(df: "pd.DataFrame", by: Any = None, **aggs: Any) -> "pd.DataFrame":
        """Groups of rows with their count `n`, any named aggregations (words=('body_len', 'sum')), and `_refs`, the
        rows of each group, so every value of the output keeps its rows exactly. With no `by`, one row for all."""
        # a frame of source rows has `_ref`; a used query's output has `_refs`, each row's own source rows; a merge of
        # two such frames has both sides' (`_ref_x`, `_ref_y`), and a row rests on all of them
        one, many = ref_columns(df)
        if not one and not many:
            raise ValueError("tally() needs a frame of source rows: one from load() or use(), which carries `_ref` or `_refs`")
        if one == ["_ref"] and not many:
            col, rows_of = "_ref", list
        else:
            df = df.assign(__lean_refs=row_ref_lists(df))
            col, rows_of = "__lean_refs", lambda xs: [r for x in xs for r in (x or [])]
        if by is None:
            out = {"n": [len(df)]}
            for k, (c, fn) in aggs.items():
                out[k] = [df[c].agg(fn)]
            out["_refs"] = [rows_of(df[col])]
            return pd.DataFrame(out)
        g = df.groupby(by, dropna=False, sort=True)
        return g.agg(n=(col, "size"), **aggs, _refs=(col, rows_of)).reset_index()

    kept_f = st.dir / "kept.json"

    def keep(name: str, obj: Any) -> Any:
        """Keep a result for a later query (use(name)), with this query as its source."""
        write_pickle(st.sub("kept"), slug(name), obj)
        info["kept"].append(name)
        return obj

    def use(name: str) -> Any:
        reg = st.read_json(kept_f) or {}
        if name not in reg and re.fullmatch(r"q\d+", name):
            return used_output(name)
        if name not in reg:
            raise KeyError(f"nothing kept as {name!r}; kept: {', '.join(reg) or 'nothing'}")
        info["uses"].append({"name": name, "query": reg[name]})
        f = pickle_path(st.dir / "kept", slug(name))
        if f is None:
            raise KeyError(f"{name!r} was kept by {reg[name]}, but its file is gone from thimble/kept: `lean q --rerun {reg[name]}` keeps it again")
        obj = read_pickle(f)
        if isinstance(obj, pd.DataFrame) and "_ref" in obj.columns:
            info["frames"].append(obj)
        return obj

    def used_output(qid: str) -> Any:
        """An earlier query's output, as the table it showed: kept whole when it ran, else rebuilt from its record."""
        q = get(st, qid)
        if q is None:
            raise KeyError(f"no query {qid}")
        if q.get("error"):
            raise ValueError(f"{qid} failed ({q['error']}): it has no output to use")
        info["uses"].append({"name": qid, "query": qid})
        f = pickle_path(st.dir / "results", qid)
        if f is not None:
            df = read_pickle(f)
            if isinstance(df, pd.DataFrame) and df.attrs.get(REFS_FROM_RECORD):
                # the result keeps a note that each row's `_refs` are its rows in the record: expanded here again
                df.attrs = {k: v for k, v in df.attrs.items() if k != REFS_FROM_RECORD}
                df["_refs"] = record_refs(q, len(df))
            info["frames"].append(df)
            return df
        if q.get("table") is None:
            raise ValueError(f"{qid} only printed, so it has no output table: end a query with the table to use it")
        df = pd.DataFrame(q["table"])
        if q.get("rows") is not None and len(q["rows"]) == len(df):
            df["_refs"] = [R.expand(x) for x in q["rows"]]
        if q.get("truncated"):
            print(f"use({qid!r}): its record keeps the first {len(df):,} rows of its output")
        info["frames"].append(df)
        return df

    def sample(df: "pd.DataFrame", n: int = 3, seed: int = 0) -> "pd.DataFrame":
        """n rows chosen at random (not the first n), so examples stand for the group."""
        info["samples"] += 1
        return df.sample(min(n, len(df)), random_state=seed)

    loop = _Records(info)
    return {"pd": pd, "np": np, "json": json, "re": re, "Counter": Counter, "defaultdict": defaultdict,
            "ROOT": st.root, "load": load, "rows": rows, "tally": tally,
            "sample": sample, "keep": keep, "use": use, APPEND: loop.append, "__name__": "__lean_query__"}


# ------------------------------------------------------------------ records built in a loop

APPEND = "__lean_append__"
LOOP_REFS_MAX = 20_000_000  # source rows the loop's records may hold in all; past it they keep none
GROUPS_MAX_ROWS = 200_000  # a frame up to this size has its few-valued columns grouped, for counts named by a value


class _AppendCalls(ast.NodeTransformer):
    """`x.append(v)` in the query's code as `__lean_append__(x, v)`: the same call, which also notes what the code held
    when it appended a record, so a table built from the records keeps each one's rows."""

    def visit_Call(self, node: ast.Call) -> Any:
        self.generic_visit(node)
        f = node.func
        if (isinstance(f, ast.Attribute) and f.attr == "append" and len(node.args) == 1 and not node.keywords
                and not isinstance(node.args[0], ast.Starred)):
            return ast.copy_location(ast.Call(func=ast.Name(APPEND, ast.Load()), args=[f.value, node.args[0]],
                                              keywords=[]), node)
        return node


class _Records:
    """The records a query appends to its lists, each with the frames of source rows the code held then: the frames
    bound in the appending code, and the ones it loaded since the list's previous record. A frame is known by a serial
    while it lives, so one held across the whole loop (the table the loop filters) tells apart from one made for a
    single record."""

    def __init__(self, info: dict[str, Any]) -> None:
        self.info = info
        self.lists: dict[int, dict[str, Any]] = {}
        self.live: dict[int, tuple[Any, int]] = {}
        self.refs: dict[int, tuple[int, Any]] = {}
        # per frame, the rows each value of a column with few values holds ({("state", "merged"): row positions})
        self.groups: dict[int, dict[tuple[str, str], Any]] = {}
        self.total = 0
        self.full = False
        info["records"] = self

    def append(self, obj: Any, x: Any) -> Any:
        r = obj.append(x)
        # a list longer than an output table keeps (TABLE_MAX) is not noted further: its table keeps no rows per row
        if type(obj) is list and not self.full and len(obj) <= TABLE_MAX:
            try:
                self._note(obj, x, sys._getframe(1))
            except Exception:  # noqa: BLE001 — a record the kernel cannot note keeps no rows of its own
                pass
        return r

    def _serial(self, f: Any) -> int | None:
        hit = self.live.get(id(f))
        if hit is not None and hit[0]() is f:
            return hit[1]
        one, many = ref_columns(f)
        if not one and not many:
            return None
        n = len(self.refs) + 1
        if one == ["_ref"] and not many:
            refs = f["_ref"].dropna().astype(str).to_numpy(dtype=object)
        else:
            refs = [r for x in row_ref_lists(f) for r in x]
        self.total += len(refs)
        if self.total > LOOP_REFS_MAX:
            self.full = True
            self.lists.clear()
            self.refs.clear()
            return None
        self.live[id(f)] = (weakref.ref(f), n)
        self.refs[n] = (len(f), refs)
        if one == ["_ref"] and not many and len(refs) == len(f) and len(f) <= GROUPS_MAX_ROWS:
            try:
                self.groups[n] = _value_groups(f)
            except Exception:  # noqa: BLE001 — columns that do not group
                pass
        return n

    def _note(self, obj: list, x: Any, frame: Any) -> None:
        import pandas as pd

        if not isinstance(x, (dict, tuple, list, pd.Series)):
            return
        reg = self.lists.setdefault(id(obj), {"obj": obj, "at": {}, "loads": 0})
        held: set[int] = set()
        frames = self.info["frames"]
        for f in frames[reg["loads"]:]:
            if isinstance(f, pd.DataFrame):
                s = self._serial(f)
                if s:
                    held.add(s)
        reg["loads"] = len(frames)
        scopes = [frame.f_locals]
        if frame.f_globals is not scopes[0]:
            scopes.append(frame.f_globals)
        bound: list[Any] = []
        flags: list[Any] = []
        for scope in scopes:
            for v in list(scope.values()):
                if isinstance(v, pd.DataFrame):
                    s = self._serial(v)
                    if s:
                        held.add(s)
                        bound.append(v)
                elif isinstance(v, pd.Series) and pd.api.types.is_bool_dtype(v) and len(v) <= 1_000_000:
                    flags.append(v)
        if self.full:
            return
        k = len(obj) - 1
        reg["at"][k] = held
        # a yes/no per row of a frame held here (`ok` beside `m`): the rows it marks and the rows it leaves are what a
        # count of either side rests on
        marked: list[tuple[int, list[str]]] = []
        for flag in flags:
            for f in bound:
                if len(f) == len(flag) and f.index.equals(flag.index) and ref_columns(f)[0] == ["_ref"]:
                    yes = flag.fillna(False).to_numpy(dtype=bool)
                    refs = f["_ref"].astype(str).to_numpy(dtype=object)
                    marked.append((int(yes.sum()), refs[yes].tolist()))
                    marked.append((int((~yes).sum()), refs[~yes].tolist()))
                    break
        if marked:
            reg.setdefault("marked", {})[k] = marked

    def lineage(self, result: Any, df: Any, index: list[Any], ns: dict[str, Any]):
        """(rows per output row, cells, the list's name) when the output is a table of one list's records, each found
        by its place in the list (its index, kept through a sort or a filter) or by its values; else None. A cell is
        every count of a row whose own rows the pass held, as the caller keeps only those that differ from the row's."""
        if self.full or not self.lists or not len(df):
            return None
        for reg in sorted(self.lists.values(), key=lambda r: -len(r["at"])):
            places = _record_places(reg["obj"], reg["at"], result, df, index)
            if places is None:
                continue
            got = self._rows(reg, places, df)
            if got is None:
                continue
            name = next((k for k, v in ns.items() if v is reg["obj"] and not k.startswith("_")), None)
            return got[0], got[1], name or "a list"
        return None

    def _rows(self, reg: dict[str, Any], places: list[int], df: Any):
        seen = Counter(s for held in reg["at"].values() for s in held)
        many = len(reg["at"]) > 1
        rows: list[list[str]] = []
        cells: list[dict[str, list[str]]] = []
        deadline = time.time() + 3.0
        for i, k in enumerate(places):
            held = reg["at"].get(k) or set()
            own = sorted(s for s in held if not many or seen[s] == 1) or sorted(held)
            if time.time() > deadline:
                return None
            keep = _narrowest(own, self.refs)
            refs = list(dict.fromkeys(str(r) for s in keep for r in self.refs[s][1]))
            rows.append(R.compress(refs))
            cell: dict[str, list[str]] = {}
            r = df.iloc[i]
            for c in df.columns:
                if not isinstance(c, str) or c.startswith("_"):
                    continue
                v = _count_of(r[c])
                if v is None:
                    continue
                # the rows a count rests on: a frame the pass held of that many rows, the rows a yes/no Series it held
                # marks or leaves, or the rows of a pass frame that hold a value the count is named by (`merged` for
                # state == "merged")
                fits = [list(self.refs[s][1]) for s in own if self.refs[s][0] == v]
                fits += [refs for n, refs in (reg.get("marked") or {}).get(k, []) if n == v]
                named = [self.refs[s][1][pos].tolist() for s in own for (col, val), pos in (self.groups.get(s) or {}).items()
                         if len(pos) == v and _names_value(c, val)]
                got = _one_set(fits + named) or _one_set(named)
                if got is not None:
                    cell[c] = R.compress(list(dict.fromkeys(str(x) for x in got)))
            cells.append(cell)
        if len(rows) > 1 and all(x == rows[0] for x in rows):
            # every record holds the same rows (a loop over a frame's rows one at a time): nothing per row is known
            return None
        if not any(rows):
            return None
        return rows, cells


def _value_groups(f: Any) -> dict[tuple[str, str], Any]:
    """The row positions of each value of a frame's columns that hold few values (a state, a verdict, a kind)."""
    import numpy as np
    import pandas as pd

    out: dict[tuple[str, str], Any] = {}
    cols = [c for c in f.columns if isinstance(c, str) and not c.startswith("_")
            and (pd.api.types.is_object_dtype(f[c]) or pd.api.types.is_string_dtype(f[c])
                 or isinstance(f[c].dtype, pd.CategoricalDtype))][:8]
    for c in cols:
        codes, uniques = pd.factorize(f[c], use_na_sentinel=True)
        if len(uniques) > 12:
            continue
        for j, u in enumerate(uniques):
            if isinstance(u, str) and u:
                out[(c, u)] = np.flatnonzero(codes == j)
    return out


def _names_value(col: str, value: str) -> bool:
    """Whether an output column is named by a value (`merged`, `n_closed` for "merged", "closed"; `approved` for
    "approve"): a word of the name is the value, or one begins the other and both have five letters or more."""
    v = R.value_slug(value).replace("-", "_")
    if not v:
        return False
    for t in re.split(r"[^a-z0-9]+", col.lower()):
        if t == v or (min(len(t), len(v)) >= 5 and (t.startswith(v) or v.startswith(t))):
            return True
    return False


def _one_set(cands: list[list[Any]]) -> list[Any] | None:
    """The one set of rows all candidates name, or None when there are none or they disagree."""
    if not cands:
        return None
    sets = {tuple(sorted(str(x) for x in c)) for c in cands}
    return cands[0] if len(sets) == 1 else None


def _count_of(v: Any) -> int | None:
    """A positive whole number of the output (a count it may be), or None."""
    import numpy as np

    if isinstance(v, (bool, np.bool_)) or not isinstance(v, (int, np.integer)):
        return None
    return int(v) if int(v) > 0 else None


def _narrowest(serials: list[int], refs: dict[int, tuple[int, Any]]) -> list[int]:
    """The frames among `serials` that hold no other's rows: a filtered frame stands for the frame it was cut from
    (the merged PRs for all the PRs), and frames of other files stay."""
    sets = {s: set(str(x) for x in refs[s][1]) for s in serials}
    out = []
    for a in serials:
        sa = sets[a]
        if not sa:
            continue
        if any(b != a and sets[b] and sets[b] <= sa and (len(sets[b]) < len(sa) or b < a) for b in serials):
            continue
        out.append(a)
    return out


def _norm(v: Any) -> Any:
    v = jsonable(v)
    if isinstance(v, float) and math.isnan(v):
        return None
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def _record_fields(x: Any, cols: list[str]) -> dict[str, Any] | None:
    import pandas as pd

    if isinstance(x, dict):
        return {str(k): v for k, v in x.items()}
    if isinstance(x, pd.Series):
        return {str(k): v for k, v in x.items()}
    if isinstance(x, (tuple, list)):
        return {c: v for c, v in zip(cols, x)}
    return None


def _record_places(obj: list, at: dict[int, set[int]], result: Any, df: Any, index: list[Any]) -> list[int] | None:
    """For each output row, the place in `obj` of the record it shows: every row must match a noted record."""
    cols = [c for c in df.columns if isinstance(c, str) and not c.startswith("_") and c != "index"]
    if result is obj:
        return list(range(len(df))) if len(df) == len(obj) and all(k in at for k in range(len(df))) else None

    def same(i: int, k: int) -> bool:
        if not (0 <= k < len(obj)) or k not in at:
            return False
        rec = _record_fields(obj[k], cols)
        if not rec:
            return False
        shared = [c for c in cols if c in rec]
        if not shared:
            return False
        row = df.iloc[i]
        return all(_norm(row[c]) == _norm(rec[c]) for c in shared)

    # by place: the output's index is where each record sat in the list (a sort or a filter keeps it)
    if len(index) == len(df) and all(isinstance(k, int) and not isinstance(k, bool) for k in index):
        if all(same(i, int(k)) for i, k in enumerate(index)):
            return [int(k) for k in index]
    # by values: each output row's values pick one record (records of the same fields are looked up together)
    try:
        groups: dict[tuple, dict[tuple, list[int]]] = defaultdict(lambda: defaultdict(list))
        for k in at:
            if not (0 <= k < len(obj)):
                continue
            rec = _record_fields(obj[k], cols)
            shared = tuple(c for c in cols if rec and c in rec)
            if shared:
                groups[shared][tuple(_norm(rec[c]) for c in shared)].append(k)
        out = []
        for i in range(len(df)):
            row = df.iloc[i]
            hit = None
            for shared, by in groups.items():
                ks = by.get(tuple(_norm(row[c]) for c in shared))
                if ks and len(ks) == 1:
                    hit = ks[0]
                    break
            if hit is None:
                return None
            out.append(hit)
        return out
    except TypeError:  # values that do not hash (a list in a record)
        return None


# ------------------------------------------------------------------ output and its row lineage


def jsonable(v: Any) -> Any:
    try:
        import numpy as np
        import pandas as pd
        if isinstance(v, (np.integer,)):
            return int(v)
        if isinstance(v, (np.floating,)):
            v = float(v)
        if isinstance(v, (np.bool_,)):
            return bool(v)
        if isinstance(v, (pd.Timestamp,)):
            return v.isoformat()
        if v is pd.NaT:
            return None
    except ImportError:
        pass
    if isinstance(v, float):
        return None if math.isnan(v) or math.isinf(v) else v
    if isinstance(v, (str, int, bool)) or v is None:
        return v
    if isinstance(v, (list, tuple)):
        return [jsonable(x) for x in v][:50]
    if isinstance(v, dict):
        return {str(k): jsonable(x) for k, x in list(v.items())[:50]}
    return str(v)


def show(v: Any, qid: str | None = None) -> str:
    """The result as Claude reads it. A table of up to 60 rows shows whole when it fits in SHOW characters; a longer or
    wider one shows as many of its first and last rows as fit, and says how many it has (the query keeps them all)."""
    try:
        import pandas as pd
        if isinstance(v, (pd.DataFrame, pd.Series)):
            vv = v.drop(columns=ref_columns(v)[1]) if isinstance(v, pd.DataFrame) else v

            def render(n: int) -> str:
                if isinstance(vv, pd.DataFrame):
                    return vv.to_string(max_rows=n, max_cols=14, max_colwidth=60)
                return vv.to_string(max_rows=n)

            n = 60
            s = render(n)
            if len(s) > SHOW and len(v) > 10:
                per_row = max(1, len(s) // (s.count("\n") + 1))
                n = max(10, min(60, SHOW // per_row) // 2 * 2)
                s = render(n)
            if len(v) > n:
                s += f"\n({len(v):,} rows, the first and last {n // 2} shown"
                s += f"; use(\"{qid}\") reads them all in a later query)" if qid else ")"
            return s
    except ImportError:
        pass
    if isinstance(v, (dict, list)):
        try:
            return json.dumps(v, indent=1, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            pass
    return repr(v)


def ref_columns(f: Any) -> tuple[list[str], list[str]]:
    """The columns of a frame that hold its source rows: `_ref` (one per row) and `_refs` (a list per row), and the
    same names with a merge's suffix (`_ref_x`, `_refs_right`): a row of a merged frame rests on both sides' rows."""
    cols = [c for c in getattr(f, "columns", []) if isinstance(c, str)]
    one = [c for c in cols if c == "_ref" or c.startswith("_ref_")]
    many = [c for c in cols if c == "_refs" or c.startswith("_refs_")]
    return one, many


def row_ref_lists(f: Any) -> list[list[str]]:
    """Each row's source rows: its `_ref` and `_refs` columns (and their merge-suffixed copies) together, an empty
    side of an outer merge left out."""
    one, many = ref_columns(f)
    if one == ["_ref"] and not many:
        return [[x] if isinstance(x, str) else [] for x in f["_ref"].tolist()]
    if many == ["_refs"] and not one:
        return [[str(y) for y in x] if isinstance(x, (list, tuple)) else [] for x in f["_refs"].tolist()]
    ones = [f[c].tolist() for c in one]
    lists = [f[c].tolist() for c in many]
    out: list[list[str]] = []
    for i in range(len(f)):
        refs = [c[i] for c in ones if isinstance(c[i], str)]
        for col in lists:
            v = col[i]
            if isinstance(v, (list, tuple)):
                refs.extend(str(y) for y in v)
        out.append(list(dict.fromkeys(refs)))
    return out


_ROWNUM = re.compile(r"^(?P<path>[^#]+)#(?P<unit>L|row=|/(?:[^/]*/)*)(?P<n>\d+)$")
_DBROWNUM = re.compile(r"^(?P<path>[^#]+\.(?:db|sqlite|sqlite3))#(?P<unit>[A-Za-z_][A-Za-z0-9_]*/)(?P<n>\d+)$", re.I)


def rowsets_of(frames: list[Any]) -> list[str]:
    """Every source row the frames hold, as few row-set strings: one per file and unit, the rows sorted. A frame from
    load() is read by its `_file` column, a file at a time, so a frame of millions of rows takes a moment, not many."""
    import numpy as np
    import pandas as pd

    nums: dict[tuple[str, str], list[Any]] = {}
    other: dict[str, None] = {}

    def add(s: Any) -> None:
        s = s.dropna().astype(str).drop_duplicates()
        for rx in (_ROWNUM, _DBROWNUM):
            if s.empty:
                return
            m = s.str.extract(rx)
            ok = m["n"].notna()
            if ok.any():
                g = m[ok]
                for (path, unit), part in g.groupby(["path", "unit"], sort=False)["n"]:
                    nums.setdefault((path, unit), []).append(part.astype(np.int64).to_numpy())
            s = s[~ok]
        for x in s.tolist():
            other[x] = None

    for f in frames:
        one, many = ref_columns(f)
        for c in one:
            if c == "_ref" and "_file" in f.columns:
                # the rows of one file share the ref's start (`revisions.jsonl#L`), so the numbers are what follows it
                for rel, refs in f.groupby("_file", sort=False)["_ref"]:
                    refs = refs.dropna().astype(str)
                    if refs.empty:
                        continue
                    first = R._unit(refs.iloc[0])
                    if first and first[0] == str(rel):
                        pre = f"{first[0]}#{first[1]}"
                        tail = refs.str.slice(len(pre))
                        if bool(refs.str.startswith(pre).all()) and bool(tail.str.isdigit().all()):
                            nums.setdefault((first[0], first[1]), []).append(tail.astype(np.int64).to_numpy())
                            continue
                    add(refs)
            else:
                add(f[c])
        for c in many:
            add(f[c].explode())
    out: list[str] = []
    for (path, unit), arrs in nums.items():
        a = np.unique(np.concatenate(arrs))
        cut = np.where(np.diff(a) != 1)[0]
        starts, ends = a[np.r_[0, cut + 1]], a[np.r_[cut, len(a) - 1]]
        out.append(f"{path}#{unit}" + ",".join(str(x) if x == y else f"{x}-{y}" for x, y in zip(starts.tolist(), ends.tolist())))
    out.extend(other)
    return out


def _is_count_col(series: Any) -> bool:
    try:
        import pandas as pd
        return pd.api.types.is_integer_dtype(series) and not pd.api.types.is_bool_dtype(series)
    except ImportError:
        return False


def output_lineage(result: Any, ns: dict[str, Any], frames: list[Any], records: "_Records | None" = None) -> dict[str, Any]:
    """{table, rows, keys, mode, frame}: the output as a table of JSON rows, the row sets behind each of its rows, its
    key columns, how sure the row lineage is (module note) and the frame it was found in. A summary (a number, a dict
    of numbers, a one-row table) rests on the rows the query read: `why_rows` marks its rows that rest on all of them."""
    import pandas as pd

    out: dict[str, Any] = {"table": None, "rows": None, "keys": [], "mode": "query", "frame": None}
    if result is None:
        return out
    if isinstance(result, (int, float)) or (hasattr(result, "dtype") and getattr(result, "shape", None) == ()):
        val = jsonable(result)
        out["table"] = [{"value": val}]
        _summary(out, [val], ns, frames)
        return out
    if isinstance(result, pd.Series):
        result = result.to_frame(result.name if result.name is not None else "value")
    if isinstance(result, dict) and all(not isinstance(x, (dict, list)) for x in result.values()):
        out["table"] = [{"key": str(k), "value": jsonable(x)} for k, x in result.items()]
        out["keys"] = ["key"]
        if not out["table"]:
            return out
        # a dict built from a column (a Counter of users, a share per day): its keys are values of that column
        found = None
        if len(out["table"]) > 1:
            try:
                found = _by_values(pd.DataFrame(out["table"]), "key", ns, frames)
            except Exception:  # noqa: BLE001
                found = None
        if found:
            out["rows"], out["mode"], out["frame"] = [R.compress(x) for x in found[0]], found[1], found[2]
        elif len(out["table"]) <= SUMMARY_MAX:
            _summary(out, [r["value"] for r in out["table"]], ns, frames)
        return out
    made_from = result
    if isinstance(result, (list, tuple)) and result and all(isinstance(x, dict) for x in result):
        # records built in code: a table like any other, matched to its rows by key when its keys name them
        try:
            result = pd.DataFrame(list(result))
        except Exception:  # noqa: BLE001
            return out
    if not isinstance(result, pd.DataFrame):
        return out
    df = result
    index = list(df.index) if isinstance(df.index, pd.RangeIndex) or pd.api.types.is_integer_dtype(df.index) else []
    keys: list[str] = []
    # rows of a frame the query made, sorted, filtered or cut to a few columns: lineage by row, before any key guess
    aligned = None
    own_one, own_many = ref_columns(df)
    if not own_one and not own_many and len(df) <= 200000:
        try:
            aligned = _by_index(df, ns, frames)
        except Exception:  # noqa: BLE001
            aligned = None
    if not isinstance(df.index, pd.RangeIndex):
        # an unnamed whole-number index is where the rows sat before a sort or a filter, not what they stand for: it
        # stays a column, and the keys are the output's words, as for a plain table
        positional = list(df.index.names) == [None] and pd.api.types.is_integer_dtype(df.index)
        keys = [] if positional else [str(n) if n is not None else "index" for n in df.index.names]
        df = df.reset_index()
        df.columns = [str(c) for c in df.columns]
    df = df.copy()
    df.columns = [str(c) if not isinstance(c, tuple) else "_".join(str(x) for x in c if x != "") for c in df.columns]
    row_refs: list[list[str]] | None = None
    if own_one or own_many:
        row_refs = row_ref_lists(df)
        out["mode"] = "exact"
    if not keys:
        keys = [c for c in df.columns if not c.startswith("_") and c != "index"
                and (not pd.api.types.is_numeric_dtype(df[c]) or pd.api.types.is_bool_dtype(df[c]))]
    out["keys"] = keys
    if row_refs is None and aligned is not None:
        row_refs, out["mode"], out["frame"] = aligned
    if row_refs is None and keys and len(df) <= 200000:
        found = _by_key(df, keys, ns, frames)
        if not found and len(keys) > 1:
            # the key columns guessed from the output's words may hold a column the query computed per group (a top
            # label, a note): a single key that alone tells the output rows apart is tried on its own
            for k in keys:
                try:
                    if not df[k].is_unique:
                        continue
                except TypeError:
                    continue
                found = _by_key(df, [k], ns, frames)
                if found:
                    out["keys"] = [k]
                    break
        if found:
            row_refs, out["mode"], out["frame"] = found
    if row_refs is None and len(df) > 1 and len(df) <= 200000:
        # a key under another name: its values are a column (or the index) of a frame the query made
        for k in [c for c in out["keys"] if c in df.columns][:3]:
            try:
                found = _by_values(df, k, ns, frames)
            except Exception:  # noqa: BLE001
                found = None
            if found:
                row_refs, out["mode"], out["frame"] = found
                out["keys"] = [k]
                break
    loop = None
    if records is not None and len(df) <= TABLE_MAX:
        # records appended in a loop: each output row rests on what its own pass held; a count of one of its frames
        # (or of a value it names) opens that frame's rows, whichever way the row's own rows were found
        try:
            loop = records.lineage(made_from, df, index, ns)
        except Exception:  # noqa: BLE001
            loop = None
    table = df.drop(columns=ref_columns(df)[1])
    out["table"] = [{k: jsonable(v) for k, v in r.items()} for r in table.head(TABLE_MAX).to_dict(orient="records")]
    out["truncated"] = len(df) > TABLE_MAX
    if row_refs is not None:
        out["rows"] = [R.compress(x) for x in row_refs[:TABLE_MAX]]
    elif loop is not None:
        out["rows"], out["frame"] = loop[0], loop[2]
        out["mode"] = "loop"
    elif len(df) == 1:
        # one row of values computed over the rows the query read (sums, shares, counts side by side)
        _summary(out, [None], ns, frames)
    if loop is not None and out.get("rows") and out.get("mode") != "summary":
        cells = [{c: x for c, x in cell.items() if x != (out["rows"][i] if i < len(out["rows"]) else None)}
                 for i, cell in enumerate(loop[1][:len(out["rows"])])]
        if any(cells):
            out["cells"] = cells
            out["loop"] = loop[2]
    return out


def _summary(out: dict[str, Any], values: list[Any], ns: dict[str, Any], frames: list[Any]) -> None:
    """The rows behind a summary's values: a count that equals the rows of exactly one frame the query made rests on
    that frame's rows (matched); any other value rests on all the rows the query read (summary), which `why_rows`
    marks, since which of them the value used is not kept."""
    whole: list[str] | None = None
    rows: list[list[str]] = []
    marks: list[str | None] = []
    names: set[str] = set()
    for v in values:
        hits = []
        if isinstance(v, int) and not isinstance(v, bool) and v > 0:
            hits = _named_frames(ns, frames, lambda f: len(f) == v)
        if len(hits) == 1:
            rows.append(rowsets_of([hits[0][1]]))
            marks.append(None)
            names.add(hits[0][0])
            continue
        if whole is None:
            # the rows the query read: the frames it loaded or used (every frame it made is cut from those)
            whole = rowsets_of([f for f in frames if ref_columns(f)[0] or ref_columns(f)[1]])
            if not whole:
                whole = rowsets_of([f for _, f in _named_frames(ns, frames, lambda f: True, lists=True)])
        rows.append(whole)
        marks.append("summary")
    if not any(rows):
        return
    out["rows"] = rows
    if any(marks):
        out["mode"] = "summary"
        out["why_rows"] = marks
    else:
        out["mode"] = "matched"
        out["frame"] = next(iter(names)) if len(names) == 1 else None


def _named_frames(ns: dict[str, Any], frames: list[Any], pred, lists: bool = False) -> list[tuple[str, Any]]:
    """The frames of the query's namespace (and the ones it loaded or used) that hold source rows: `_ref` per row (or
    a merge's `_ref_x`), or with `lists`, also `_refs` (a list per row: a tally, a used query's output)."""
    import pandas as pd

    def has(v: Any) -> bool:
        one, many = ref_columns(v)
        return bool(one) or (lists and bool(many))

    seen: set[int] = set()
    hits = []
    for name, v in list(ns.items()):
        if isinstance(v, pd.DataFrame) and id(v) not in seen and has(v):
            seen.add(id(v))
            try:
                if pred(v):
                    hits.append((name, v))
            except Exception:  # noqa: BLE001
                pass
    for i, v in enumerate(frames):
        if isinstance(v, pd.DataFrame) and id(v) not in seen and has(v):
            seen.add(id(v))
            try:
                if pred(v):
                    hits.append((f"load#{i + 1}", v))
            except Exception:  # noqa: BLE001
                pass
    return hits


def _by_index(res: Any, ns: dict[str, Any], frames: list[Any]):
    """Row lineage found by row: the output is rows of a frame the query made (a sort, a filter, a few columns, head),
    so its index labels are that frame's and its shared columns hold the same values there. (row sets, mode, frame)"""
    import pandas as pd

    idx = res.index
    if not len(idx) or not idx.is_unique or isinstance(idx, pd.MultiIndex):
        return None
    cols = [c for c in res.columns if isinstance(c, str) and not c.startswith("_")]
    if not cols:
        return None

    def fits(f: Any) -> bool:
        return f.index.is_unique and bool(idx.isin(f.index).all()) and any(c in f.columns for c in cols)

    best = None
    for name, f in _named_frames(ns, frames, fits, lists=True):
        shared = [c for c in cols if c in f.columns]
        probe = idx[:50]
        try:
            a = res.loc[probe, shared].astype(object)
            b = f.loc[probe, shared].astype(object)
            same = ((a == b) | (a.isna() & b.isna())).all().all()
        except Exception:  # noqa: BLE001 — columns that do not compare
            continue
        if not same:
            continue
        got = row_ref_lists(f.loc[idx])
        score = (len(shared), -len(f))
        if best is None or score > best[0]:
            best = (score, got, name)
    if best is None:
        return None
    return best[1], "exact", best[2]


def _by_values(df: Any, key: str, ns: dict[str, Any], frames: list[Any], budget: float = 3.0):
    """Row lineage found by a key's values: the output's key column holds the values of a column (or the index) of a
    frame the query made, under another name (a dict built from a column, a renamed key), so each output row rests on
    the frame's rows that hold its value. A count column that equals the group sizes makes it matched, as in _by_key.
    Looked for only when nothing else found the rows, for at most `budget` seconds."""
    import pandas as pd

    want = df[key]
    if not len(want) or want.isna().any() or not want.is_unique:
        return None
    wvals = want.tolist()
    wstr = [str(v) for v in wvals]
    wset = set(wstr)
    count_cols = [c for c in df.columns if c != key and not str(c).startswith("_") and _is_count_col(df[c])]
    deadline = time.time() + budget
    best = None
    for name, f in _named_frames(ns, frames, lambda f: True, lists=True):
        cands: list[tuple[str, Any]] = [(str(c), f[c]) for c in f.columns if isinstance(c, str) and not c.startswith("_")
                                        and (pd.api.types.is_object_dtype(f[c]) or pd.api.types.is_string_dtype(f[c]))]
        if not isinstance(f.index, pd.RangeIndex):
            cands.append(("index", pd.Series(f.index, index=f.index)))
        for cname, col in cands:
            if time.time() > deadline:
                return None if best is None else (best[1], best[2], best[3])
            try:
                hit = col.isin(wvals)
                if not bool(hit.any()):
                    continue
                vals = col[hit].astype(str)
                if not wset <= set(vals.unique().tolist()):
                    continue
            except Exception:  # noqa: BLE001 — values that do not compare
                continue
            mask = hit.to_numpy()
            if ref_columns(f) == (["_ref"], []):
                g = pd.DataFrame({"v": vals.to_numpy(), "r": f["_ref"].to_numpy()[mask]}).groupby("v", sort=False)["r"].agg(list)
                got = [[str(x) for x in g.get(v, [])] for v in wstr]
                n = [len(x) for x in got]
            else:
                groups: dict[str, list[str]] = {}
                sizes: dict[str, int] = {}
                for v, r in zip(vals.tolist(), row_ref_lists(f[mask])):
                    groups.setdefault(v, []).extend(r)
                    sizes[v] = sizes.get(v, 0) + 1
                got = [list(dict.fromkeys(groups.get(v, []))) for v in wstr]
                n = [sizes.get(v, 0) for v in wstr]
            agree = [c for c in count_cols if all(int(x) == k for x, k in zip(df[c].tolist(), n) if x == x)]
            mode = "matched" if agree else ("superset" if count_cols else "key")
            score = (2 if agree else 1 if not count_cols else 0, -len(f))
            if best is None or score > best[0]:
                best = (score, got, mode, f"{name}.{cname}")
    if best is None:
        return None
    return best[1], best[2], best[3]


def _by_key(df: Any, keys: list[str], ns: dict[str, Any], frames: list[Any]):
    """Row lineage found by key: each frame the query made that has source rows and every key column groups its rows
    by the keys; the frame whose groups hold every output row wins, one whose group sizes equal a count column first,
    then the smallest."""
    cands = _named_frames(ns, frames, lambda f: all(k in f.columns for k in keys), lists=True)
    best = None
    count_cols = [c for c in df.columns if c not in keys and not c.startswith("_") and _is_count_col(df[c])]
    for name, f in cands:
        # a frame of source rows (`_ref`) groups its refs; any other (a used query's `_refs`, a merge's `_ref_x` and
        # `_ref_y`) groups each row's own list of rows, and a group's rows are their union
        one, many = ref_columns(f)
        try:
            if one == ["_ref"] and not many:
                g = f.groupby(keys if len(keys) > 1 else keys[0], dropna=False, sort=False)["_ref"].agg(list)
                flat = lambda refs: [str(x) for x in refs]  # noqa: E731
            else:
                tmp = f[keys].copy()
                tmp["__lean_refs"] = row_ref_lists(f)
                g = tmp.groupby(keys if len(keys) > 1 else keys[0], dropna=False, sort=False)["__lean_refs"].agg(list)
                flat = lambda refs: list(dict.fromkeys(str(y) for x in refs for y in x))  # noqa: E731
        except Exception:  # noqa: BLE001 — unhashable keys and the like
            continue
        lookup = g.to_dict()
        got = []
        sizes = []
        ok = True
        for _, r in df[keys].iterrows():
            k = tuple(r[c] for c in keys) if len(keys) > 1 else r[keys[0]]
            refs = lookup.get(k)
            if refs is None:
                # NaN keys never compare equal: match them by position of their group
                ok = False
                break
            sizes.append(len(refs))
            got.append(flat(refs))
        if not ok:
            continue
        agree = [c for c in count_cols if all(int(v) == s for v, s in zip(df[c].tolist(), sizes) if v == v)]
        mode = "matched" if agree else ("superset" if count_cols else "key")
        score = (2 if agree else 1 if not count_cols else 0, -len(f))
        if best is None or score > best[0]:
            best = (score, got, mode, name)
    if best is None:
        return None
    return best[1], best[2], best[3]


# ------------------------------------------------------------------ running


def run_code(st: Store, code: str, qid: str | None = None) -> dict[str, Any]:
    """Run code as a notebook cell over the root folder: its printed text, then the value of its last expression."""
    info: dict[str, Any] = {"loads": [], "samples": 0, "opened": set(), "external": set(), "kept": [],
                            "uses": [], "frames": []}
    root = str(st.root) + os.sep
    rec_dir = str(st.dir) + os.sep
    # the kernel's own files (its code, its cache of loaded frames) are no input of the query
    own = (str(Path(__file__).resolve().parents[2]) + os.sep, str(thimble_home().resolve() / "lean") + os.sep)

    def audit(ev: str, args: tuple) -> None:
        if ev == "open" and args and isinstance(args[0], (str, os.PathLike)):
            p = os.path.abspath(os.fspath(args[0]))
            if p.startswith(rec_dir) or p.startswith(own):
                return
            if p.startswith(root):
                info["opened"].add(os.path.relpath(p, root))
            elif not p.startswith((sys.prefix, sys.base_prefix, "/usr/", "/proc/", "/dev/", "/etc/", "/sys/", "/tmp/")) and "site-packages" not in p:
                info["external"].add(p)

    sys.addaudithook(audit)
    ns = make_namespace(st, info)
    buf = io.StringIO()
    t0 = time.time()
    err = None
    last = None
    old = os.getcwd()
    os.chdir(st.root)
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            try:
                tree = ast.parse(code, "<query>", "exec")
                kept_last = (tree.body and isinstance(tree.body[-1], ast.Expr) and isinstance(tree.body[-1].value, ast.Call)
                             and isinstance(tree.body[-1].value.func, ast.Name) and tree.body[-1].value.func.id == "keep")
                tree = ast.fix_missing_locations(_AppendCalls().visit(tree))
                tail = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
                exec(compile(tree, "<query>", "exec"), ns)
                if tail is not None:
                    last = eval(compile(ast.Expression(tail.value), "<query>", "eval"), ns)
                elif "result" in ns:
                    last = ns["result"]
                # a query that ends by keeping a result (keep("kind", values)) printed what it meant to show already
                if last is not None and not kept_last:
                    print(show(last, qid))
            except Exception as e:  # noqa: BLE001
                err = f"{type(e).__name__}: {e}"
                print(query_traceback(e, code))
    finally:
        os.chdir(old)
    lin = output_lineage(last, ns, info["frames"], info.get("records")) if err is None else {"table": None, "rows": None, "keys": [], "mode": "query", "frame": None}
    if err is None and lin.get("rows") is None:
        # no rows per output row: the rows the query read (loaded or used) stand behind the query as a whole
        try:
            lin["read"] = rowsets_of(info["frames"])
        except Exception:  # noqa: BLE001 — refs that do not parse: the query still resolves to its files
            lin["read"] = []
    if info["loads"] and all(x.get("via") == "rows" for x in info["loads"]):
        lin["via"] = "rows"
    if qid and err is None:
        keep_result(st, qid, last, lin)
    loaded: dict[str, int] = defaultdict(int)
    for x in info["loads"]:
        loaded[x["path"]] += x["rows"]
    inputs = []
    for f in sorted(set(loaded) | {f for f in info["opened"] if S.kind_of(Path(f))}):
        p = st.root / f
        try:
            fp = S.fingerprint(p)
        except OSError:
            continue
        inputs.append({"path": f, "rows_read": loaded.get(f, 0), "how": "load" if f in loaded else "opened", **fp})
    out = {"stdout": buf.getvalue(), "error": err, "seconds": round(time.time() - t0, 2), "inputs": inputs,
           "samples": info["samples"], "external": sorted(info["external"])[:20],
           "kept": info["kept"], "uses": _dedupe(info["uses"]), **lin}
    try:
        # the cache stays bounded: looked over after a query that added frames to it, else at most once a day
        prune_cache(force=bool(info.get("cached")))
    except OSError:
        pass
    return out


REFS_FROM_RECORD = "lean_refs_from_record"


def record_refs(q: dict[str, Any], n: int) -> list[list[str]]:
    """Each output row's source rows as `_refs`, one ref each, from the query's record. A summary's row rests on every
    row the query read: a later query keeps no rows of it (the record still opens them), so millions of refs are not
    copied into each row."""
    rows = q.get("rows")
    if rows is None or len(rows) != n:
        print(f"use({q.get('id')!r}): its record keeps no rows for its {n:,} output rows, so `_refs` is empty"
              + (f" ({q['unreadable']})" if q.get("unreadable") else ""))
        return [[] for _ in range(n)]
    marks = q.get("why_rows") or []
    return [[] if i < len(marks) and marks[i] else R.expand(x) for i, x in enumerate(rows)]


def keep_result(st: Store, qid: str, last: Any, lin: dict[str, Any]) -> None:
    """A table result kept whole (thimble/results/<qid>.pkl.gz), shaped as the output table it showed, with each row's
    source rows as `_refs`, so use("q3") gives a later query exactly what this one showed."""
    try:
        import pandas as pd
    except ImportError:
        return
    if not isinstance(last, (pd.DataFrame, pd.Series)):
        return
    df = last.to_frame(last.name if last.name is not None else "value") if isinstance(last, pd.Series) else last
    try:
        if int(df.memory_usage(deep=True).sum()) > RESULT_BYTES:
            return
    except Exception:  # noqa: BLE001
        return
    if not isinstance(df.index, pd.RangeIndex):
        df = df.reset_index()
    if "_refs" not in df.columns and lin.get("rows") is not None and len(lin["rows"]) == len(df):
        # each row's `_refs` are its rows in the record, one ref each (record_refs): the result keeps a note of that,
        # not the refs, which a row of a million lines would make 50 MB here and a few characters there
        df = df.copy(deep=False)
        df.attrs = {**df.attrs, REFS_FROM_RECORD: True}
    try:
        write_pickle(st.sub("results"), qid, df)
    except Exception:  # noqa: BLE001 — a result that does not pickle is still in the query's record
        pass


def query_traceback(e: BaseException, code: str) -> str:
    """The error as Claude reads it: the query's own lines on the way to it, then the error (the kernel's frames and
    the library's inner frames say nothing about the query)."""
    lines = code.splitlines()
    out = []
    for fr in traceback.extract_tb(e.__traceback__):
        if fr.filename == "<query>" and fr.lineno:
            src = lines[fr.lineno - 1].strip() if 0 < fr.lineno <= len(lines) else ""
            out.append(f"  line {fr.lineno}" + (f", in {fr.name}" if fr.name not in ("<module>", "<lambda>") else "") + (f": {src}" if src else ""))
    out = out[-4:]
    out.append("".join(traceback.format_exception_only(type(e), e)).strip())
    return "\n".join(out)


def _dedupe(xs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for x in xs:
        if x not in out:
            out.append(x)
    return out


def run(st: Store, about: str, code: str, rerun_of: str | None = None) -> dict[str, Any]:
    qid, path = next_id(st)
    r = run_code(st, code, qid)
    q = {"id": qid, "about": about, "code": code, "session": st.session, "t": time.time(), "rerun_of": rerun_of,
         "stdout": r["stdout"][:400000], "error": r["error"], "seconds": r["seconds"], "inputs": r["inputs"],
         "samples": r["samples"], "external": r["external"], "kept": r["kept"],
         "uses": r["uses"], "table": r["table"], "truncated": r.get("truncated", False), "rows": r["rows"],
         "keys": r["keys"], "lineage": r["mode"], "frame": r["frame"],
         "out_hash": hashlib.sha1(r["stdout"].encode()).hexdigest()[:16]}
    for k in ("why_rows", "read", "via", "cells", "loop"):
        if r.get(k):
            q[k] = r[k]
    # a long row lineage is written packed; the record in hand, which `lean q --json` prints, stays whole
    st.write_json(path, pack_record(q))
    if r["kept"]:
        reg = st.read_json(st.dir / "kept.json") or {}
        reg.update({k: qid for k in r["kept"]})
        st.write_json(st.dir / "kept.json", reg)
    st.log({"kind": "query", "id": qid, "about": about, "loaded": {x["path"]: x["rows_read"] for x in r["inputs"]},
            "uses": r["uses"], "kept": r["kept"], "error": r["error"]})
    return q


def stale_inputs(st: Store, q: dict[str, Any]) -> list[str]:
    """Inputs of a query that changed since it ran."""
    return [x["path"] for x in q.get("inputs") or [] if not S.same_file(st.root / x["path"], x)]


def all_inputs(st: Store, q: dict[str, Any], seen: set[str] | None = None) -> list[dict[str, Any]]:
    """A query's inputs and, through use(), those of the queries it builds on."""
    seen = seen if seen is not None else set()
    if q["id"] in seen:
        return []
    seen.add(q["id"])
    out = list(q.get("inputs") or [])
    for u in q.get("uses") or []:
        pq = get(st, u["query"])
        if pq:
            out += all_inputs(st, pq, seen)
    return out


def _files_text(paths: list[str], n: int = 2) -> str:
    files = list(dict.fromkeys(str(x).split("#")[0] for x in paths if x))
    if not files:
        return ""
    return ", ".join(files[:n]) + (f" and {len(files) - n} more files" if len(files) > n else "")


def _count(rowsets: list[str]) -> int:
    try:
        return R.count(rowsets)
    except R.RefError:
        return 0


def why_of(st: Store, q: dict[str, Any], i: int | None = None, whole: bool = False, col: str | None = None) -> str | None:
    """One plain line for the person: why a value of the query has no source rows of its own, or why the rows it opens
    are all the rows the query read, or all the rows its loop held for its output row. None when a value's rows are its
    own. `i` is the output row the value is in, `col` its column; `whole` says the query as a whole is cited, which
    opens every row it read."""
    if q.get("error"):
        return None
    if q.get("unreadable"):
        return str(q["unreadable"])
    qid = q.get("id") or "the query"
    rows = q.get("rows")
    if rows:
        marks = q.get("why_rows") or []
        mark = marks[i] if i is not None and i < len(marks) else (marks[0] if marks and all(marks) else None)
        if mark != "summary":
            empty = i is not None and i < len(rows) and not rows[i]
            v = ((q.get("table") or [{}])[i] if i is not None and i < len(q.get("table") or []) else {}).get(col) if col else None
            counted = isinstance(v, int) and not isinstance(v, bool) and i is not None and i < len(rows) and v == _count(rows[i])
            sums = [u.get("query") for u in q.get("uses") or [] if (get(st, u.get("query") or "") or {}).get("lineage") == "summary"]
            if empty and sums:
                return f"{qid} builds on {', '.join(sums)}, a summary whose values keep no rows of their own"
            if (q.get("lineage") == "loop" and col is not None and i is not None and i < len(rows) and rows[i]
                    and value_rows(q, i, col) is rows[i] and not counted):
                return (f"{qid} made this output row in a loop from these {_count(rows[i]):,} rows "
                        f"({_files_text(rows[i])}), the frames it loaded and filtered for it, and it does not keep "
                        "which of them the value used")
            if (q.get("cells") and col is not None and i is not None and i < len(rows) and rows[i]
                    and value_rows(q, i, col) is rows[i] and not counted):
                # beside counts of the row that keep their own rows, a value that keeps none says so
                return (f"{qid} does not keep which rows this value used: these are the {_count(rows[i]):,} rows "
                        f"behind its whole output row ({_files_text(rows[i])})")
            return None
        mine = rows[i] if i is not None and i < len(rows) else rows[0]
        return (f"{qid} computed this value over all {_count(mine):,} rows it read ({_files_text(mine)}), "
                "and it does not keep which of them the value used")
    read = q.get("read") or []
    inputs = q.get("inputs") or []
    uses = [u.get("query") for u in q.get("uses") or [] if u.get("query")]
    bare = [u for u in uses if not ((get(st, u) or {}).get("rows"))]
    if q.get("table") is None:
        why = f"{qid} only printed its output, so a number in it has no rows of its own"
    elif q.get("external") and not inputs:
        why = f"{qid} read files outside the folder, so its values keep no rows"
    elif q.get("via") == "rows":
        why = f"{qid} built its output in a loop over rows() of {_files_text([x['path'] for x in inputs])}, so its values keep no rows"
    elif inputs and all(x.get("how") == "opened" for x in inputs) and not uses:
        why = (f"{qid} built its output in code from files it opened ({_files_text([x['path'] for x in inputs])}), "
               "not with load(), so its values keep no rows")
    elif not inputs and not uses:
        why = f"{qid} computed its output in code from no source rows"
    elif bare and len(bare) == len(uses) and not any(x.get("how") == "load" for x in inputs):
        why = f"{qid} builds on {', '.join(bare)}, which keep{'s' if len(bare) == 1 else ''} no rows"
    else:
        keys = [k for k in q.get("keys") or [] if not str(k).startswith("_")]
        why = (f"{qid} does not keep the rows behind each output row: its key{'s' if len(keys) > 1 else ''} "
               f"({', '.join(keys)}) match{'' if len(keys) > 1 else 'es'} no rows of a frame it read") if keys else (
               f"{qid} does not keep the rows behind each output row, and its output has no key column to find them by")
    if whole and read:
        why += f"; these are all {_count(read):,} rows it read ({_files_text(read)})"
    return why


def value_rows(q: dict[str, Any], i: int, col: str | None = None) -> list[str] | None:
    """The rows behind output row `i` of a query, or behind its value in column `col` when the query kept that value's
    own rows (`cells`: a count that equals the rows of one frame its loop held for the row)."""
    rows = q.get("rows")
    if not rows or i >= len(rows):
        return None
    cells = q.get("cells") or []
    if col is not None and i < len(cells) and isinstance(cells[i], dict) and cells[i].get(col):
        return list(cells[i][col])
    return rows[i]


def column(r: dict[str, Any], k: str) -> str | None:
    """The column of an output row that a ref's key or `@col` names: as written, else the one with the same slug."""
    if k in r:
        return k
    sk = R.value_slug(k)
    if sk:
        for c in r:
            if R.value_slug(c) == sk:
                return c
    return None


def find_rows(q: dict[str, Any], frag: dict[str, Any]) -> list[int]:
    """Indexes of the output rows a query ref's fragment names. A key value matches as written (or as the same number);
    when no row matches so, it matches by its slug, so `won-clean-ep` finds "won (clean ep)"."""
    table = q.get("table") or []
    if "row" in frag:
        i = frag["row"] - 1
        return [i] if 0 <= i < len(table) else []
    if "keys" in frag:
        want = frag["keys"]
        for loose in (False, True):
            hits = []
            for i, r in enumerate(table):
                ok = True
                for k, v in want.items():
                    c = column(r, k)
                    if c is None or not (_same(r[c], v) or (loose and _slug_same(r[c], v))):
                        ok = False
                        break
                if ok:
                    hits.append(i)
            if hits:
                return hits
        return []
    return list(range(len(table)))


def _same(a: Any, b: str) -> bool:
    if str(a) == b:
        return True
    try:
        return float(a) == float(b.replace(",", ""))
    except (TypeError, ValueError):
        return False


def _slug_same(a: Any, b: str) -> bool:
    sb = R.value_slug(b)
    if isinstance(a, bool):
        a = "true" if a else "false"
    return bool(sb) and R.value_slug(a) == sb


def row_refs(q: dict[str, Any]) -> list[str]:
    """The ref of each output row, as a citation names it: by its key columns (`q3#day=2026-06-18`, a value with
    punctuation as its slug), or by its place (`q3#row=4`) when its keys do not tell it from another row."""
    table = q.get("table") or []
    qid = q.get("id") or "q0"
    if not table:
        return []
    keys = [k for k in q.get("keys") or [] if not str(k).startswith("_")]
    # the shortest run of the key columns, from the first, that tells a row from every other: refs stay short
    tups, seen = [], []
    for j in range(1, len(keys) + 1):
        t = [tuple(R.value_slug(r.get(k)) for k in keys[:j]) if all(k in r for k in keys[:j]) else None for r in table]
        tups.append(t)
        seen.append(Counter(x for x in t if x is not None))
    out = []
    for i, r in enumerate(table):
        done = False
        for j in range(len(keys)):
            t = tups[j][i]
            if t is not None and seen[j][t] == 1 and all(t):
                frag = "&".join(f"{R.ref_value(k)}={R.ref_value(r[k])}" for k in keys[:j + 1])
                if len(frag) <= 160:
                    out.append(f"{qid}#{frag}")
                    done = True
                break
        if not done:
            out.append(f"{qid}#row={i + 1}")
    return out


def cite_example(q: dict[str, Any]) -> str | None:
    """A citation of one value of a query's output, as Claude would write it."""
    table = q.get("table") or []
    if not table:
        return None
    r = table[0]
    keys = [k for k in q.get("keys") or [] if k in r]
    vals = [k for k in r if k not in keys and isinstance(r[k], (int, float)) and not isinstance(r[k], bool)]
    col = vals[0] if vals else None
    if col is None:
        return None
    v = r[col]
    shown = f"{v:,}" if isinstance(v, int) else (f"{v:,.2f}" if isinstance(v, float) else str(v))
    # a key value with a space or a bracket is written as its slug, so the citation stays one Markdown link
    return f"[{shown}]({row_refs(q)[0]}@{R.ref_value(col)})"
