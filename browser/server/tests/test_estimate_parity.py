"""The ask before a big label run is the same in both products: the browser's estimate.py and the plugin's kernel
estimate.py ask at the same size and say the same line under the choices."""
from __future__ import annotations

import importlib.util
from pathlib import Path

from thimble_browser.labels import estimate as browser_estimate

KERNEL = Path(__file__).resolve().parents[3] / "plugin" / "engine" / "kernel" / "estimate.py"


def _kernel():
    spec = importlib.util.spec_from_file_location("kernel_estimate", KERNEL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_both_products_ask_at_the_same_size_and_say_the_same_line():
    k = _kernel()
    assert k.SAMPLE == browser_estimate.SAMPLE == 300
    for units in (0, 25, 300, 301, 14_591):
        assert k.needs_asking(units) == browser_estimate.needs_asking(units) == (units > 300)
    for calls in (1, 2, 292, 1_885):
        assert k.calls_line(calls) == browser_estimate.calls_line(calls)
    assert k.calls_line(292) == "292 model calls" and k.calls_line(1) == "1 model call"
    assert k.calls_line(1_885) == "1,885 model calls"
