"""Runs thimble waits on have no time limit: thimble's agents are subagents of main, which run until they end or the
analyst stops them, and the `claude -p` jobs it still starts (code tickets) are started again for as long as the API
stays at capacity (agent_session.retry_wait)."""
from __future__ import annotations

from app import agent_session, critique_session


def test_no_run_has_a_time_limit_of_its_own():
    from app import checks

    for name in ("CRITIQUE_LIMIT_S", "critique_limit"):
        assert not hasattr(critique_session, name)
    for name in ("RUN_LIMIT_S", "run_limit"):
        assert not hasattr(checks, name)
    for name in ("RETRY_BUDGET_S", "RETRY_BUDGET_ENV", "wait_active"):
        assert not hasattr(agent_session, name)


def test_a_job_at_capacity_waits_longer_each_time_up_to_the_cap_and_never_gives_up():
    waits = [agent_session.retry_wait(n, base_s=1.0) for n in range(1, 40)]
    assert all(w > 0 for w in waits) and max(waits) <= agent_session.RETRY_MAX_S * (1 + agent_session.RETRY_JITTER)
