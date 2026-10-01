"""Open the corpus copy as a workspace and save the fixture view in it, for the end-to-end test (scripts/e2e_release.sh).

    <tree>/backend/.venv/bin/python scripts/e2e/workspace.py <tree> <corpus folder>

Registers the folder with the running server (POST /api/corpora/register, signed as the CLI signs it), saves
fixture-view/ as a built view of the workspace (views.write_view, as scripts/dev/examples.py saves the worked examples),
creates a regex label over the JSONL files and applies it through the server's API (no model runs), does the same for a
label on each file that is not read by lines (ANY_FILE: a CSV, a PDF, a SQLite database) and asks for the refs of the
records it matched, and prints one JSON line: {name, url, dir (the workspace's folder), view: {slug, ok, error?},
label: {name, ok, counts?, error?}, any_file: [{kind, path, name, ok, refs?, counts?, error?}]}. Run it in the
environment (THIMBLE_HOME, THIMBLE_PORT) the server runs in.
"""
import inspect
import json
import sys
from pathlib import Path

tree, corpus = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
sys.path.insert(0, str(tree / "backend"))

from app import cli, config, views  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixture-view"
SLUG = "record-counts"
LABEL = {"name": "Mentions forge", "kind": "regex", "spec": r"(?i)\bforge\b", "labels": ["forge", "other"],
         "shown": True, "glob": "*.jsonl"}
ANY_FILE = [("CSV rows", "exports/chat-export.csv", r"(?i)\bfilter\b"),
            ("PDF pages", "docs/e2e-sample.pdf", r"Second page"),
            ("SQLite rows", "exports/chat.db", r"(?i)\bfilter\b")]


def save_view(name: str) -> dict:
    raw = json.loads((FIXTURE / "view.json").read_text("utf-8"))
    params = inspect.signature(views.write_view).parameters
    fields = {k: v for k, v in raw.items() if k in params}
    if "claims" in raw and "claims" not in params and "scope" in params:
        fields["scope"] = raw["claims"]
    v = views.write_view(name, SLUG, reader=(FIXTURE / "reader.py").read_text("utf-8"),
                         html=(FIXTURE / "view.html").read_text("utf-8"), **fields)
    return {"slug": v.get("slug", SLUG), "ok": bool(v.get("ok", True))}


def apply_label(name: str) -> dict:
    base = f"{cli.api_url()}/api/ws/{name}/concepts"
    status, body = cli._request("POST", base, LABEL)
    if status not in (200, 201) or not isinstance(body, dict) or not body.get("id"):
        return {"name": LABEL["name"], "ok": False, "error": f"create → {status} {str(body)[:200]}"}
    status, run = cli._request("POST", f"{base}/{body['id']}/apply", {"paths": [LABEL["glob"]], "wait": True}, timeout=120)
    if status not in (200, 201, 202):
        return {"name": LABEL["name"], "ok": False, "error": f"apply → {status} {str(run)[:200]}"}
    counts = run.get("counts") if isinstance(run, dict) else None
    return {"name": LABEL["name"], "ok": True, "counts": counts}


def any_file_label(name: str, kind: str, path: str, spec: str) -> dict:
    out = {"kind": kind, "path": path, "name": f"Finds {kind}", "ok": False}
    base = f"{cli.api_url()}/api/ws/{name}/concepts"
    body = {"name": out["name"], "kind": "regex", "spec": spec, "labels": ["hit", "other"], "shown": kind == "CSV rows",
            "glob": path}
    status, made = cli._request("POST", base, body)
    if status not in (200, 201) or not isinstance(made, dict) or not made.get("id"):
        return {**out, "error": f"create → {status} {str(made)[:200]}"}
    status, run = cli._request("POST", f"{base}/{made['id']}/apply", {"paths": [path], "wait": True}, timeout=120)
    if status not in (200, 201, 202):
        return {**out, "error": f"apply → {status} {str(run)[:200]}"}
    status, rows = cli._request("GET", f"{base}/{made['id']}/rows?value=hit&limit=10")
    if status != 200 or not isinstance(rows, dict):
        return {**out, "error": f"rows → {status} {str(rows)[:200]}"}
    refs = [str(r.get("ref")) for r in rows.get("rows") or []]
    return {**out, "ok": True, "refs": refs, "counts": run.get("counts") if isinstance(run, dict) else None}


def main() -> int:
    status, body = cli._request("POST", f"{cli.api_url()}/api/corpora/register", {"path": str(corpus)})
    if status not in (200, 201) or not isinstance(body, dict) or not body.get("name"):
        print(f"workspace.py: register {corpus} → {status} {str(body)[:300]}", file=sys.stderr)
        return 1
    name = str(body["name"])
    try:
        view = save_view(name)
    except Exception as e:  # noqa: BLE001 — the view step reports it; the workspace stands without the view
        view = {"slug": SLUG, "ok": False, "error": f"{type(e).__name__}: {e}"}
    try:
        label = apply_label(name)
    except Exception as e:  # noqa: BLE001 — the labels step reports it
        label = {"name": LABEL["name"], "ok": False, "error": f"{type(e).__name__}: {e}"}
    any_file = []
    for kind, path, spec in ANY_FILE:
        try:
            any_file.append(any_file_label(name, kind, path, spec))
        except Exception as e:  # noqa: BLE001 — the labels-any-file step reports it
            any_file.append({"kind": kind, "path": path, "ok": False, "error": f"{type(e).__name__}: {e}"})
    print(json.dumps({"name": name, "url": cli.ui_url(name), "dir": str(config.workspace_dir(name)), "view": view,
                      "label": label, "any_file": any_file}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
