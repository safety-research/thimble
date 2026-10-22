"""The ask before a big prompt label's run is the same in both products: the browser's estimate.py and the plugin's
kernel estimate.py ask past the same number of records and say the same line."""
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


def test_both_products_say_the_same_line():
    k = _kernel()
    for calls in (1, 2, 292, 1_885):
        assert k.calls_line(calls) == browser_estimate.calls_line(calls)
    assert k.calls_line(292) == "292 model calls" and k.calls_line(1) == "1 model call"
    assert k.calls_line(1_885) == "1,885 model calls"


def test_both_products_ask_past_the_same_sample():
    k = _kernel()
    assert k.SAMPLE == browser_estimate.SAMPLE == 300
    for units in (1, 300, 301, 14_591):
        assert k.needs_asking(units) == browser_estimate.needs_asking(units)
