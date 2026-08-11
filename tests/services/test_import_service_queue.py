"""Tests for the SURGE-04/D-03 global import-concurrency cap (Phase 209 Plan 02).

Covers the cap+1 queuing transition, the QUEUED-state duplicate-import guard,
QUEUED visibility on the active-job surfaces, and the wire-schema literal.

The DB-backed reaper-exemption contract (started_at re-stamp) lives in
tests/test_import_service.py::TestQueuedJobReaperExemption instead, mirroring
where TestFailOrphanedJobsAgeThreshold already lives -- these tests here are
pure in-memory / schema tests with no DB dependency.
"""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError

import app.services.import_service as import_service
from app.schemas.imports import ImportStatusResponse
from app.services.import_service import (
    JobStatus,
    count_active_platform_jobs,
    create_job,
    find_active_job,
    find_active_jobs_for_user,
)


class _StopPipeline(Exception):
    """Sentinel raised by the mocked bootstrap stage to short-circuit run_import
    right after the semaphore-acquisition / IN_PROGRESS transition under test,
    without needing to mock the full fetch/flush/complete pipeline. run_import's
    existing `except Exception` branch catches this and marks the job FAILED --
    releasing the semaphore, which is what the queuing assertions below depend
    on. `_record_failure_with_retry` is mocked out so that failure path never
    touches a real DB session.
    """


@pytest.fixture(autouse=True)
def _clear_jobs():
    """Clear the in-memory job registry before/after each test (cross-test isolation)."""
    import_service._jobs.clear()
    yield
    import_service._jobs.clear()


@pytest.fixture
def _patched_semaphore():
    """Patch the module-level import semaphore to a small limit so
    get_import_semaphore()'s lazy getter returns THIS instance instead of
    creating (or reusing) the real IMPORT_CONCURRENCY_LIMIT=6 one. Restored
    afterward so other tests / the real app see the untouched module state.
    """
    original = import_service._import_semaphore
    import_service._import_semaphore = asyncio.Semaphore(1)
    yield
    import_service._import_semaphore = original


class TestImportConcurrencyCap:
    @pytest.mark.asyncio
    async def test_cap_plus_one_job_is_queued_until_a_slot_frees(self, _patched_semaphore):
        """With the patched limit=1: job 1 acquires the slot and reaches
        IN_PROGRESS; job 2, launched while job 1 still holds the slot, stays
        QUEUED. Releasing job 1 lets job 2 proceed to IN_PROGRESS. Peak
        concurrent IN_PROGRESS entries in _jobs never exceeds the patched
        limit (SURGE-04, boundary edge, D-03).
        """
        job1_id = create_job(user_id=9201, platform="chess.com", username="alice")
        job2_id = create_job(user_id=9202, platform="chess.com", username="bob")

        job1_in_progress = asyncio.Event()
        release_job1 = asyncio.Event()
        peak_in_progress = 0

        def _count_in_progress() -> int:
            return sum(
                1 for j in import_service._jobs.values() if j.status == JobStatus.IN_PROGRESS
            )

        async def _bootstrap_side_effect(job, job_id):
            nonlocal peak_in_progress
            peak_in_progress = max(peak_in_progress, _count_in_progress())
            if job_id == job1_id:
                job1_in_progress.set()
                await release_job1.wait()
            peak_in_progress = max(peak_in_progress, _count_in_progress())
            raise _StopPipeline()

        with (
            patch(
                "app.services.import_service._bootstrap_import_job",
                new=AsyncMock(side_effect=_bootstrap_side_effect),
            ),
            patch("app.services.import_service._stamp_started_at", new=AsyncMock()),
            patch("app.services.import_service._record_failure_with_retry", new=AsyncMock()),
        ):
            task1 = asyncio.create_task(import_service.run_import(job1_id))
            await job1_in_progress.wait()

            assert import_service._jobs[job1_id].status == JobStatus.IN_PROGRESS

            task2 = asyncio.create_task(import_service.run_import(job2_id))
            # Give job2's task enough scheduler turns to reach the semaphore
            # acquisition and actually block on it (limit=1, held by job1).
            for _ in range(10):
                await asyncio.sleep(0)

            assert import_service._jobs[job2_id].status == JobStatus.QUEUED, (
                "job2 must stay QUEUED while job1 holds the only concurrency slot"
            )
            assert import_service._jobs[job1_id].status == JobStatus.IN_PROGRESS

            release_job1.set()
            await task1
            await task2

        assert import_service._jobs[job2_id].status == JobStatus.FAILED, (
            "job2 reached run_import's pipeline (and hit the same _StopPipeline "
            "sentinel) only after acquiring the freed slot"
        )
        assert peak_in_progress <= 1, (
            f"Peak concurrent IN_PROGRESS exceeded the patched limit: {peak_in_progress}"
        )

    @pytest.mark.asyncio
    async def test_queued_job_blocks_a_duplicate_import_for_the_same_user_and_platform(self):
        """A QUEUED JobState makes find_active_job(user_id, platform) return it,
        so POST /imports for the same user+platform is still blocked while
        queued (SURGE-04, RESEARCH Pattern 3)."""
        job_id = create_job(user_id=9301, platform="lichess", username="carol")
        import_service._jobs[job_id].status = JobStatus.QUEUED

        active = find_active_job(9301, "lichess")

        assert active is not None
        assert active.job_id == job_id

    @pytest.mark.asyncio
    async def test_queued_job_is_visible_on_active_surfaces(self):
        """find_active_jobs_for_user includes a QUEUED job for its own user,
        and count_active_platform_jobs counts a QUEUED job belonging to
        another user (SURGE-04, D-03)."""
        own_job_id = create_job(user_id=9401, platform="chess.com", username="dave")
        import_service._jobs[own_job_id].status = JobStatus.QUEUED

        other_job_id = create_job(user_id=9402, platform="chess.com", username="erin")
        import_service._jobs[other_job_id].status = JobStatus.QUEUED

        own_active = find_active_jobs_for_user(9401)
        assert any(j.job_id == own_job_id for j in own_active)

        other_count = count_active_platform_jobs("chess.com", exclude_user_id=9401)
        assert other_count == 1, (
            f"count_active_platform_jobs must count erin's QUEUED job, excluding dave's own; "
            f"got {other_count}"
        )

    def test_import_status_schema_accepts_queued_and_rejects_an_unknown_value(self):
        """ImportStatusResponse.status validates 'queued' and raises
        pydantic.ValidationError for an unknown status string (Task 1's
        ImportJobStatusLiteral tightening)."""
        response = ImportStatusResponse(
            job_id="job-1",
            platform="chess.com",
            username="frank",
            status="queued",
            games_fetched=0,
            games_imported=0,
        )
        assert response.status == "queued"

        with pytest.raises(ValidationError):
            ImportStatusResponse(
                job_id="job-1",
                platform="chess.com",
                username="frank",
                status="bogus",  # ty: ignore[invalid-argument-type] — deliberately invalid for the test
                games_fetched=0,
                games_imported=0,
            )
