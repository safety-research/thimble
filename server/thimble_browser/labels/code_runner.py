"""Runs a code label's `label(unit)` over a list of units and prints the values as JSON. The server starts this file in
the sandbox (cards/sandbox.py run_script), as it does a card's code, so the label's code reads the folder and nothing
else. It imports only the standard library and never the server.

Input, one JSON object on stdin: {"code", "units": [unit, ...], "timeout"}.
Output, one JSON object on stdout: {"rows": [[i, value, confidence, spans] or [i, null, null, null, error], ...],
"error": why the code could not run, or null}.

`label(unit)` returns a value, (value, confidence), (value, confidence, spans) or {label, confidence, spans}; None
leaves the unit without a value.
"""
import io
import json
import signal
import sys
import traceback


def _parse(out):
    spans = None
    if isinstance(out, dict):
        value, conf, spans = out.get("label", out.get("value")), out.get("confidence", 1.0), out.get("spans")
    elif isinstance(out, (tuple, list)):
        value = out[0] if out else None
        conf = out[1] if len(out) > 1 else 1.0
        spans = out[2] if len(out) > 2 else None
    else:
        value, conf = out, 1.0
    try:
        conf = max(0.0, min(1.0, float(conf)))
    except (TypeError, ValueError):
        conf = 1.0
    if isinstance(spans, (list, tuple)):
        spans = [str(x) for x in spans if isinstance(x, str)][:16]
    else:
        spans = None
    return value, conf, spans


def main():
    req = json.loads(sys.stdin.read() or "{}")
    real_out = sys.stdout
    sys.stdout = sys.stderr = io.StringIO()  # what the code prints is not the answer

    def done(obj):
        real_out.write(json.dumps(obj, default=str))
        real_out.flush()

    def on_alarm(signum, frame):
        raise TimeoutError(f"the label's code ran past {req.get('timeout', 60):g} s")

    signal.signal(signal.SIGALRM, on_alarm)
    signal.setitimer(signal.ITIMER_REAL, float(req.get("timeout") or 60))
    ns = {"__name__": "__thimble_label__"}
    try:
        exec(compile(str(req.get("code") or ""), "<label>", "exec"), ns)
    except BaseException as e:  # noqa: BLE001
        return done({"rows": [], "error": f"{type(e).__name__}: {e}"})
    fn = ns.get("label")
    if not callable(fn):
        return done({"rows": [], "error": "the code defines no function label(unit)"})
    rows = []
    try:
        for i, unit in enumerate(req.get("units") or []):
            try:
                value, conf, spans = _parse(fn(unit))
            except TimeoutError:
                raise
            except Exception as e:  # noqa: BLE001
                tb = traceback.extract_tb(e.__traceback__)
                where = next((f" (line {f.lineno})" for f in reversed(tb) if f.filename == "<label>"), "")
                rows.append([i, None, None, None, f"{type(e).__name__}: {e}{where}"[:300]])
                continue
            if value is None:
                continue
            rows.append([i, value, conf, spans])
    except TimeoutError as e:
        signal.setitimer(signal.ITIMER_REAL, 0)
        return done({"rows": rows, "error": str(e)})
    signal.setitimer(signal.ITIMER_REAL, 0)
    done({"rows": rows, "error": None})


if __name__ == "__main__":
    main()
