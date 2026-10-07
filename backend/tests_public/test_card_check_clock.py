"""A card check's clock stands while its card draws and while a revision's code runs, which keep their own limits
(card_check._clock_stands), so a slow drawing or trial on a big corpus does not use up the check's own time."""
import asyncio

import pytest

from app import card_check


def _run() -> card_check._Run:
    return card_check._Run(c="ws", cid="c1", author="main", check="k")


@pytest.mark.asyncio
async def test_a_checks_clock_stands_while_the_work_inside_runs():
    run = _run()

    async def work() -> str:
        async with card_check._clock_stands(run):
            await asyncio.sleep(0.3)  # a drawing or a trial longer than the check's whole limit
        await asyncio.sleep(0.05)
        return "done"

    assert await card_check._within(run, work(), 0.2) == "done"


@pytest.mark.asyncio
async def test_a_checks_own_work_past_its_limit_still_ends_it():
    run = _run()

    async def work() -> None:
        async with card_check._clock_stands(run):
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.5)

    with pytest.raises(card_check._PastTime):
        await card_check._within(run, work(), 0.2)


def test_the_limits_leave_a_reading_at_medium_effort_two_minutes():
    assert card_check.check_timeout("medium") == 120.0
    assert card_check.check_timeout("low") <= card_check.check_timeout("medium") <= card_check.check_timeout("max")
