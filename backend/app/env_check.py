"""Whether a Python environment holds what the backend needs: the Python version and each dependency pyproject.toml names,
at a version it allows, followed through the requirements of every package installed for them (the extras named
included). install.sh --python runs this file with the environment's own python before it uses that environment, and
the doctor reads it for the running server.

Standard library only, plus `packaging` from the environment checked, which the backend needs too (matplotlib requires it).
"""
from __future__ import annotations

import importlib.metadata as md
import platform
import re
import sys
import tomllib
from pathlib import Path

PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"


def requirements(pyproject: Path = PYPROJECT, extras: tuple[str, ...] = ()) -> tuple[str, list[str]]:
    """pyproject's requires-python and its dependencies, with those of `extras`."""
    project = tomllib.loads(pyproject.read_text("utf-8"))["project"]
    optional = project.get("optional-dependencies", {})
    return project.get("requires-python", ""), [*project.get("dependencies", []), *(r for e in extras for r in optional.get(e, []))]


def missing(pyproject: Path = PYPROJECT, extras: tuple[str, ...] = ()) -> list[str]:
    """What this interpreter's environment lacks of pyproject's requirements, one phrase each: `Python >=3.12 (found
    3.11.4)`, `name (not installed)`, `name>=1.2 (found 1.1)`."""
    python, reqs = requirements(pyproject, extras)
    try:
        from packaging.requirements import Requirement
        from packaging.specifiers import SpecifierSet
        from packaging.utils import canonicalize_name
    except ImportError:  # without it no version can be compared: the dependencies not installed at all, by name
        names = [re.match(r"[A-Za-z0-9._-]+", r).group(0) for r in ("packaging", *reqs)]
        return sorted(f"{n} (not installed)" for n in names if not _installed(n))
    out: set[str] = set()
    if python and not SpecifierSet(python).contains(platform.python_version()):
        out.add(f"Python {python} (found {platform.python_version()})")
    seen: set[tuple[str, str, frozenset[str]]] = set()
    todo = [(Requirement(r), frozenset({""})) for r in reqs]
    while todo:
        req, context = todo.pop()
        if req.marker and not any(req.marker.evaluate({"extra": e}) for e in context):
            continue
        key = (canonicalize_name(req.name), str(req.specifier), frozenset(req.extras))
        if key in seen:
            continue
        seen.add(key)
        try:
            dist = md.distribution(req.name)
        except md.PackageNotFoundError:
            out.add(f"{req.name} (not installed)")
            continue
        if not req.specifier.contains(dist.version, prereleases=True):
            out.add(f"{req.name}{req.specifier} (found {dist.version})")
            continue
        todo += [(Requirement(r), frozenset({"", *req.extras})) for r in dist.requires or []]
    return sorted(out)


def _installed(name: str) -> bool:
    try:
        md.distribution(name)
    except md.PackageNotFoundError:
        return False
    return True


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) not in (1, 3) or (len(args) == 3 and args[1] != "--extra"):
        print("usage: env_check.py <pyproject.toml> [--extra <name>]", file=sys.stderr)
        sys.exit(2)
    lacking = missing(Path(args[0]), tuple(args[2:]))
    for line in lacking:
        print(f"  {line}")
    sys.exit(1 if lacking else 0)
