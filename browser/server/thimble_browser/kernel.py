"""The terminal plugin's kernel (plugin/engine/kernel/), imported in this process, for the two of its modules that thimble
browser runs as the terminal does:

- `fix`: thimble browser makes, turns on and shares a fix of thimble with the same code as the terminal's `thimble
  fix`, in the same place (the kernel's THIMBLE_HOME), so either product sees the other's fixes;
- `evidence`: the deterministic check of the checker's answer to a reply's marks (features/marks.py), the same
  validator as the terminal's `thimble dev validate`.

The kernel is imported as the package `thimble_kernel`, under its own name, so that no other package called `kernel`
stands in for it (the same loader as the browser's other kernel imports). The dependency goes one way: the browser
reads plugin/, never the reverse.
"""
from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path
from types import ModuleType

PLUGIN = Path(__file__).resolve().parents[3] / "plugin"
KERNEL = PLUGIN / "engine" / "kernel"
NAME = "thimble_kernel"


class KernelMissing(ImportError):
    pass


def _package() -> ModuleType:
    pkg = sys.modules.get(NAME)
    if pkg is not None:
        return pkg
    init = KERNEL / "__init__.py"
    if not init.is_file():
        raise KernelMissing(f"thimble browser needs the terminal plugin's kernel at {KERNEL}, which is missing: run "
                            "thimble-browser from a full checkout of the thimble repository (scripts/install.sh)")
    spec = importlib.util.spec_from_file_location(NAME, init, submodule_search_locations=[str(KERNEL)])
    pkg = importlib.util.module_from_spec(spec)
    sys.modules[NAME] = pkg
    try:
        spec.loader.exec_module(pkg)
    except BaseException:
        sys.modules.pop(NAME, None)
        raise
    return pkg


def module(name: str) -> ModuleType:
    """The kernel's module `name`."""
    _package()
    return importlib.import_module(f"{NAME}.{name}")


fix = module("fix")
evidence = module("evidence")
