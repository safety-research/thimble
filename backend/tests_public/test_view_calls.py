"""app.view_calls: the kernels that answer view readers. A slow call holds up only itself, a call has no time limit, a
cancelled call interrupts its kernel, a page's call reports its progress, and a kernel keeps a bounded set of indexes.

The kernels are faked: view_calls._exec runs the reader's code in a thread of this process, as the `inproc` runner of
test_views does on the loop, so a slow reader leaves the loop free; _interrupt raises KeyboardInterrupt in that code at
its next step, as SIGINT does in a kernel."""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest

from app import config, view_calls, view_host, views

CORPUS = "boards"

READER = '''
import json, time
import thimble


def build_index(paths):
    out = []
    for p in paths:
        with open(p) as f:
            out += [json.loads(line) for line in f]
    return out


def records(index, query):
    query = query or {}
    steps = int(query.get("steps") or 0)
    for i in range(steps):
        thimble.progress(i, steps, "counting")
        time.sleep(0.05)
    return {"n": len(index), "steps": steps}


def resolve(index, locator):
    return None
'''

HTML = "<!doctype html><html><body><script>thimble.onOpen(() => thimble.fetch({}))</script></body></html>"


class FakeKernels:
    """The pool's kernel functions, in this process: each kernel name runs one call at a time, in a thread."""

    def __init__(self, monkeypatch) -> None:
        self.started: list[str] = []
        self.ran: list[tuple[str, float]] = []  # (kernel, timeout) per call
        self.interrupted: list[str] = []
        self.stopped: list[str] = []
        self.flags: dict[str, threading.Event] = {}
        self.locks: dict[str, threading.Lock] = {}
        monkeypatch.setattr(view_calls, "_exec", self.exec)
        monkeypatch.setattr(view_calls, "_start", self.start)
        monkeypatch.setattr(view_calls, "_interrupt", self.interrupt)
        monkeypatch.setattr(view_calls, "_stop", self.stop)
        monkeypatch.setattr(view_calls, "_rss", lambda c, name: 0)

    async def start(self, c: str, name: str) -> None:
        self.started.append(name)

    async def exec(self, c: str, name: str, code: str, timeout: float) -> tuple[list[dict], str]:
        self.ran.append((name, timeout))
        flag = self.flags.setdefault(name, threading.Event())
        lock = self.locks.setdefault(name, threading.Lock())
        run = asyncio.ensure_future(asyncio.to_thread(self._run, c, code, flag, lock))
        try:
            return await asyncio.wait_for(asyncio.shield(run), timeout)
        except asyncio.TimeoutError:  # as notebook._execute does at its limit: an interrupt, and the limit's error
            self.interrupt(c, name)
            return [{"application/vnd.thimble.error+json": {"ename": "TimeoutError", "evalue": "past its limit"}}], "error"

    def _run(self, c: str, code: str, flag: threading.Event, lock: threading.Lock) -> tuple[list[dict], str]:
        with lock:  # a kernel runs one request at a time, a cancelled one to its end
            flag.clear()
            return self._run_one(c, code, flag)

    def _run_one(self, c: str, code: str, flag: threading.Event) -> tuple[list[dict], str]:
        buf = _OUT.start()
        tracer = _Interruptible(flag)
        code = code.replace("import sys as _s", f"import sys as _s, os as _os\n_os.chdir({str(config.corpus_dir(c))!r})", 1)
        try:
            sys.stdout = _OUT  # pytest puts its own back at each phase
            sys.settrace(tracer)
            exec(code, {})  # noqa: S102 — the snippet a reader kernel runs
        except KeyboardInterrupt:
            return [{"application/vnd.thimble.error+json": {"ename": "KeyboardInterrupt", "evalue": ""}}], "error"
        finally:
            sys.settrace(None)
            _OUT.stop()
        return [{"text/plain": buf.getvalue(), "_stream": "stdout"}], "ok"

    def interrupt(self, c: str, name: str) -> None:
        self.interrupted.append(name)
        self.flags.setdefault(name, threading.Event()).set()

    async def stop(self, c: str, name: str) -> None:
        self.stopped.append(name)


class _ThreadOut(io.TextIOBase):
    """sys.stdout while the fake kernels run: each thread's writes go to its own buffer."""

    def __init__(self) -> None:
        self.bufs: dict[int, io.StringIO] = {}
        self.real = None

    def start(self) -> io.StringIO:
        buf = self.bufs[threading.get_ident()] = io.StringIO()
        return buf

    def stop(self) -> None:
        self.bufs.pop(threading.get_ident(), None)

    def write(self, s: str) -> int:
        buf = self.bufs.get(threading.get_ident())
        return buf.write(s) if buf is not None else len(s)


_OUT = _ThreadOut()


class _Interruptible:
    """A trace function that raises KeyboardInterrupt once `flag` is set, as SIGINT interrupts a kernel's code."""

    def __init__(self, flag: threading.Event) -> None:
        self.flag = flag

    def __call__(self, frame, event, arg):
        if self.flag.is_set():
            self.flag.clear()
            raise KeyboardInterrupt
        return self


@pytest.fixture()
def data(tmp_path, monkeypatch) -> Path:
    d = tmp_path / "data"
    corpus = d / CORPUS
    corpus.mkdir(parents=True)
    (corpus / "manifest.json").write_text(json.dumps({"name": CORPUS, "description": "a message board"}))
    (corpus / "board.jsonl").write_text("".join(json.dumps({"n": i}) + "\n" for i in range(5)))
    (corpus / "other.jsonl").write_text("".join(json.dumps({"n": i}) + "\n" for i in range(3)))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    return d


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    for d in (view_calls._pools, view_calls._affinity, view_calls._calls, view_calls._cancelled):
        d.clear()
    views._memo.clear()
    views._ready.clear()
    views._mirrored.clear()
    monkeypatch.setattr(views, "_runner", view_calls.execute)
    monkeypatch.setattr(views, "FOLDER_CACHE_S", 0.0)
    views._folder_cache.clear()
    sys.modules.pop("_thimble_views", None)
    yield
    for d in (view_calls._pools, view_calls._affinity, view_calls._calls, view_calls._cancelled):
        d.clear()
    sys.modules.pop("_thimble_views", None)


@pytest.fixture()
def kernels(monkeypatch) -> FakeKernels:
    from app import notebook  # noqa: PLC0415

    monkeypatch.setattr(notebook, "scratch_dir", lambda *a, **k: None)
    return FakeKernels(monkeypatch)


@pytest.fixture()
def ws(data, workspaces_tmp) -> Path:
    for slug, claims in (("count", ["board.jsonl"]), ("other", ["other.jsonl"])):
        views.write_view(CORPUS, slug, name=slug.title(), description="Counts the records.", claims=claims,
                         reader=READER, html=HTML)
    return config.workspace_dir(CORPUS)


async def test_a_slow_call_holds_up_no_other_view_and_has_no_time_limit(ws, kernels):
    slow = asyncio.create_task(views.reader_call(CORPUS, "count", "records", {"steps": 40}))
    await asyncio.sleep(0.3)
    t0 = time.monotonic()
    fast = await views.reader_call(CORPUS, "other", "records", {})
    assert fast == {"n": 3, "steps": 0}
    assert time.monotonic() - t0 < 1.5, "the other view's call did not wait for the slow one"
    assert not slow.done()
    assert await slow == {"n": 5, "steps": 40}
    names = {name for name, _ in kernels.ran}
    assert names == {"views", "views-2"}, "each call ran on a kernel of its own"
    assert all(t >= view_calls.NO_LIMIT_S for _, t in kernels.ran), "no call has a time limit"


async def test_a_small_index_is_answered_beside_its_own_busy_kernel_and_a_large_one_waits(ws, kernels, monkeypatch):
    await views.reader_call(CORPUS, "count", "records", {})  # builds and pickles the index on `views`
    slow = asyncio.create_task(views.reader_call(CORPUS, "count", "records", {"steps": 30}))
    await asyncio.sleep(0.2)
    t0 = time.monotonic()
    assert await views.reader_call(CORPUS, "count", "records", {}) == {"n": 5, "steps": 0}
    assert time.monotonic() - t0 < 1.0, "a small index loads on a second kernel"
    await slow

    monkeypatch.setattr(view_calls, "SMALL_INDEX", 0)  # every index now counts as large
    view_calls._pools.clear()
    view_calls._affinity.clear()
    await views.reader_call(CORPUS, "count", "records", {})
    kernels.ran.clear()
    slow = asyncio.create_task(views.reader_call(CORPUS, "count", "records", {"steps": 20}))
    await asyncio.sleep(0.2)
    second = await views.reader_call(CORPUS, "count", "records", {})
    assert slow.done(), "a large index's second call waited for the kernel that holds it"
    assert second["n"] == 5
    assert {name for name, _ in kernels.ran} == {"views"}


APPLIES = """
def applies(paths):
    return {"claims": list(paths), "found": len(paths)}


def build_index(paths):
    return []


def records(index, query):
    return None


def resolve(index, locator):
    return None
"""


async def test_a_call_that_needs_no_index_runs_beside_a_busy_kernel(ws, kernels, tmp_path):
    reader = tmp_path / "reader.py"
    reader.write_text(APPLIES)
    req = {"slug": "builtin-tally", "reader": str(reader), "fp": "applies", "paths": [], "cache": None,
           "thimble": str(views.KERNEL_THIMBLE)}
    assert (await views._call(CORPUS, req, "applies", ["a.jsonl"]))["found"] == 1
    slow = asyncio.create_task(views.reader_call(CORPUS, "count", "records", {"steps": 40}))
    await asyncio.sleep(0.2)
    assert [w.busy for w in view_calls._pools[CORPUS]] == [True], "the slow call holds the kernel applies ran on"
    t0 = time.monotonic()
    assert (await views._call(CORPUS, req, "applies", ["a.jsonl", "b.jsonl"]))["found"] == 2
    assert time.monotonic() - t0 < 1.0 and not slow.done(), "applies did not wait for the slow call"
    await slow


async def test_a_page_s_cancel_that_comes_before_its_call_refuses_the_call(ws, kernels):
    from app.main import app  # noqa: PLC0415

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1") as client:
        base = f"/api/ws/{CORPUS}/views/count"
        assert (await client.post(f"{base}/calls/page-7/cancel")).json() == {"cancelled": False}
        r = await client.post(f"{base}/records", json={"query": {"steps": 2}, "call": "page-7"})
        assert r.status_code == 409 and r.json()["detail"]["cancelled"] is True
        assert kernels.ran == [], "the cancelled call never ran"
        r = await client.post(f"{base}/records", json={"query": {"steps": 2}, "call": "page-7"})
        assert r.status_code == 200, "the cancel refuses one call"


async def test_a_workspace_s_kernels_shut_down_elsewhere_are_forgotten(ws, kernels, monkeypatch):
    from app import notebook  # noqa: PLC0415

    async def shut(workspace, kernel=None):
        return None

    monkeypatch.setattr(notebook, "shutdown_kernel", shut)
    await views.reader_call(CORPUS, "count", "records", {})
    assert [w.name for w in view_calls._pools[CORPUS]] == ["views"]
    await notebook.shutdown_workspace(CORPUS)
    assert CORPUS not in view_calls._pools and not any(k[0] == CORPUS for k in view_calls._affinity)


async def test_cancelling_a_call_interrupts_its_kernel_which_settles_before_its_next_call(ws, kernels):
    slow = asyncio.create_task(views.reader_call(CORPUS, "count", "records", {"steps": 200}))
    await asyncio.sleep(0.3)
    slow.cancel()
    with pytest.raises(asyncio.CancelledError):
        await slow
    assert kernels.interrupted == ["views"]
    for _ in range(50):
        if not any(w.busy for w in view_calls._pools[CORPUS]):
            break
        await asyncio.sleep(0.05)
    assert [w.busy for w in view_calls._pools[CORPUS]] == [False], "the kernel is free once its interrupted call stopped"
    assert kernels.ran[-1] == ("views", view_calls.DRAIN_S), "the drain waits at most DRAIN_S"
    assert kernels.stopped == [], "a kernel that stopped at the interrupt is kept"
    assert await views.reader_call(CORPUS, "count", "records", {}) == {"n": 5, "steps": 0}


async def test_a_page_names_its_call_reads_its_progress_and_cancels_it(ws, kernels):
    from app.main import app  # noqa: PLC0415

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1") as client:
        base = f"/api/ws/{CORPUS}/views/count"
        got = await client.post(f"{base}/records", json={"query": {"steps": 2}, "call": "page-1"})
        assert got.status_code == 200 and got.json()["data"] == {"n": 5, "steps": 2}
        assert (await client.get(f"{base}/calls/page-1")).json() == {"running": False}

        slow = asyncio.create_task(client.post(f"{base}/records", json={"query": {"steps": 200}, "call": "page-2"}))
        seen = {}
        for _ in range(60):
            await asyncio.sleep(0.05)
            seen = (await client.get(f"{base}/calls/page-2")).json()
            if seen.get("done"):
                break
        assert seen["running"] is True and seen["phase"] == "call" and seen["total"] == 200 and seen["note"] == "counting"
        assert 0 < seen["done"] < 200 and seen["seconds"] > 0
        assert (await client.post(f"{base}/calls/page-2/cancel")).json() == {"cancelled": True}
        r = await slow
        assert r.status_code == 409 and r.json()["detail"]["cancelled"] is True
        assert kernels.interrupted == ["views"]
        assert (await client.post(f"{base}/calls/page-2/cancel")).json() == {"cancelled": False}
        progress = view_calls.progress_path(views.indexes_dir(CORPUS), "page-2")
        assert not progress.exists(), "a call's progress file goes when it ends"


async def test_a_request_the_page_drops_cancels_its_call(ws, kernels):
    from app.main import app  # noqa: PLC0415

    body = json.dumps({"query": {"steps": 200}}).encode()
    sent = []
    t0 = time.monotonic()

    async def receive():
        if not sent:
            sent.append(True)
            return {"type": "http.request", "body": body, "more_body": False}
        await asyncio.sleep(0.4)  # the page reloads while the call runs
        return {"type": "http.disconnect"}

    out: list[dict] = []

    async def send(message):
        out.append(message)

    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "scheme": "http",
             "path": f"/api/ws/{CORPUS}/views/count/records", "raw_path": b"", "query_string": b"",
             "headers": [(b"host", b"127.0.0.1"), (b"content-type", b"application/json")],
             "client": ("127.0.0.1", 5000), "server": ("127.0.0.1", 80), "root_path": ""}
    await app(scope, receive, send)
    assert time.monotonic() - t0 < 5, "the call stopped when the page dropped it, not after its 200 steps"
    assert kernels.interrupted == ["views"]
    assert next(m for m in out if m["type"] == "http.response.start")["status"] == 409


async def test_a_check_s_reader_call_has_a_limit_and_its_kernel_settles_after_it(ws, kernels, monkeypatch):
    seen = []

    async def body(c, slug, locators, *, shot_dir, picture):
        seen.append(views._call_limit.get())
        try:
            await views.reader_call(c, slug, "records", {"steps": 400})
        except views.ReaderError as e:
            return {"ok": False, "problems": [e.message]}
        return {"ok": True}

    monkeypatch.setattr(views, "CHECK_CALL_S", 0.5)
    monkeypatch.setattr(views, "_gate", body)
    got = await views.gate(CORPUS, "count")
    assert seen == [0.5] and got["ok"] is False and "TimeoutError" in got["problems"][0]
    assert views._call_limit.get() is None, "a page's calls outside the gate have no limit"
    for _ in range(50):
        if not any(w.busy for w in view_calls._pools[CORPUS]):
            break
        await asyncio.sleep(0.05)
    assert kernels.interrupted == ["views"] and kernels.ran[-1] == ("views", view_calls.DRAIN_S)
    assert await views.reader_call(CORPUS, "count", "records", {}) == {"n": 5, "steps": 0}


def test_a_kernel_keeps_the_indexes_it_used_last_within_its_memory():
    view_host._indexes.clear()
    view_host._sizes.clear()
    for i, slug in enumerate(("a", "b", "c")):
        key = (slug, "fp")
        view_host._indexes[key] = object()
        view_host._sizes[key] = 100
    view_host._indexes.move_to_end(("a", "fp"))
    dropped = view_host._evict(("a", "fp"), 250)
    assert dropped == ["b/fp"], "the least recently used index goes first"
    assert list(view_host._indexes) == [("c", "fp"), ("a", "fp")]
    assert view_host._evict(("c", "fp"), 10) == ["a/fp"], "the index in use stays, even over the budget"
    view_host._indexes[("c", "fp2")] = object()
    view_host._indexes[("c", "fp3")] = object()
    assert view_host._evict(("c", "fp3"), None) == ["c/fp"], "a view keeps INDEXES_PER_VIEW indexes"
    view_host._indexes.clear()
    view_host._sizes.clear()


def _taken(name: str) -> int:
    """A kernel's resident size that is just what its indexes take."""
    w = next(w for w in view_calls._pools[CORPUS] if w.name == name)
    return view_calls.KERNEL_BASE + sum(w.holds.values())


async def test_a_kernel_above_its_memory_that_holds_several_indexes_is_restarted(ws, kernels, monkeypatch):
    monkeypatch.setattr(view_calls, "_rss", lambda c, name: _taken(name))
    monkeypatch.setattr(view_calls, "rss_max", lambda: 1024)
    await views.reader_call(CORPUS, "count", "records", {})
    assert kernels.stopped == [], "one index alone is kept when the kernel's memory is what it takes, however large"
    await views.reader_call(CORPUS, "other", "records", {})
    for _ in range(20):
        if kernels.stopped:
            break
        await asyncio.sleep(0.05)
    assert kernels.stopped == ["views"]
    assert view_calls._pools[CORPUS] == []


async def test_a_kernel_far_above_what_its_one_index_takes_is_restarted(ws, kernels, monkeypatch):
    """Building an index or answering a call can leave a kernel holding gigabytes its index does not need, which the
    system never gets back: once free it is restarted, and its index is loaded again from the pickle."""
    monkeypatch.setattr(view_calls, "_rss", lambda c, name: 10 * 1024**3)
    monkeypatch.setattr(view_calls, "rss_max", lambda: 1024**3)
    assert await views.reader_call(CORPUS, "count", "records", {}) == {"n": 5, "steps": 0}
    for _ in range(20):
        if kernels.stopped:
            break
        await asyncio.sleep(0.05)
    assert kernels.stopped == ["views"]
    assert await views.reader_call(CORPUS, "count", "records", {}) == {"n": 5, "steps": 0}


def _answer(held: list, **more) -> list[dict]:
    from app.view_host import SENTINEL  # noqa: PLC0415

    return [{"_stream": "stdout", "text/plain": SENTINEL + json.dumps({"ok": True, "held": held, **more}) + "\n"}]


def test_a_kernel_holding_an_index_with_no_pickle_is_not_restarted(monkeypatch):
    """An index that does not pickle would be built again from the corpus after a restart, which can take far longer
    than the memory is worth."""
    monkeypatch.setattr(view_calls, "_rss", lambda c, name: 10 * 1024**3)
    monkeypatch.setattr(view_calls, "rss_max", lambda: 1024**3)
    w = view_calls.Worker(CORPUS, "views")
    view_calls._note_answer(w, _answer([["count", "fp", 1000]], unpickled=True))
    assert not w.restart and w.unpickled
    view_calls._note_answer(w, _answer([["count", "fp", 1000]]))
    assert w.restart


def test_the_kernels_memory_limits_stay_within_bounds_on_any_machine(monkeypatch):
    """The limits are shares of the machine's memory, so a laptop keeps room for everything else, and fixed bounds keep
    a machine with hundreds of gigabytes from letting the views' kernels take tens of them."""
    gb = 1024**3
    for env in ("THIMBLE_VIEW_MEMORY_MB", "THIMBLE_VIEW_RSS_MB", "THIMBLE_VIEW_TOTAL_RSS_MB"):
        monkeypatch.delenv(env, raising=False)
    for phys, want in ((16 * gb, (1 * gb, 2 * gb, 4 * gb)), (256 * gb, (2 * gb, 6 * gb, 12 * gb)),
                       (4 * gb, (256 * 1024**2, 1 * gb, 2 * gb))):
        monkeypatch.setattr(view_calls, "physical_memory", lambda phys=phys: phys)
        assert (view_calls.memory_budget(), view_calls.rss_max(), view_calls.total_rss_max()) == want, phys
    monkeypatch.setenv("THIMBLE_VIEW_RSS_MB", "20000")
    assert view_calls.rss_max() == 20000 * 1024**2


def test_a_wrapped_kernels_memory_is_its_python_process(monkeypatch):
    """Under the sandbox the process thimble starts is the wrapper, a few megabytes; the memory that matters is the
    kernel's process inside it."""
    import subprocess  # noqa: PLC0415

    from app import notebook, procs  # noqa: PLC0415

    if not procs.HAVE_PROC:
        pytest.skip("reads /proc")
    child = "x = bytearray(120 * 1024 * 1024); import time; time.sleep(30)"
    wrapper = subprocess.Popen(["/bin/sh", "-c", f'"{sys.executable}" -c "{child}" & wait'])
    kernel = type("K", (), {"pid": wrapper.pid})()
    notebook._exec_kernels[(CORPUS, "views")] = kernel
    try:
        got = 0
        for _ in range(100):
            view_calls._inner.pop(wrapper.pid, None)
            got = view_calls._rss(CORPUS, "views")
            if got > 100 * 1024**2:
                break
            time.sleep(0.05)
        assert got > 100 * 1024**2 > procs.rss(wrapper.pid)
    finally:
        notebook._exec_kernels.pop((CORPUS, "views"), None)
        for pid in procs.descendants(wrapper.pid):
            with contextlib.suppress(OSError):
                os.kill(pid, 9)
        wrapper.kill()
        wrapper.wait()


def test_an_index_counts_what_loading_it_took_and_says_when_it_has_no_pickle(tmp_path, monkeypatch):
    """A kernel's budget counts an index by the memory it took, at least its pickle's size, and an index that does
    not pickle is named, so the pool never restarts the kernel that holds it."""
    reader = tmp_path / "reader.py"
    reader.write_text("def build_index(paths):\n    return {'f': (lambda: 1) if paths else 1, 'big': list(range(10))}\n"
                      "def records(index, query):\n    return 1\n"
                      "def resolve(index, locator):\n    return None\n")
    steps = iter([100, 100, 100 + 50 * 1024**2, 100 + 50 * 1024**2, 200, 200, 200, 200])  # call, before, after, end
    monkeypatch.setattr(view_host, "_rss", lambda: next(steps))
    view_host._indexes.clear()
    view_host._sizes.clear()
    view_host._unpickled.clear()
    try:
        out = view_host.answer({"slug": "s", "reader": str(reader), "fp": "a", "paths": ["x"],
                                "cache": str(tmp_path / "a.pickle"), "op": "records"})
        assert out["ok"] and out["unpickled"] is True and out["held"] == [["s", "a", 50 * 1024**2]]
        out = view_host.answer({"slug": "t", "reader": str(reader), "fp": "b", "paths": [],
                                "cache": str(tmp_path / "b.pickle"), "op": "records"})
        assert out["ok"] and (tmp_path / "b.pickle").is_file()
        assert out["held"][-1] == ["t", "b", (tmp_path / "b.pickle").stat().st_size], "at least the pickle's size"
    finally:
        view_host._indexes.clear()
        view_host._sizes.clear()
        view_host._unpickled.clear()


async def test_deleting_a_view_lets_go_of_the_kernel_that_holds_its_index(ws, kernels):
    await views.reader_call(CORPUS, "count", "records", {})
    assert [w.name for w in view_calls._pools[CORPUS]] == ["views"]
    views.delete_view(CORPUS, "count")
    for _ in range(20):
        if kernels.stopped:
            break
        await asyncio.sleep(0.05)
    assert kernels.stopped == ["views"] and view_calls._pools[CORPUS] == []
    assert await views.reader_call(CORPUS, "other", "records", {}) == {"n": 3, "steps": 0}
