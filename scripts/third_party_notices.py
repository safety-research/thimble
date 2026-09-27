#!/usr/bin/env python3
"""Write the THIRD_PARTY_NOTICES of a release zip; scripts/release.sh runs it for a zip that carries frontend/dist.

    python3 scripts/third_party_notices.py --out FILE [--root DIR]

    --out FILE     where the notices are written
    --root DIR     the tree whose frontend/package-lock.json and frontend/node_modules are read (default: this checkout)

The repository ships source only and needs no such file. The zip ships the built UI, which bundles code and fonts from
npm packages whose licenses (MIT, BSD, ISC, MPL-2.0, and the OFL of the fonts) ask for their notices to travel with
it. This lists every production entry of frontend/package-lock.json (the bundle holds code from a subset of them) with
its license and the license text it ships, read from frontend/node_modules, and then the notice of the UI's glyphs
that follow published icon sets (the /*! comment of frontend/src/components/Icon.tsx). The Python packages are not in
the zip (install.sh installs them with uv), so they are not listed.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LICENSE_FILE = re.compile(r"(?i)^(licen[sc]e|copying|ofl)([-._][\w.-]*)?$")  # LICENSE, license-mit, LICENSE-MIT.txt, OFL.txt
ICONS = Path("frontend") / "src" / "components" / "Icon.tsx"
KEPT_COMMENT = re.compile(r"^/\*!(.*?)\*/", re.S | re.M)  # one that opens a line


def npm_packages(root: Path) -> list[dict]:
    """The production packages of frontend/package-lock.json, one entry per name and version, sorted by name."""
    lock = json.loads((root / "frontend" / "package-lock.json").read_text())
    seen: dict[tuple[str, str], dict] = {}
    for key, meta in lock.get("packages", {}).items():
        if not key or meta.get("dev") or meta.get("link"):
            continue
        name = key.rsplit("node_modules/", 1)[-1]
        version = meta.get("version", "")
        if (name, version) in seen:
            continue
        seen[(name, version)] = {"name": name, "version": version, "license": meta.get("license") or "UNKNOWN",
                                 "dir": root / "frontend" / key}
    return sorted(seen.values(), key=lambda p: (p["name"].lower(), p["version"]))


def npm_details(pkg: dict) -> None:
    """Add the source URL and the license text a package ships, when node_modules holds it."""
    pkg["source"], pkg["text"] = "", ""
    manifest = pkg["dir"] / "package.json"
    if not manifest.is_file():
        return
    try:
        meta = json.loads(manifest.read_text())
    except (OSError, ValueError):
        return
    if meta.get("version") != pkg["version"]:
        return
    repo = meta.get("repository")
    url = repo.get("url", "") if isinstance(repo, dict) else repo or meta.get("homepage") or ""
    url = re.sub(r"^git\+", "", str(url))
    url = re.sub(r"^git://", "https://", url)
    url = re.sub(r"^(ssh://)?git@github\.com[:/]", "https://github.com/", url)
    url = re.sub(r"^github:", "https://github.com/", url)
    if re.fullmatch(r"[\w.-]+/[\w.-]+", url):
        url = "https://github.com/" + url
    pkg["source"] = re.sub(r"\.git$", "", url)
    files = sorted(f for f in pkg["dir"].iterdir() if f.is_file() and LICENSE_FILE.match(f.name))
    pkg["text"] = "\n\n".join(f.read_text(errors="replace").strip() for f in files)


def icon_notices(root: Path) -> list[str]:
    """The text of each /*! comment of Icon.tsx under `root`, without the comment's markers."""
    path = root / ICONS
    if not path.is_file():
        return []
    return ["\n".join(re.sub(r"^\s*\* ?", "", ln) for ln in m.group(1).strip().splitlines())
            for m in KEPT_COMMENT.finditer(path.read_text())]


def render(npm: list[dict], icons: list[str] | None = None) -> str:
    out = ["THIRD-PARTY NOTICES for the built UI of thimble (frontend/dist)", "",
           "Vite builds frontend/dist from thimble's own source and the npm packages below: the production dependencies",
           "recorded in frontend/package-lock.json (the bundle holds code from a subset of them). Each line gives the",
           "package, its version, its license and where its source is.", ""]
    counts: dict[str, int] = {}
    for p in npm:
        counts[p["license"]] = counts.get(p["license"], 0) + 1
    out += ["Licenses: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))), ""]
    mpl = [p for p in npm if "MPL" in p["license"]]
    if mpl:
        names = ", ".join(f"{p['name']} {p['version']}" for p in mpl)
        sources = sorted({p["source"] for p in mpl if p["source"]})
        out += textwrap.wrap(
            f"MPL-2.0: {names} are Covered Software under the Mozilla Public License 2.0 (https://mozilla.org/MPL/2.0/). "
            f"thimble uses them unmodified. Their source code is available from "
            f"{' and '.join(sources) or 'their repositories'} and in the npm packages of the versions named here.",
            width=110) + [""]
    out += ["Packages", "--------"]
    for p in npm:
        out.append(f"  {p['name']} {p['version']}  {p['license']}" + (f"  {p['source']}" if p["source"] else ""))
    groups: dict[str, list[dict]] = {}
    missing = []
    for p in npm:
        if p["text"]:
            groups.setdefault(re.sub(r"\s+", " ", p["text"]), []).append(p)
        else:
            missing.append(p)
    out += ["", "License texts", "-------------",
            "Each text below is the license file a package ships, followed by the packages it applies to."]
    if missing:
        out += ["The packages without a text here ship no license file; their license is the one named in the list:",
                "  " + ", ".join(f"{p['name']} {p['version']}" for p in missing)]
    for key, members in sorted(groups.items(), key=lambda kv: kv[1][0]["name"].lower()):
        out += ["", "-" * 100, "Applies to: " + ", ".join(f"{p['name']} {p['version']}" for p in members), "",
                members[0]["text"]]
    if icons:
        out += ["", "Icons", "-----", "Some of the UI's glyphs follow published icon sets (frontend/src/components/Icon.tsx):"]
        for text in icons:
            out += ["", text]
    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--root", type=Path, default=ROOT)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    root = a.root.resolve()
    npm = npm_packages(root)
    for p in npm:
        npm_details(p)
    a.out.write_text(render(npm, icon_notices(root)))
    print(f"{a.out}: {len(npm)} npm packages ({sum(1 for p in npm if p['text'])} with a license text)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
