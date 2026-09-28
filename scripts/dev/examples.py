"""Open the worked examples of custom views, each on its own sample with its sample labels on.

    backend/.venv/bin/python scripts/dev/examples.py <folder>

For each example in plugin/viewers that has a sample/, this copies the sample to <folder>/<example>, registers the copy
as a workspace, saves the example as a built view of it, and applies the labels its labels.json defines, turned on in
Files. The labels are regex labels, so no model is called. Run it in the environment of the stack it is for
(THIMBLE_HOME, THIMBLE_DATA_DIR, THIMBLE_WORKSPACES_DIR); a server already running picks the views and labels up.
"""
import asyncio
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from app import concepts, config, views

VIEW_KEYS = ("name", "why", "claims", "accepts", "declares", "default", "libs")


def save_view(name: str, src: Path) -> None:
    raw = json.loads((src / "view.json").read_text("utf-8"))
    v = views.write_view(name, name, reader=(src / "reader.py").read_text("utf-8"),
                         html=(src / "view.html").read_text("utf-8"), **{k: raw[k] for k in VIEW_KEYS})
    print(f"{name}: view {v['slug']} built={v['built']} ok={v['ok']}")


async def apply_labels(name: str, src: Path) -> None:
    ws = config.workspace_dir(name)
    for spec in json.loads((src / "labels.json").read_text("utf-8")) if (src / "labels.json").is_file() else []:
        fields = {"kind": spec["kind"], "spec": spec["spec"], "labels": spec["labels"], "shown": True}
        k = concepts.find_concept(ws, spec["name"])
        if k is None:
            k = concepts.new_concept(spec["name"], **fields)
        else:
            k.update(fields)
        concepts.write_concept(ws, concepts.coloured(ws, k))
        await concepts.start_apply(name, k["id"], spec["paths"])
        done = await concepts.wait_apply(name, k["id"], float("inf"))
        print(f"{name}: label {spec['name']!r} {done.get('counts') or done.get('label_stats', {}).get('counts')}")


async def main(folder: Path) -> None:
    try:
        for src in sorted(p for p in views.EXAMPLES_DIR.iterdir() if (p / "sample").is_dir()):
            dst = folder / src.name
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(src / "sample", dst)
            c = config.register_corpus(dst)["name"]
            save_view(c, src)
            await apply_labels(c, src)
    finally:
        concepts._pool_shutdown()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    asyncio.run(main(Path(sys.argv[1]).resolve()))
