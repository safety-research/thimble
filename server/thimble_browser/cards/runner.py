"""Runs one card's code and prints its outputs as JSON. The server starts this file in a sandbox (sandbox.py), one
process per run, so no state lasts between runs and a card's code is all it needs.

Input, one JSON object on stdin: {"code", "corpus", "workspace", "timeout"}.
Output, one JSON object on stdout: {"status": "ok" | "error", "outputs": [bundle, ...], "frame": {...} | null}.

A bundle is a dict of mime type to data, as a Jupyter kernel sends it, which the canvas draws unchanged:
- a table's last DataFrame as frames.FRAME_MIME (with its text for the model);
- an Altair chart or thimble.chart as Vega-Lite JSON;
- a matplotlib figure as SVG;
- thimble.diagram and thimble.timeline as their own mime types;
- stdout and stderr as text, and an error as ERROR_MIME.

Only this folder and the Python packages are imported: the runner never imports the server.
"""
from __future__ import annotations

import json
import os
import signal
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import frames  # noqa: E402

ERROR_MIME = "application/vnd.thimble.error+json"
PANDAS_COLWIDTH = 200


def error_bundle(ename: str, evalue: str, tb: list[str] | None = None) -> dict:
    return {ERROR_MIME: {"ename": ename, "evalue": evalue, "traceback": tb or []}}


class Run:
    def __init__(self) -> None:
        self.outputs: list[dict] = []
        self.streams: dict[str, list[str]] = {}
        self.errored = False
        self.result_index: int | None = None

    def flush(self) -> None:
        for name in ("stdout", "stderr"):
            parts = self.streams.pop(name, None)
            if parts:
                self.outputs.append({"text/plain": "".join(parts), "_stream": name})

    def display(self, data: dict) -> None:
        self.flush()
        self.outputs.append(dict(data))

    def result(self, data: dict) -> None:
        self.flush()
        self.result_index = len(self.outputs)
        self.outputs.append(dict(data))

    def error(self, etype: Any, evalue: Any, stb: list[str]) -> None:
        self.flush()
        name = getattr(etype, "__name__", None) or type(evalue).__name__
        self.outputs.append(error_bundle(str(name), str(evalue), list(stb or [])))
        self.errored = True


class Stream:
    def __init__(self, run: Run, name: str) -> None:
        self.run, self.name = run, name

    def write(self, text: Any) -> int:
        s = str(text)
        self.run.streams.setdefault(self.name, []).append(s)
        return len(s)

    def flush(self) -> None:
        pass

    def isatty(self) -> bool:
        return False


def shell_for(run: Run, workspace: str) -> Any:
    from IPython.core.displayhook import DisplayHook
    from IPython.core.displaypub import DisplayPublisher
    from IPython.core.interactiveshell import InteractiveShell
    from traitlets.config import Config

    class Publisher(DisplayPublisher):
        def publish(self, data: Any, metadata: Any = None, source: Any = None, *, transient: Any = None,
                    update: bool = False, **kwargs: Any) -> None:
            run.display(dict(data or {}))

        def clear_output(self, wait: bool = False) -> None:
            pass

    class Hook(DisplayHook):
        def start_displayhook(self) -> None:
            self._data: dict | None = None

        def write_output_prompt(self) -> None:
            pass

        def write_format_data(self, format_dict: Any, md_dict: Any = None) -> None:
            self._data = dict(format_dict or {})

        def finish_displayhook(self) -> None:
            if getattr(self, "_data", None):
                run.result(self._data)
            self._data = None

    cfg = Config()
    cfg.HistoryManager.enabled = False
    cfg.InlineBackend.figure_format = "svg"
    shell = InteractiveShell.instance(config=cfg, display_pub_class=Publisher, displayhook_class=Hook)
    shell._showtraceback = run.error
    setup = [
        "import altair as _alt; _alt.renderers.enable('mimetype'); del _alt",
        f"import pandas as _pd; _pd.set_option('display.max_colwidth', {PANDAS_COLWIDTH}); del _pd",
        "import IPython.core.pylabtools as _pt\n"
        "get_ipython().display_formatter.formatters['image/svg+xml'].for_type_by_name("
        "'matplotlib.figure', 'Figure', lambda fig, _pt=_pt: _pt.print_figure(fig, 'svg'))\n"
        "del _pt",
        "import sys, types\nm = types.ModuleType('thimble')\nm.__file__, m.WS = PATH, WS\n"
        "with open(PATH, encoding='utf-8') as f:\n    exec(compile(f.read(), PATH, 'exec'), m.__dict__)\n"
        "sys.modules['thimble'] = m\ndel m, f, types",
    ]
    shell.user_ns["PATH"] = str(HERE / "kernel_thimble.py")
    shell.user_ns["WS"] = workspace
    for line in setup:
        shell.run_cell(line, store_history=False, silent=True)
    for name in ("PATH", "WS"):
        shell.user_ns.pop(name, None)
    run.outputs.clear()
    run.errored = False
    return shell


def last_frame(shell: Any) -> dict | None:
    """The DataFrame the code ends in, as the canvas stores it, or None."""
    value = getattr(getattr(shell, "last_execution_result", None), "result", None)
    try:
        import pandas as pd
    except ImportError:
        return None
    if isinstance(value, pd.Series):
        value = value.to_frame()
    if not isinstance(value, pd.DataFrame):
        return None
    import thimble  # the module shell_for installed

    return frames.normalize(thimble._frame_json(value))


def main() -> int:
    req = json.loads(sys.stdin.read() or "{}")
    code = str(req.get("code") or "")
    corpus = str(req.get("corpus") or ".")
    workspace = str(req.get("workspace") or ".")
    timeout = float(req.get("timeout") or 60)
    os.environ.setdefault("MPLBACKEND", "Agg")
    os.environ.setdefault("MATPLOTLIBRC", str(HERE / "matplotlibrc"))
    os.chdir(corpus)
    real_out = sys.stdout
    run = Run()
    shell = shell_for(run, workspace)

    def on_alarm(signum: int, frame: Any) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGALRM, on_alarm)
    signal.setitimer(signal.ITIMER_REAL, timeout)
    timed_out = False
    sys.stdout, sys.stderr = Stream(run, "stdout"), Stream(run, "stderr")
    try:
        res = shell.run_cell(code, store_history=True, silent=False)
        ok = bool(res.success) and not run.errored
    except KeyboardInterrupt:
        timed_out, ok = True, False
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        sys.stdout, sys.stderr = real_out, sys.__stderr__
    run.flush()
    if timed_out or (run.errored and any("KeyboardInterrupt" in json.dumps(o.get(ERROR_MIME, {})) for o in run.outputs)):
        run.outputs = [o for o in run.outputs if ERROR_MIME not in o]
        run.outputs.append(error_bundle("TimeoutError", f"the code ran past {timeout:g} s and was stopped"))
        ok = False
    frame = None
    if ok:
        try:
            frame = last_frame(shell)
        except Exception as e:  # noqa: BLE001
            run.outputs.append({"text/plain": f"(the table could not be read: {type(e).__name__}: {e})", "_stream": "stderr"})
        if frame is not None and run.result_index is not None:
            run.outputs[run.result_index] = frames.bundle(frame)
    real_out.write(json.dumps({"status": "ok" if ok else "error", "outputs": run.outputs, "frame": frame},
                              default=str))
    real_out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
