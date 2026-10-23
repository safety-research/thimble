"""The page's faces for matplotlib, so a figure lays its text out in the face the browser draws it in.

Figures are written as SVG with real text and inlined in the page's faces; matplotlib places labels by the widths of the
face it measured, so it must measure the same faces. The files under fonts/ are TrueType conversions of the page's latin
subsets (OFL-1.1). notebook.kernel_argv runs HOOK_SRC at kernel start: an import hook that adds the files to
matplotlib's font manager when a card first imports matplotlib, so kernels that never draw never load it.
"""
from __future__ import annotations

from pathlib import Path

FONTS_DIR = Path(__file__).resolve().with_name("fonts")  # by its real path (notebook._kernel_reads)


def files() -> list[str]:
    """The TrueType files of the page's faces, by path."""
    return sorted(str(p) for p in FONTS_DIR.glob("*.ttf"))


# Run in the kernel with FONTS (the paths). A meta path finder that wraps the loader of matplotlib.font_manager, so the
# files are added right after the module builds its fontManager; addfont clears the lookup cache itself.
HOOK_SRC = """
import sys

class _ThimbleFonts:
    def find_spec(self, name, path=None, target=None):
        if name != 'matplotlib.font_manager':
            return None
        sys.meta_path.remove(self)
        import importlib.util
        spec = importlib.util.find_spec(name)
        if spec is None or spec.loader is None:
            return spec
        run = spec.loader.exec_module

        def exec_module(module, run=run):
            run(module)
            for f in FONTS:
                try:
                    module.fontManager.addfont(f)
                except Exception:
                    pass

        spec.loader.exec_module = exec_module
        return spec

sys.meta_path.insert(0, _ThimbleFonts())
del _ThimbleFonts
"""
