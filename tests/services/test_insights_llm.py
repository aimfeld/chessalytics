"""Tests for app/services/insights_llm.py — Phase 65 orchestration service.

Covers:
- LLM-01: Agent returns validated EndgameInsightsReport via TestModel.
- LLM-02: Startup validation (UserError on empty model, ValueError on bad provider).
- INS-04: Cache key = (findings_hash, prompt_version, model).
- INS-05: 3-miss rate-limit boundary, tier-2 soft-fail, window rollover.
- INS-06: Overview always populated in log; hidden only in response when flag set.

No real provider calls — all agent calls use TestModel or FunctionModel per D-38/D-39.
Rate-limit seeding uses fresh_test_user + own-session pattern (mirrors Plan 04 tests).
compute_findings is monkeypatched for all orchestration tests to avoid DB-heavy Phase 63.
"""

import datetime
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.models.llm_log import LlmLog
from app.models.user import User
from app.schemas.insights import (
    EndgameInsightsReport,
    EndgameTabFindings,
    FilterContext,
    MetricPercentileRecord,
    SectionInsight,
    SubsectionFinding,
    TimePoint,
)
from app.services import insights_llm
from app.services.insights_llm import (
    InsightsProviderError,
    InsightsValidationFailure,
    _SYSTEM_PROMPT,
    _assemble_user_prompt,
    _asymmetry_lines,
    _lookup_pctl_record,
    _maybe_strip_overview,
    _recovery_pattern_tag,
    generate_insights,
    get_insights_agent,
)


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _sample_report(overview: str = "FlawChess played well overall.") -> EndgameInsightsReport:
    return EndgameInsightsReport(
        player_profile="Player around 1500 rapid, range 1200-1600 over 2 years.",
        overview=overview,
        recommendations=["Try drilling pawn endings.", "Review losses on time."],
        sections=[
            SectionInsight(
                section_id="overall",
                headline="Score Gap is typical",
                bullets=["+4.2pp gap on last_3mo"],
            ),
        ],
        model_used="test",
        prompt_version="endgame_v16",
    )


def _sample_filter_context(**kwargs: Any) -> FilterContext:
    defaults: dict[str, Any] = {
        "from_date": None,
        "to_date": None,
        "opponent_strength": "any",
        "color": "all",
        "time_controls": [],
        "platforms": [],
        "rated_only": False,
    }
    defaults.update(kwargs)
    return FilterContext(**defaults)


_USE_CURRENT_PROMPT_VERSION = object()  # sentinel for _make_log_row default


def _make_log_row(
    user_id: int,
    *,
    created_at: datetime.datetime | None = None,
    error: str | None = None,
    response_json: dict[str, Any] | None = None,
    cache_hit: bool = False,
    prompt_version: Any = _USE_CURRENT_PROMPT_VERSION,
    model: str = "test",
    findings_hash: str = "b" * 64,
    opponent_strength: str = "any",
) -> LlmLog:
    """Build a minimal LlmLog row for seeding rate-limit tests.

    Default `prompt_version` is insights_llm._PROMPT_VERSION so cache-hit
    tests remain valid across version bumps without manual updates.
    """
    resolved_version = (
        insights_llm._PROMPT_VERSION
        if prompt_version is _USE_CURRENT_PROMPT_VERSION
        else prompt_version
    )
    kwargs: dict[str, Any] = dict(
        user_id=user_id,
        endpoint="insights.endgame",
        model=model,
        prompt_version=resolved_version,
        findings_hash=findings_hash,
        filter_context={"opponent_strength": opponent_strength},
        user_prompt="user",
        response_json=response_json,
        input_tokens=100,
        output_tokens=50,
        latency_ms=500,
        cache_hit=cache_hit,
        error=error,
        cost_usd=Decimal("0"),
    )
    if created_at is not None:
        kwargs["created_at"] = created_at
    return LlmLog(**kwargs)


async def _seed(session: AsyncSession, *rows: LlmLog) -> None:
    for row in rows:
        session.add(row)
    await session.commit()


def _fake_findings(
    filter_context: FilterContext,
    findings_hash: str = "b" * 64,
    findings: list[SubsectionFinding] | None = None,
) -> EndgameTabFindings:
    return EndgameTabFindings(
        as_of=datetime.datetime.now(datetime.UTC),
        filters=filter_context,
        findings=findings or [],
        findings_hash=findings_hash,
    )


async def _fake_compute_findings(
    filter_context: FilterContext,
    session: AsyncSession,
    user_id: int,
    findings_hash: str = "b" * 64,
) -> EndgameTabFindings:
    return _fake_findings(filter_context, findings_hash=findings_hash)


# ---------------------------------------------------------------------------
# TestStartupValidation
# ---------------------------------------------------------------------------


class TestStartupValidation:
    def test_empty_model_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from pydantic_ai.exceptions import UserError

        insights_llm.get_insights_agent.cache_clear()
        monkeypatch.setattr(insights_llm.settings, "PYDANTIC_AI_MODEL_INSIGHTS", "")
        with pytest.raises(UserError):
            insights_llm.get_insights_agent()
        insights_llm.get_insights_agent.cache_clear()

    def test_bad_provider_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # pydantic-ai 2.39 wraps the unknown-provider ValueError from
        # infer_provider_class in a UserError (RuntimeError subclass, NOT a
        # ValueError), so the old pytest.raises(ValueError) stopped matching.
        # Both startup-validation paths now raise UserError.
        from pydantic_ai.exceptions import UserError

        insights_llm.get_insights_agent.cache_clear()
        monkeypatch.setattr(
            insights_llm.settings, "PYDANTIC_AI_MODEL_INSIGHTS", "bogus-provider:foo"
        )
        with pytest.raises(UserError):
            insights_llm.get_insights_agent()
        insights_llm.get_insights_agent.cache_clear()

    def test_valid_test_model_constructs(self) -> None:
        # conftest sets PYDANTIC_AI_MODEL_INSIGHTS="test"; cache may hold it already.
        insights_llm.get_insights_agent.cache_clear()
        agent = get_insights_agent()
        assert agent is not None
        insights_llm.get_insights_agent.cache_clear()


# ---------------------------------------------------------------------------
# TestPromptVersionAndBody
# ---------------------------------------------------------------------------


class TestPromptVersionAndBody:
    """Phase 68 regression tests (Plan 03 + UAT-pass 260424-pc6).

    Guards:
    - _PROMPT_VERSION is bumped to endgame_v30 so prior cached LLM reports invalidate.
    - app/prompts/endgame_insights.md dropped the score_gap framing rule, the
      score_gap_timeline "only exception to summary-per-metric" carve-out, and
      renamed every `score_gap_timeline` reference to `score_timeline`.
    - The UAT-pass emitter-shape documentation describes the THREE-summary +
      THREE-series score_timeline shape keyed on distinct metrics
      (endgame_score_timeline, non_endgame_score_timeline, score_gap) with weekly granularity
      and the `[n=<N> for every point]` disclosure for constant-N series.
    - Phase 82 (D-22, D-23, D-24): new glossary entries for entry_eval_pawns and endgame_score,
      renamed glossary entries to endgame_score_timeline / non_endgame_score_timeline,
      new ### Subsection: endgame_start_vs_end block, updated mapping table.
    - Phase 83 (D-17, D-18, D-20): new glossary entry for entry_expected_score
      (UI label "Achievable score"), extended endgame_start_vs_end subsection
      block with achievable-vs-achieved gap framing, version bump v24 -> v25.
    """

    def test_prompt_version_is_v33(self) -> None:
        # Phase 87.6 Plan 03 bumped v33 → v34 (PR-direct rebuild + non_endgame_elo).
        assert insights_llm._PROMPT_VERSION == "endgame_v47"

    def test_prompt_file_glossary_has_entry_expected_score(self) -> None:
        """Phase 83 D-17: glossary entry must be present with required framing."""
        from pathlib import Path

        prompt_path = (
            Path(__file__).resolve().parents[2] / "app" / "prompts" / "endgame_insights.md"
        )
        body = prompt_path.read_text(encoding="utf-8")
        assert "entry_expected_score" in body
        assert "Achievable Score" in body
        # D-10 forbidden words must NOT appear in user-facing narration guidance.
        # "underperformance" is allowed ONLY inside an explicit forbidden-words list.
        # Every occurrence in the prompt must be preceded on the same line by the
        # word "Forbidden" (D-10 framing) — narration guidance never uses the term.
        for line in body.splitlines():
            if "underperformance" in line.lower():
                assert "forbidden" in line.lower(), (
                    f"`underperformance` must only appear in forbidden-words lists. "
                    f"Offending line: {line!r}"
                )
        # Cohort band citation to the Plan 4 benchmark report
        assert "benchmarks-2026-05-11.md" in body
        # Lichess sigmoid derivation reference
        assert "0.00368208" in body

    def test_prompt_file_subsection_has_worked_example_narrations(self) -> None:
        """Phase 83 D-18: extended subsection block has the worked examples."""
        from pathlib import Path

        prompt_path = (
            Path(__file__).resolve().parents[2] / "app" / "prompts" / "endgame_insights.md"
        )
        body = prompt_path.read_text(encoding="utf-8")
        # The two example narrations from CONTEXT.md D-18 must be present verbatim.
        # Phase: "engine baseline" wording was reworded to the 2300+-peer-average
        # framing (commit 93c092c2) — the pinned string follows the current copy.
        assert "From positions like yours, a 2300+ player averages 58%" in body
        assert (
            "Entry Eval Score 49%, you scored 52%" in body
        )  # Phase 102: vocab audit renamed "Achievable" → "Entry Eval Score"

    def test_prompt_file_does_not_contain_removed_framing_rule(self) -> None:
        from pathlib import Path

        prompt_path = (
            Path(__file__).resolve().parents[2] / "app" / "prompts" / "endgame_insights.md"
        )
        body = prompt_path.read_text(encoding="utf-8")

        # Negative invariants — all removed in v13, plus v14 drops the old
        # part-dim-tagged score_timeline emitter description.
        for forbidden in (
            "score_gap_timeline",
            "Framing rule (important)",
            "one exception to the summary-per-metric",
            "Score Gap over Time",
            "TWO standard `[summary score_timeline]` blocks",
            "part=endgame",
            "part=non_endgame",
        ):
            assert forbidden not in body, f"prompt still contains forbidden string: {forbidden!r}"

        # Positive invariants — renamed id + v14 emitter-shape documentation present.
        assert "score_timeline" in body
        # Phase 82 D-01/D-02: renamed to _timeline variants in the line-125 paragraph.
        assert "[summary endgame_score_timeline]" in body
        assert "[summary non_endgame_score_timeline]" in body
        assert "[summary score_gap]" in body
        assert "[n=<N> for every point]" in body
        assert "weekly" in body

    def test_subsection_mapping_table_renames_to_score_timeline(self) -> None:
        from pathlib import Path

        prompt_path = (
            Path(__file__).resolve().parents[2] / "app" / "prompts" / "endgame_insights.md"
        )
        body = prompt_path.read_text(encoding="utf-8")

        # The `Subsection → section_id mapping` table row must map score_timeline → overall,
        # NOT score_gap_timeline → overall.
        mapping_row = None
        for line in body.splitlines():
            stripped = line.strip()
            if stripped.startswith("| score_timeline") and "overall" in stripped:
                mapping_row = stripped
                break
        assert mapping_row is not None, (
            "missing `| score_timeline ... | overall |` row in mapping table"
        )

    def test_prompt_contains_endgame_start_vs_end_subsection(self) -> None:
        """Phase 82 (D-23): new ### Subsection: endgame_start_vs_end block is present."""
        from pathlib import Path

        body_path = Path(__file__).resolve().parents[2] / "app" / "prompts" / "endgame_insights.md"
        with open(body_path) as f:
            body = f.read()
        assert "### Subsection: endgame_start_vs_end" in body
        # setup → execution framing must appear inside the block
        assert "setup → execution" in body  # → character

    def test_prompt_glossary_contains_entry_eval_pawns(self) -> None:
        """Phase 82 (D-22): entry_eval_pawns glossary entry is present."""
        from pathlib import Path

        body_path = Path(__file__).resolve().parents[2] / "app" / "prompts" / "endgame_insights.md"
        with open(body_path) as f:
            body = f.read()
        # Entry must appear under the glossary header as a bold heading
        assert "**entry_eval_pawns**" in body

    def test_prompt_glossary_renames_score_timeline_metrics(self) -> None:
        """Phase 82 (D-22): glossary entries renamed to _timeline variants."""
        from pathlib import Path

        body_path = Path(__file__).resolve().parents[2] / "app" / "prompts" / "endgame_insights.md"
        with open(body_path) as f:
            body = f.read()
        assert "**endgame_score_timeline**" in body
        assert "**non_endgame_score_timeline**" in body

    def test_prompt_mapping_table_includes_endgame_start_vs_end_row(self) -> None:
        """Phase 82 (D-24): endgame_start_vs_end row present in mapping table under overall."""
        from pathlib import Path

        body_path = Path(__file__).resolve().parents[2] / "app" / "prompts" / "endgame_insights.md"
        with open(body_path) as f:
            body = f.read()
        found = False
        for line in body.splitlines():
            stripped = line.strip()
            if (
                stripped.startswith("| endgame_start_vs_end")
                and stripped.endswith("|")
                and "overall" in stripped
            ):
                found = True
                break
        assert found, "missing `| endgame_start_vs_end ... | overall |` row in mapping table"

    def test_prompt_glossary_defines_endgame_type_score_gap(self) -> None:
        """Phase 87.1 Plan 04 / CONTEXT D-10: glossary entry for the new metric.

        Glossary uses the FULL form "Endgame Type Score Gap"; narration rule
        instructs the LLM to use "Score Gap" in card-context references and
        the full form when introducing or comparing to the page-level
        Achievable Score Gap. Internal identifier is documented as
        `type_achievable_score_gap` so the LLM can map the payload field name
        to the user-facing label.
        """
        from pathlib import Path

        body_path = Path(__file__).resolve().parents[2] / "app" / "prompts" / "endgame_insights.md"
        body = body_path.read_text(encoding="utf-8")

        # Glossary defines the primary term.
        assert "Endgame Type Score Gap" in body
        # Internal payload field name documented for the LLM.
        assert "type_achievable_score_gap" in body
        # Sigmoid-bias caveat in glossary entry (Lichess sigmoid).
        assert "Lichess" in body and "sigmoid" in body
        # Forbidden internal coinages must NOT appear as user-facing tokens.
        # ΔES / delta_es / dES are forbidden in narration per CONTEXT D-10.
        # Allow them ONLY inside an explicit forbidden-words list (line prefixed
        # by "Forbidden" or "Incorrect").
        for token in ("ΔES", "delta_es"):
            for line in body.splitlines():
                if token in line:
                    assert (
                        "forbidden" in line.lower()
                        or "incorrect" in line.lower()
                        or "do not use" in line.lower()
                        or "do NOT use" in line
                    ), f"{token!r} appears outside a forbidden-words list. Offending line: {line!r}"

    def test_endgame_insights_prompt_carries_score_gap_bucket_glossary(self) -> None:
        """Phase 87.2 Plan 04: endgame_insights.md contains the Section 2 Score Gap family block.

        Asserts the required glossary strings per PLAN.md Task 2 acceptance criteria.
        """
        from pathlib import Path

        body_path = Path(__file__).resolve().parents[2] / "app" / "prompts" / "endgame_insights.md"
        body = body_path.read_text(encoding="utf-8")

        # Umbrella term must be present.
        assert "Section 2 Score Gap family" in body
        # Four bucket-specific terms.
        assert "Conversion Score Gap" in body
        assert "Parity Score Gap" in body
        assert "Recovery Score Gap" in body
        assert "Skill Score Gap" in body
        # Equal-weighted mean (D-01 documented in glossary).
        assert "equal-weighted mean" in body
        # Sigmoid caveat (Lichess expected-score sigmoid).
        assert "Lichess expected-score sigmoid" in body
        # Sign convention present.
        assert "positive = above the Stockfish baseline" in body

    def test_prompt_version_bumped(self) -> None:
        """Phase 102 UAT: _PROMPT_VERSION is endgame_v40; prior v35 stays in changelog."""
        assert insights_llm._PROMPT_VERSION == "endgame_v47"


class TestEndgameTypeAchievableScoreGapPayload:
    """Phase 102 UAT (2026-06-02): per-(class × TC) Score Gap block in the LLM payload.

    The metric `endgame_type_achievable_score_gap` is emitted as a
    SubsectionFinding per (endgame class × time control) under the per-TC
    `endgame_type_<tc>` subsection. Renders to a [summary] block carrying `mean`,
    `n`, `zone`, and an inline `(typical LO to UP)` band derived from
    PER_CLASS_TC_GAUGE_ZONES[<class>][<tc>].achievable_score_gap. The header
    carries both the endgame_class and time_control dim keys.

    There is intentionally no separate `verdict` or `p_value` field per memory
    `feedback_llm_significance_signal.md`.
    """

    def _gap_finding(
        self,
        endgame_class: str,
        *,
        value: float,
        zone: str,
        sample_size: int,
        sample_quality: str = "rich",
        tc: str = "blitz",
    ) -> SubsectionFinding:
        from typing import cast

        from app.schemas.insights import MetricId, SampleQuality, SubsectionId, Zone

        return SubsectionFinding(
            subsection_id=cast(SubsectionId, f"endgame_type_{tc}"),
            parent_subsection_id=None,
            window="all_time",
            metric=cast(MetricId, "endgame_type_achievable_score_gap"),
            value=value,
            zone=cast(Zone, zone),
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=sample_size,
            sample_quality=cast(SampleQuality, sample_quality),
            is_headline_eligible=True,
            dimension={"endgame_class": endgame_class, "time_control": tc},
            series=None,
        )

    def test_gap_renders_summary_block_full_cohort(self) -> None:
        """Full cohort (n >= CONFIDENCE_MIN_N=10) renders a complete [summary] block.

        Asserts the rendered prompt carries `[summary endgame_type_achievable_score_gap | endgame_class=rook]`,
        the window line includes mean / n / zone / inline band, and the band is
        scaled to the 0-100% rendering convention (typical -5 to +5 from the
        rook calibration in PER_CLASS_GAUGE_ZONES, (-0.05, +0.05) fraction).
        """
        filters = _sample_filter_context()
        gap = self._gap_finding(
            "rook",
            value=0.07,  # +7% — above the +5% upper bound, strong zone
            zone="strong",
            sample_size=30,
        )
        tab = _fake_findings(filters, findings=[gap])
        prompt = _assemble_user_prompt(tab)

        # Summary header includes the metric AND the per-(class × TC) dim key.
        assert (
            "[summary endgame_type_achievable_score_gap | endgame_class=rook, time_control=blitz]"
            in prompt
        )
        # Window line carries the scaled mean (0.07 -> +7 on the 0-100 scale).
        assert "mean=+7" in prompt
        # Sample size surfaces.
        assert "n=30" in prompt
        # Zone label rendered.
        assert "zone=strong" in prompt
        # Inline band from PER_CLASS_GAUGE_ZONES["rook"].achievable_score_gap
        # (-0.05, +0.05) -> "(typical -5 to +5)" after §3.4.2 calibration (diff item E).
        assert "(typical -5 to +5)" in prompt

    def test_gap_renders_sparse_cohort_with_band_intact(self) -> None:
        """Sparse cohort (n < CONFIDENCE_MIN_N) still renders summary block.

        Mirrors the existing Conv/Recov sparse behaviour — the LLM still sees
        the mean / zone / band, but `sample_quality` flags the thin cohort so
        the LLM narrates cautiously. No separate p_value / verdict field is
        emitted (per feedback_llm_significance_signal.md).
        """
        filters = _sample_filter_context()
        # n=3 → below CONFIDENCE_MIN_N=10; sample_quality="thin".
        gap = self._gap_finding(
            "queen",
            value=-0.02,
            zone="typical",
            sample_size=3,
            sample_quality="thin",
        )
        tab = _fake_findings(filters, findings=[gap])
        prompt = _assemble_user_prompt(tab)

        assert (
            "[summary endgame_type_achievable_score_gap | endgame_class=queen, time_control=blitz]"
            in prompt
        )
        # Mean is rendered (signed integer, scale=100): -0.02 -> -2.
        assert "mean=-2" in prompt
        # Sample size present.
        assert "n=3" in prompt
        # Zone label present even for thin cohort.
        assert "zone=typical" in prompt
        # Inline band still rendered for thin cohort. Queen band (-0.04, +0.05)
        # -> "(typical -4 to +5)" after diff item F calibration.
        assert "(typical -4 to +5)" in prompt
        # sample_quality flags the thin cohort.
        assert "quality=thin" in prompt

    def test_gap_payload_has_no_verdict_or_pvalue_field(self) -> None:
        """Per memory feedback_llm_significance_signal.md: no parallel verdict / p_value.

        The new payload section MUST NOT introduce a `verdict=` or `p_value=`
        token in the [summary] block. The cohort band IS the significance
        signal; editorialising via a separate field is forbidden.
        """
        filters = _sample_filter_context()
        gap = self._gap_finding(
            "pawn",
            value=0.0,
            zone="typical",
            sample_size=20,
        )
        tab = _fake_findings(filters, findings=[gap])
        prompt = _assemble_user_prompt(tab)

        # Extract just the summary block lines (header + window line + optional
        # shift line) for our new metric, so other findings' fields don't pollute
        # the assertion.
        lines = prompt.splitlines()
        in_block = False
        block_lines: list[str] = []
        for ln in lines:
            if ln.startswith("[summary endgame_type_achievable_score_gap"):
                in_block = True
                block_lines.append(ln)
                continue
            if in_block:
                if ln.startswith("[") or ln.startswith("##"):
                    break
                block_lines.append(ln)
        assert block_lines, "summary block for endgame_type_achievable_score_gap not emitted"
        block_text = "\n".join(block_lines)
        assert "verdict=" not in block_text
        assert "p_value=" not in block_text
        assert "ci_low=" not in block_text
        assert "ci_high=" not in block_text

    def test_gap_payload_field_name_uses_internal_identifier(self) -> None:
        """D-02 / D-10: payload field name preserves grep-ability with achievable_score_gap.

        The MetricId literal in the SubsectionFinding is
        `endgame_type_achievable_score_gap` (NOT `score_gap` or
        `type_score_gap`). Renders into the [summary] header verbatim.
        """
        filters = _sample_filter_context()
        gap = self._gap_finding(
            "minor_piece",
            value=0.03,
            zone="typical",
            sample_size=15,
        )
        tab = _fake_findings(filters, findings=[gap])
        prompt = _assemble_user_prompt(tab)

        # Internal-identifier preserved in the header.
        assert "endgame_type_achievable_score_gap" in prompt
        # Forbidden alternative spellings must NOT appear.
        assert "[summary score_gap | endgame_class=minor_piece]" not in prompt
        assert "[summary type_score_gap" not in prompt

    def test_gap_inline_band_dispatches_per_class_tc(self) -> None:
        """Phase 102 UAT: inline band must come from PER_CLASS_TC_GAUGE_ZONES (per-(class × TC)),
        NOT the pooled PER_CLASS_GAUGE_ZONES band. Sanity check below pins the rook/blitz
        calibration so a future band change forces the test (and the rendered constant)
        to be updated together.
        """
        from app.services import endgame_zones

        filters = _sample_filter_context()
        gap = self._gap_finding(
            "rook",
            value=0.01,
            zone="typical",
            sample_size=20,
            tc="blitz",
        )
        tab = _fake_findings(filters, findings=[gap])
        prompt = _assemble_user_prompt(tab)
        # Calibrated rook/blitz band from PER_CLASS_TC_GAUGE_ZONES["rook"]["blitz"].
        assert "(typical -5 to +5)" in prompt
        # Sanity check: the per-(class × TC) registry carries the calibrated band.
        bands = endgame_zones.PER_CLASS_TC_GAUGE_ZONES["rook"]["blitz"]
        assert bands.achievable_score_gap == (-0.05, 0.05)

    def test_constant_n_series_emits_disclosure_and_drops_per_point_suffix(self) -> None:
        """v14 (260424-pc6 C): when every point's `n` is equal, the series block
        emits a single `[n=<N> for every point]` disclosure line after the
        header and drops the per-point `(n=N)` suffix from every bucket row.
        """
        from app.services.insights_llm import _render_series_block

        finding = SubsectionFinding(
            subsection_id="score_timeline",
            parent_subsection_id=None,
            window="last_3mo",
            metric="endgame_score_timeline",
            value=0.55,
            zone="typical",
            trend="improving",
            weekly_points_in_window=5,
            sample_size=100,
            sample_quality="adequate",
            is_headline_eligible=True,
            dimension=None,
            series=[
                TimePoint(bucket_start=f"2026-02-{day:02d}", value=0.55, n=42)
                for day in (2, 9, 16, 23)
            ],
        )
        assert finding.series is not None
        rendered = "\n".join(_render_series_block(finding, finding.series))

        # Disclosure line sits immediately after the header.
        assert "[n=42 for every point]" in rendered
        # Per-point (n=42) suffix must NOT appear on any bucket row.
        assert "(n=42)" not in rendered
        # Bucket rows still carry bucket_start + signed value.
        assert "2026-02-02: +55" in rendered

    def test_variable_n_series_keeps_per_point_suffix(self) -> None:
        """v14 (260424-pc6 C): when per-point `n` varies, the disclosure
        shortcut must NOT fire — every bucket keeps its own `(n=<N>)` tag
        so the LLM can still reason about per-bucket sample weight.
        """
        from app.services.insights_llm import _render_series_block

        finding = SubsectionFinding(
            subsection_id="clock_diff_timeline",
            parent_subsection_id=None,
            window="all_time",
            metric="avg_clock_diff_pct",
            value=-5.0,
            zone="typical",
            trend="stable",
            weekly_points_in_window=5,
            sample_size=200,
            sample_quality="rich",
            is_headline_eligible=True,
            dimension=None,
            series=[
                TimePoint(bucket_start=f"2026-02-{day:02d}", value=-5.0, n=n)
                for day, n in zip((2, 9, 16, 23), (40, 42, 44, 46), strict=True)
            ],
        )
        assert finding.series is not None
        rendered = "\n".join(_render_series_block(finding, finding.series))

        # Disclosure line must NOT appear — n is not constant.
        assert "for every point]" not in rendered
        # Per-point (n=<N>) suffix is retained on every bucket.
        for n in (40, 42, 44, 46):
            assert f"(n={n})" in rendered


# ---------------------------------------------------------------------------
# TestGoldenUserPrompt
# ---------------------------------------------------------------------------


class TestGoldenUserPrompt:
    """Byte-level oracle for `_assemble_user_prompt`'s full rendered output.

    Phase 214 Plan 07: prior tests only assert on substrings of the prompt,
    which cannot catch a reordered section, a dropped blank line, or a
    filter stage applied one position too early/late. This golden closes
    that gap with whole-string equality against a file captured from
    pre-refactor code (before `_apply_a2_filter` and its siblings were
    extracted from `_assemble_user_prompt`/`_retained_series_for_summary`/
    `_render_series_block`/`_render_subsection_block`).

    Fixture design (deliberately reuses the same `SubsectionFinding` /
    `TimePoint` / `_sample_filter_context` / `EndgamePerformanceResponse`
    constructors every other test in this module uses -- no new fixture
    abstraction is introduced):
    - `endgame_elo_timeline` / `endgame_elo_gap`: an `all_time` series of 50
      deterministic monthly points (2022-01 .. 2026-02) -- deliberately more
      than `_ALL_TIME_MAX_POINTS` (36), so the C6 tail-cap has real points to
      drop (proven by the mutation test in Task 3's SUMMARY) -- plus a
      `last_3mo` counterpart for the same (metric, subsection) pair, which
      exercises C5 (the last_3mo `[series ...]` block is skipped because the
      all_time series for the same pair is retained) and the
      `_render_endgame_elo_summary_block` / `_render_non_endgame_elo_summary_block`
      dedup target (both fire together whenever subsection_id ==
      "endgame_elo_timeline" and metric == "endgame_elo_gap").
    - `score_timeline` / `score_gap`: a second subsection with its own short
      (4-point) all_time series and a zone-bounded band.
    - `endgame_type_blitz` / `endgame_type_achievable_score_gap`: the
      zone-bounded per-class metric (same values as
      `TestEndgameTypeAchievableScoreGapPayload.test_gap_renders_summary_block_full_cohort`),
      exercising `_format_zone_bounds`'s per-class-TC dispatch.
    - `overall_performance`: feeds the `## Chart: overall_wdl` block and the
      `## Payload summary` total-games line.

    Determinism: `as_of` is a fixed `datetime.datetime`, and every series
    point's `bucket_start` is a fixed string -- no `datetime.now()`/`.today()`
    read inside the fixture itself. `_assemble_user_prompt` does read
    `datetime.date.today()` once (for the C2 90-day `all_time_cutoff`), but
    every fixture point in the 50-point all_time series predates 2026-02-01,
    so as long as the suite runs on or after 2026-05-02 (today - 90d >
    2026-02-01) the C2 cutoff comparison's outcome (0 points trimmed) cannot
    change -- verified deterministic by running this test twice in the same
    session (`_build_golden_findings()` called twice, prompts compared byte
    for byte) before the golden file was captured.
    """

    def _build_golden_findings(self) -> EndgameTabFindings:
        from typing import cast

        from app.schemas.endgames import EndgamePerformanceResponse, EndgameWDLSummary
        from app.schemas.insights import MetricId, SampleQuality, SubsectionId, Zone

        filters = _sample_filter_context()

        elo_all_time_series = [
            TimePoint(
                bucket_start=f"{2022 + (i // 12)}-{(i % 12) + 1:02d}-01",
                value=40.0 + i,
                n=15,
                actual_elo=1400 + i,
                non_endgame_elo=1420 + i,
            )
            for i in range(50)
        ]
        elo_last_3mo_series = [
            TimePoint(
                bucket_start=f"2026-01-{day:02d}",
                value=88.0,
                n=12,
                actual_elo=1600,
                non_endgame_elo=1620,
            )
            for day in (5, 12, 19, 26)
        ]
        elo_all_time = SubsectionFinding(
            subsection_id=cast(SubsectionId, "endgame_elo_timeline"),
            parent_subsection_id=None,
            window="all_time",
            metric=cast(MetricId, "endgame_elo_gap"),
            value=89.0,
            zone=cast(Zone, "typical"),
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=200,
            sample_quality=cast(SampleQuality, "rich"),
            is_headline_eligible=True,
            dimension={"platform": "chess.com", "time_control": "blitz"},
            series=elo_all_time_series,
        )
        elo_last_3mo = SubsectionFinding(
            subsection_id=cast(SubsectionId, "endgame_elo_timeline"),
            parent_subsection_id=None,
            window="last_3mo",
            metric=cast(MetricId, "endgame_elo_gap"),
            value=88.0,
            zone=cast(Zone, "typical"),
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=12,
            sample_quality=cast(SampleQuality, "rich"),
            is_headline_eligible=True,
            dimension={"platform": "chess.com", "time_control": "blitz"},
            series=elo_last_3mo_series,
        )
        gap_finding = SubsectionFinding(
            subsection_id=cast(SubsectionId, "endgame_type_blitz"),
            parent_subsection_id=None,
            window="all_time",
            metric=cast(MetricId, "endgame_type_achievable_score_gap"),
            value=0.07,
            zone=cast(Zone, "strong"),
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=30,
            sample_quality=cast(SampleQuality, "rich"),
            is_headline_eligible=True,
            dimension={"endgame_class": "rook", "time_control": "blitz"},
            series=None,
        )
        score_timeline_series = [
            TimePoint(bucket_start=f"2026-01-{week:02d}", value=-0.05, n=50)
            for week in (5, 12, 19, 26)
        ]
        score_gap_finding = SubsectionFinding(
            subsection_id=cast(SubsectionId, "score_timeline"),
            parent_subsection_id=None,
            window="all_time",
            metric=cast(MetricId, "score_gap"),
            value=-0.05,
            zone=cast(Zone, "typical"),
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=200,
            sample_quality=cast(SampleQuality, "rich"),
            is_headline_eligible=True,
            dimension={"part": "endgame"},
            series=score_timeline_series,
        )

        overall_performance = EndgamePerformanceResponse(
            endgame_wdl=EndgameWDLSummary(
                wins=120,
                draws=40,
                losses=80,
                total=240,
                win_pct=50.0,
                draw_pct=16.7,
                loss_pct=33.3,
            ),
            non_endgame_wdl=EndgameWDLSummary(
                wins=300,
                draws=50,
                losses=350,
                total=700,
                win_pct=42.9,
                draw_pct=7.1,
                loss_pct=50.0,
            ),
            endgame_win_rate=50.0,
        )

        return EndgameTabFindings(
            as_of=datetime.datetime(2026, 2, 1, tzinfo=datetime.UTC),
            filters=filters,
            findings=[elo_all_time, elo_last_3mo, gap_finding, score_gap_finding],
            overall_performance=overall_performance,
            findings_hash="c" * 64,
        )

    def test_golden_user_prompt_matches_committed_file(self) -> None:
        """Whole-string equality against `tests/services/golden/insights_user_prompt.txt`.

        The golden was captured from pre-refactor code (before
        `_apply_a2_filter`/`_apply_c2_filter`/`_apply_c3_filter`/`_apply_c5_filter`/
        `_apply_c6_filter` existed) and is never regenerated to match a
        post-refactor output -- if this fails, the split changed the emitted
        prompt and the split (not the golden) must be fixed.
        """
        from pathlib import Path

        golden_path = Path(__file__).resolve().parent / "golden" / "insights_user_prompt.txt"
        expected = golden_path.read_text(encoding="utf-8")
        actual = _assemble_user_prompt(self._build_golden_findings())
        assert actual == expected


# ---------------------------------------------------------------------------
# TestPromptAssembly
# ---------------------------------------------------------------------------


class TestPromptAssembly:
    def test_user_prompt_shape(self) -> None:
        filters = _sample_filter_context(
            from_date=datetime.date(2026, 2, 20), time_controls=["blitz"], platforms=["chess.com"]
        )
        non_timeline = SubsectionFinding(
            # Phase 102 UAT: score_gap scalar now lives in the dedicated
            # `score_gap` subsection (the `overall` subsection was retired).
            subsection_id="score_gap",
            parent_subsection_id=None,
            window="all_time",
            metric="score_gap",
            value=4.2,
            zone="typical",
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=487,
            sample_quality="rich",
            is_headline_eligible=True,
            dimension=None,
            series=None,
        )
        # Phase 68 (260424-pc6): score_timeline emits THREE findings per
        # window — one per metric. Phase 82 D-01/D-02: renamed to
        # endgame_score_timeline / non_endgame_score_timeline / score_gap.
        # No `part` dim; each metric id is the unique key.
        timeline_endgame = SubsectionFinding(
            subsection_id="score_timeline",
            parent_subsection_id=None,
            window="last_3mo",
            metric="endgame_score_timeline",
            value=0.55,
            zone="typical",
            trend="improving",
            weekly_points_in_window=8,
            sample_size=8,
            sample_quality="adequate",
            is_headline_eligible=True,
            dimension=None,
            series=[
                TimePoint(bucket_start="2026-01-06", value=0.55, n=14),
                TimePoint(bucket_start="2026-01-13", value=0.57, n=14),
            ],
        )
        timeline_non_endgame = SubsectionFinding(
            subsection_id="score_timeline",
            parent_subsection_id=None,
            window="last_3mo",
            metric="non_endgame_score_timeline",
            value=0.52,
            zone="typical",
            trend="stable",
            weekly_points_in_window=8,
            sample_size=8,
            sample_quality="adequate",
            is_headline_eligible=False,
            dimension=None,
            series=[
                TimePoint(bucket_start="2026-01-06", value=0.52, n=14),
                TimePoint(bucket_start="2026-01-13", value=0.52, n=14),
            ],
        )
        timeline_gap = SubsectionFinding(
            subsection_id="score_timeline",
            parent_subsection_id=None,
            window="last_3mo",
            metric="score_gap",
            value=0.035,
            zone="typical",
            trend="improving",
            weekly_points_in_window=8,
            sample_size=8,
            sample_quality="adequate",
            is_headline_eligible=False,
            dimension=None,
            series=[
                TimePoint(bucket_start="2026-01-06", value=0.03, n=28),
                TimePoint(bucket_start="2026-01-13", value=0.05, n=28),
            ],
        )
        tab_findings = _fake_findings(
            filters,
            findings=[non_timeline, timeline_endgame, timeline_non_endgame, timeline_gap],
        )
        prompt = _assemble_user_prompt(tab_findings)

        # v9: Filters: header is no longer always emitted; only the
        # `## Scoping caveat` line appears when opponent_strength != "any".
        assert "Filters:" not in prompt
        assert "Flags:" not in prompt
        assert "### Subsection: score_gap" in prompt
        assert "### Subsection: score_timeline" in prompt
        # Phase 68 (v14) / Phase 82 D-01/D-02 rename: three series blocks (one
        # per metric), all pinned to weekly.
        assert "[series endgame_score_timeline, last_3mo, weekly]" in prompt
        assert "[series non_endgame_score_timeline, last_3mo, weekly]" in prompt
        assert "[series score_gap, last_3mo, weekly]" in prompt
        # No `part=` dim on any score_timeline series block.
        assert "part=endgame" not in prompt
        assert "part=non_endgame" not in prompt
        assert "2026-01-06" in prompt
        assert "2026-01-13" in prompt

    def test_endgame_start_vs_end_findings_render_in_prompt(self) -> None:
        """Phase 82 (D-23): findings on subsection `endgame_start_vs_end` must appear
        in the assembled user prompt under section `overall`, between the `overall`
        scalar block and the `score_timeline` block. Regression for the missing
        `_SECTION_LAYOUT` entry that caused the new findings to be silently dropped.

        Also asserts the rendered SCALE for both metrics:
        - entry_eval_pawns is in PAWNS — value 0.46 must render as "+0.46", band as
          "(typical -0.60 to +0.60)". The prompt glossary (D-22) explicitly says
          "Render as signed one-decimal value with the unit 'pawns' ... Do NOT
          convert to centipawns." Phase 82 initially shipped with the metric
          missing from `_NON_FRACTIONAL_METRICS`, which scaled values by 100×
          and corrupted every prompt.
        - endgame_score is on the 0-100 percent scale — value 0.58 must render
          as "+58", band as "(typical +45 to +55)".
        """
        filters = _sample_filter_context()
        entry_eval = SubsectionFinding(
            subsection_id="endgame_start_vs_end",
            parent_subsection_id=None,
            window="all_time",
            metric="entry_eval_pawns",
            value=0.46,
            zone="typical",
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=80,
            sample_quality="adequate",
            is_headline_eligible=True,
            dimension=None,
            series=None,
        )
        endgame_score = SubsectionFinding(
            subsection_id="endgame_start_vs_end",
            parent_subsection_id=None,
            window="all_time",
            metric="endgame_score",
            value=0.58,
            zone="strong",
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=80,
            sample_quality="adequate",
            is_headline_eligible=True,
            dimension=None,
            series=None,
        )
        tab_findings = _fake_findings(filters, findings=[entry_eval, endgame_score])
        prompt = _assemble_user_prompt(tab_findings)

        assert "### Subsection: endgame_start_vs_end" in prompt
        assert "[summary entry_eval_pawns]" in prompt
        assert "[summary endgame_score]" in prompt

        # entry_eval_pawns scale: pawns with 2-decimal precision.
        assert "mean=+0.46" in prompt, (
            "entry_eval_pawns must render in pawns (e.g. +0.46), not centipawns "
            f"(+46). Prompt slice:\n{prompt}"
        )
        assert "(typical -0.60 to +0.60)" in prompt, (
            "entry_eval_pawns zone band must render in pawns (-0.60 to +0.60), "
            f"not centipawns (-60 to +60). Prompt slice:\n{prompt}"
        )
        # Negative invariant: no centipawn rendering of entry_eval_pawns.
        assert "mean=+46" not in prompt
        assert "(typical -60 to +60)" not in prompt

        # endgame_score scale: integer percentage (0-100). Value 0.58 → +58.
        assert "mean=+58" in prompt
        assert "(typical +45 to +55)" in prompt

    def test_endgame_start_vs_end_renders_only_populated_tile(self) -> None:
        """Phase 82 (D-17, WR-01): asymmetric tile case — `entry_eval_pawns` gated
        out (n_eval < 10, e.g. Stockfish backfill incomplete) but `endgame_score`
        populated. The subsection header must render with exactly one [summary]
        block (the populated one); the missing tile must NOT appear, and the
        populated tile must NOT be silently dropped along with it.
        """
        import math

        filters = _sample_filter_context()
        # Tile 1 — empty/thin (gated out). Mirrors what _empty_finding produces.
        empty_entry_eval = SubsectionFinding(
            subsection_id="endgame_start_vs_end",
            parent_subsection_id=None,
            window="all_time",
            metric="entry_eval_pawns",
            value=math.nan,
            zone="typical",
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=0,
            sample_quality="thin",
            is_headline_eligible=False,
            dimension=None,
            series=None,
        )
        # Tile 2 — populated.
        endgame_score = SubsectionFinding(
            subsection_id="endgame_start_vs_end",
            parent_subsection_id=None,
            window="all_time",
            metric="endgame_score",
            value=0.52,
            zone="typical",
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=80,
            sample_quality="adequate",
            is_headline_eligible=True,
            dimension=None,
            series=None,
        )
        tab_findings = _fake_findings(filters, findings=[empty_entry_eval, endgame_score])
        prompt = _assemble_user_prompt(tab_findings)

        # Section header renders.
        assert "### Subsection: endgame_start_vs_end" in prompt
        # Populated tile appears.
        assert "[summary endgame_score]" in prompt
        # Empty tile is filtered (NaN + sample_size==0 + thin → A2 filter).
        assert "[summary entry_eval_pawns]" not in prompt

    def test_format_zone_bounds_skips_no_op_timeline_metrics(self) -> None:
        """Phase 82 (WR-03): the no-op `[0, 1]` band on the renamed timeline
        metrics must NOT render an inline `(typical ...)` tag — that would put
        a meaningless `(typical +0 to +100)` next to every score-timeline finding.
        Direct unit test on the skip-list mechanism so a future rename of either
        the MetricId Literal or `_NO_BAND_METRICS` cannot silently regress.
        """
        from app.services.insights_llm import _format_zone_bounds, _NO_BAND_METRICS

        assert _format_zone_bounds("endgame_score_timeline", None) == ""
        assert _format_zone_bounds("non_endgame_score_timeline", None) == ""
        # Pin the constant contents so a future rename has a single touchpoint.
        assert _NO_BAND_METRICS == frozenset(
            {"endgame_score_timeline", "non_endgame_score_timeline"}
        )

    def test_format_zone_bounds_renders_for_endgame_score(self) -> None:
        """Phase 82 (WR-03): the repurposed `endgame_score` (in subsection
        endgame_start_vs_end) DOES have a calibrated [0.45, 0.55] band; the
        skip-list must NOT mute it. Negative pair to the timeline test above.
        """
        from app.services.insights_llm import _format_zone_bounds

        result = _format_zone_bounds("endgame_score", None)
        assert "+45" in result
        assert "+55" in result

    def test_format_zone_bounds_renders_pawns_with_decimals(self) -> None:
        """Phase 82 (CR-01): `entry_eval_pawns` band must render as decimal
        pawns, not centipawns. Pins the precision plumbing introduced alongside
        `_NON_FRACTIONAL_METRICS`.
        """
        from app.services.insights_llm import _format_zone_bounds

        result = _format_zone_bounds("entry_eval_pawns", None)
        assert "-0.60" in result
        assert "+0.60" in result
        # Negative invariant: no centipawn-style render.
        assert "-60 to" not in result

    def test_system_prompt_loaded_from_file(self) -> None:
        """_SYSTEM_PROMPT is the markdown file contents + auto-generated zone appendix.

        Per 260422-tnb B2: _SYSTEM_PROMPT at module load = file contents + a
        deterministic `## Zone thresholds` appendix sourced from ZONE_REGISTRY
        and BUCKETED_ZONE_REGISTRY. The appendix is appended so the file
        content must be a strict prefix.
        """
        from pathlib import Path

        import app.services.insights_llm as mod

        file_path = Path(mod.__file__).parent.parent / "prompts" / "endgame_insights.md"
        file_content = file_path.read_text(encoding="utf-8")
        assert _SYSTEM_PROMPT.startswith(file_content)
        assert "## Zone thresholds" in _SYSTEM_PROMPT
        assert len(_SYSTEM_PROMPT) > len(file_content)

    def test_filter_excludes_color_and_rated_only(self) -> None:
        filters = _sample_filter_context(color="white", rated_only=True)
        tab_findings = _fake_findings(filters)
        prompt = _assemble_user_prompt(tab_findings)

        assert "color=" not in prompt
        assert "rated_only=" not in prompt
        assert "white" not in prompt
        assert "rated" not in prompt

    def test_assemble_user_prompt_drops_nan_findings(self) -> None:
        """A2 (260422-tnb): NaN values and thin empty findings are filtered out."""
        filters = _sample_filter_context()
        normal = SubsectionFinding(
            subsection_id="score_gap",
            parent_subsection_id=None,
            window="all_time",
            metric="score_gap",
            value=0.05,
            zone="typical",
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=120,
            sample_quality="adequate",
            is_headline_eligible=True,
            dimension=None,
            series=None,
        )
        # Empty finding mirrors _empty_finding output: NaN value, thin, n=0.
        empty = SubsectionFinding(
            subsection_id="endgame_metrics",
            parent_subsection_id=None,
            window="last_3mo",
            metric="recovery_save_pct",
            value=float("nan"),
            zone="typical",
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=0,
            sample_quality="thin",
            is_headline_eligible=False,
            dimension={"bucket": "recovery"},
            series=None,
        )
        tab_findings = _fake_findings(filters, findings=[normal, empty])
        prompt = _assemble_user_prompt(tab_findings)

        # Must not leak NaN into the prompt (was: "+nan | typical | 0 games | thin").
        assert "nan" not in prompt.lower()
        # Only the normal finding produces a [summary] block; the NaN empty finding is dropped.
        assert prompt.count("[summary ") == 1
        assert "[summary score_gap]" in prompt
        # No bullet lines in v10 — findings render as indented all_time/last_3mo lines.
        assert not [line for line in prompt.splitlines() if line.startswith("- ")]

    def test_assemble_user_prompt_groups_by_subsection(self) -> None:
        """C1 (260422-tnb): multiple findings under one subsection share a single header."""
        from typing import cast
        from app.schemas.insights import MetricId

        filters = _sample_filter_context()

        # Phase 102 UAT: metrics_elo is per-TC — findings live under
        # endgame_metrics_<tc> and carry a time_control dimension.
        def _em(metric: str, value: float) -> SubsectionFinding:
            return SubsectionFinding(
                subsection_id="endgame_metrics_blitz",
                parent_subsection_id=None,
                window="all_time",
                metric=cast(MetricId, metric),
                value=value,
                zone="typical",
                trend="n_a",
                weekly_points_in_window=0,
                sample_size=120,
                sample_quality="adequate",
                is_headline_eligible=True,
                dimension={"time_control": "blitz"},
                series=None,
            )

        findings_list = [
            _em("conversion_win_pct", 0.66),
            _em("parity_score_pct", 0.50),
            _em("recovery_save_pct", 0.30),
        ]
        tab_findings = _fake_findings(filters, findings=findings_list)
        prompt = _assemble_user_prompt(tab_findings)

        assert prompt.count("### Subsection: endgame_metrics_blitz") == 1
        # Each of the 3 metrics emits exactly one [summary metric | dim] block.
        assert prompt.count("[summary conversion_win_pct | time_control=blitz]") == 1
        assert prompt.count("[summary parity_score_pct | time_control=blitz]") == 1
        assert prompt.count("[summary recovery_save_pct | time_control=blitz]") == 1

    def test_assemble_user_prompt_filters_sparse_series_points(self) -> None:
        """A4 (260422-tnb): series points with n < MIN_BUCKET_N (=3) are dropped."""
        filters = _sample_filter_context()
        timeline = SubsectionFinding(
            subsection_id="score_timeline",
            parent_subsection_id=None,
            window="last_3mo",
            metric="score_gap",
            value=0.08,
            zone="typical",
            trend="improving",
            weekly_points_in_window=4,
            sample_size=4,
            sample_quality="thin",
            is_headline_eligible=False,
            dimension={"part": "endgame"},
            series=[
                TimePoint(bucket_start="2026-02-02", value=0.01, n=1),  # drop
                TimePoint(bucket_start="2026-02-09", value=0.04, n=5),  # keep
                TimePoint(bucket_start="2026-02-16", value=0.06, n=2),  # drop
                TimePoint(bucket_start="2026-02-23", value=0.08, n=10),  # keep
            ],
        )
        tab_findings = _fake_findings(filters, findings=[timeline])
        prompt = _assemble_user_prompt(tab_findings)

        # Retained points must appear.
        assert "2026-02-09" in prompt
        assert "(n=5)" in prompt
        assert "2026-02-23" in prompt
        assert "(n=10)" in prompt
        # Dropped points must NOT appear.
        assert "2026-02-02" not in prompt
        assert "(n=1)" not in prompt
        assert "2026-02-16" not in prompt
        assert "(n=2)" not in prompt

    # Phase 88.1 (Plan 09, REVIEW.md WR-06): three tests removed alongside the
    # _format_time_pressure_chart_block / _SKIPPED_SUBSECTIONS / time_pressure_chart
    # plumbing deletion. The old assertions covered:
    #   - test_assemble_user_prompt_skips_time_pressure_vs_performance_subsection_finding
    #   - test_assemble_user_prompt_renders_time_pressure_chart_block
    #   - test_assemble_user_prompt_omits_chart_block_when_empty

    def test_assemble_user_prompt_renders_overall_wdl_chart_block(self) -> None:
        """The endgame-vs-non-endgame WDL block is rendered when performance is set."""
        from app.schemas.endgames import EndgamePerformanceResponse, EndgameWDLSummary

        perf = EndgamePerformanceResponse(
            endgame_wdl=EndgameWDLSummary(
                wins=120,
                draws=40,
                losses=80,
                total=240,
                win_pct=50.0,
                draw_pct=16.7,
                loss_pct=33.3,
            ),
            non_endgame_wdl=EndgameWDLSummary(
                wins=300,
                draws=50,
                losses=350,
                total=700,
                win_pct=42.9,
                draw_pct=7.1,
                loss_pct=50.0,
            ),
            endgame_win_rate=50.0,
        )
        tab = EndgameTabFindings(
            as_of=datetime.datetime.now(datetime.UTC),
            filters=_sample_filter_context(),
            findings=[],
            overall_performance=perf,
            findings_hash="b" * 64,
        )
        prompt = _assemble_user_prompt(tab)

        assert "### Chart: overall_wdl (all_time)" in prompt
        assert "| series      | games | win_pct | draw_pct | loss_pct | score_pct |" in prompt
        assert "| endgame     | 240" in prompt
        assert "| non_endgame | 700" in prompt
        # v7 whole-number scale: Score % = (W + 0.5*D)/total * 100, rounded.
        # endgame = 140/240*100 = 58.3 → 58, non-endgame = 325/700*100 = 46.4 → 46
        assert "| 58 " in prompt or "| 58\n" in prompt or " 58 " in prompt
        assert "| 46 " in prompt or "| 46\n" in prompt or " 46 " in prompt

    def test_assemble_user_prompt_omits_overall_wdl_when_thin(self) -> None:
        """Rows below the 10-game floor are dropped; block omitted if all dropped."""
        from app.schemas.endgames import EndgamePerformanceResponse, EndgameWDLSummary

        perf = EndgamePerformanceResponse(
            endgame_wdl=EndgameWDLSummary(
                wins=2,
                draws=1,
                losses=1,
                total=4,
                win_pct=50.0,
                draw_pct=25.0,
                loss_pct=25.0,
            ),
            non_endgame_wdl=EndgameWDLSummary(
                wins=0,
                draws=0,
                losses=0,
                total=0,
                win_pct=0.0,
                draw_pct=0.0,
                loss_pct=0.0,
            ),
            endgame_win_rate=50.0,
        )
        tab = EndgameTabFindings(
            as_of=datetime.datetime.now(datetime.UTC),
            filters=_sample_filter_context(),
            findings=[],
            overall_performance=perf,
            findings_hash="b" * 64,
        )
        assert "### Chart: overall_wdl" not in _assemble_user_prompt(tab)

        # None case
        tab_none = EndgameTabFindings(
            as_of=datetime.datetime.now(datetime.UTC),
            filters=_sample_filter_context(),
            findings=[],
            overall_performance=None,
            findings_hash="b" * 64,
        )
        assert "### Chart: overall_wdl" not in _assemble_user_prompt(tab_none)

    def test_assemble_user_prompt_renders_type_wdl_chart_block(self) -> None:
        """Phase 102 UAT: per-TC WDL table leads each `endgame_type_<tc>` subsection,
        sorted by total descending. Built from type_categories_by_tc (per-(class × TC)).
        The opp_score_pct + score_pct_diff columns are dropped (score_pct above 50
        already means outscoring). Rows below the 10-game floor are skipped.
        """
        from app.schemas.endgames import ConversionRecoveryStats, EndgameCategoryStats

        def _conv(
            conv_pct: float, recov_pct: float, n_conv: int = 40, n_recov: int = 20
        ) -> ConversionRecoveryStats:
            conv_wins = int(n_conv * conv_pct / 100)
            conv_losses = n_conv - conv_wins
            recov_wins = int(n_recov * recov_pct / 100 * 0.6)
            recov_draws = int(n_recov * recov_pct / 100 * 0.4)
            recov_losses = n_recov - recov_wins - recov_draws
            # Phase 84 mirror-identity opponent baselines (gated on mirror bucket >= 10).
            opp_conv = round(recov_losses / n_recov * 100, 1) if n_recov >= 10 else None
            opp_recov = round((conv_losses + 0) / n_conv * 100, 1) if n_conv >= 10 else None
            return ConversionRecoveryStats(
                conversion_pct=conv_pct,
                conversion_games=n_conv,
                conversion_wins=conv_wins,
                conversion_draws=0,
                conversion_losses=conv_losses,
                recovery_pct=recov_pct,
                recovery_games=n_recov,
                recovery_saves=int(n_recov * recov_pct / 100),
                recovery_wins=recov_wins,
                recovery_draws=recov_draws,
                opponent_conversion_pct=opp_conv,
                opponent_conversion_games=n_recov,
                opponent_recovery_pct=opp_recov,
                opponent_recovery_games=n_conv,
            )

        categories = [
            EndgameCategoryStats(
                endgame_class="rook",
                label="Rook",
                wins=50,
                draws=20,
                losses=30,
                total=100,
                win_pct=50.0,
                draw_pct=20.0,
                loss_pct=30.0,
                conversion=_conv(conv_pct=68.0, recov_pct=32.0),
            ),
            EndgameCategoryStats(
                endgame_class="pawn",
                label="Pawn",
                wins=15,
                draws=5,
                losses=10,
                total=30,
                win_pct=50.0,
                draw_pct=16.7,
                loss_pct=33.3,
                conversion=_conv(conv_pct=70.0, recov_pct=28.0),
            ),
            EndgameCategoryStats(
                endgame_class="queen",
                label="Queen",
                wins=2,
                draws=0,
                losses=1,
                total=3,  # below 10-game floor — dropped
                win_pct=66.7,
                draw_pct=0.0,
                loss_pct=33.3,
                conversion=_conv(conv_pct=75.0, recov_pct=25.0, n_conv=1, n_recov=1),
            ),
        ]
        tab = EndgameTabFindings(
            as_of=datetime.datetime.now(datetime.UTC),
            filters=_sample_filter_context(),
            findings=[],
            type_categories_by_tc={"blitz": categories},
            findings_hash="b" * 64,
        )
        prompt = _assemble_user_prompt(tab)

        # Per-TC subsection header + WDL table caption.
        assert "### Subsection: endgame_type_blitz" in prompt
        assert "[WDL table — blitz]" in prompt
        # Compact WDL columns (no opp_score_pct / score_pct_diff).
        assert "| endgame_type | games | win_pct | draw_pct | loss_pct | score_pct |" in prompt
        assert "opp_score_pct" not in prompt
        assert "score_pct_diff" not in prompt
        # Sorted by total descending: rook (100) before pawn (30).
        rook_idx = prompt.index("| rook")
        pawn_idx = prompt.index("| pawn")
        assert rook_idx < pawn_idx
        # Queen (total=3, below 10-game floor) dropped from the table.
        assert "| queen" not in prompt

    def test_pawnless_findings_are_filtered(self) -> None:
        """v6: pawnless-dimensioned findings and chart rows are stripped.

        The UI hides pawnless in ENDGAME_CLASS_LABELS (Endgames.tsx); the LLM
        must not narrate a type the user cannot see. Applies to both per-type
        findings (dimension.endgame_class == "pawnless") and the
        results_by_endgame_type_wdl chart row.
        """
        from typing import cast

        from app.schemas.endgames import ConversionRecoveryStats, EndgameCategoryStats
        from app.schemas.insights import MetricId

        filters = _sample_filter_context()
        rook_finding = SubsectionFinding(
            subsection_id="endgame_type_blitz",
            parent_subsection_id=None,
            window="all_time",
            metric="conversion_win_pct",
            value=0.65,
            zone="typical",
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=30,
            sample_quality="rich",
            is_headline_eligible=True,
            dimension={"endgame_class": "rook", "time_control": "blitz"},
            series=None,
        )
        pawnless_finding = SubsectionFinding(
            subsection_id=cast(Any, "endgame_type_blitz"),
            parent_subsection_id=None,
            window="all_time",
            metric=cast(MetricId, "conversion_win_pct"),
            value=0.58,
            zone="strong",
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=19,
            sample_quality="adequate",
            is_headline_eligible=True,
            dimension={"endgame_class": "pawnless", "time_control": "blitz"},
            series=None,
        )
        # Rook: give realistic sequence counts (no longer used by the WDL chart
        # block, but kept so the conversion_recovery_by_type findings have data).
        rook_conv = ConversionRecoveryStats(
            conversion_pct=65.0,
            conversion_games=30,
            conversion_wins=20,
            conversion_draws=0,
            conversion_losses=10,
            recovery_pct=30.0,
            recovery_games=20,
            recovery_saves=6,
            recovery_wins=4,
            recovery_draws=2,
            # Phase 84 mirror-identity opponent baselines.
            opponent_conversion_pct=70.0,  # recovery_losses(14)/recovery_games(20)*100
            opponent_conversion_games=20,
            opponent_recovery_pct=33.3,  # (conversion_losses(10)+conversion_draws(0))/conversion_games(30)*100
            opponent_recovery_games=30,
        )
        # Pawnless: zero sequences — kept for test intent (filtered anyway by the
        # pawnless endgame_class guard).
        pawnless_conv_stub = ConversionRecoveryStats.model_construct(
            conversion_games=0,
            conversion_wins=0,
            conversion_pct=0.0,
            recovery_games=0,
            recovery_saves=0,
            recovery_pct=0.0,
        )
        categories = [
            EndgameCategoryStats(
                endgame_class="rook",
                label="Rook",
                wins=41,
                draws=12,
                losses=47,
                total=100,
                win_pct=41.0,
                draw_pct=12.0,
                loss_pct=47.0,
                conversion=rook_conv,
            ),
            EndgameCategoryStats(
                endgame_class="pawnless",
                label="Pawnless",
                wins=11,
                draws=5,
                losses=3,
                total=19,
                win_pct=57.9,
                draw_pct=26.3,
                loss_pct=15.8,
                conversion=pawnless_conv_stub,
            ),
        ]
        tab = EndgameTabFindings(
            as_of=datetime.datetime.now(datetime.UTC),
            filters=filters,
            findings=[rook_finding, pawnless_finding],
            type_categories_by_tc={"blitz": categories},
            findings_hash="b" * 64,
        )
        prompt = _assemble_user_prompt(tab)

        # Rook bullet + WDL row present; pawnless stripped from both the bullets
        # (visible-findings filter) and the WDL table (defensive class filter).
        assert "endgame_class=rook" in prompt
        assert "endgame_class=pawnless" not in prompt
        assert "| rook" in prompt
        assert "| pawnless" not in prompt

    def test_bullet_includes_inline_zone_bounds(self) -> None:
        """v7: every finding bullet renders `(typical LO to UP)` next to its zone.

        Covers scalar (score_gap) and bucketed/higher_is_better
        (conversion_win_pct) registry paths. The inline shorthand lets the LLM
        judge proximity to a zone edge without consulting the global appendix.

        Phase 102 UAT: the former net_timeout_rate case was dropped — the
        page-level time_pressure_at_entry subsection is retired, so that metric
        no longer renders as a zoned [summary] bullet.
        """
        from typing import cast

        from app.schemas.insights import MetricId

        filters = _sample_filter_context()
        scalar = SubsectionFinding(
            subsection_id="score_gap",
            parent_subsection_id=None,
            window="all_time",
            metric="score_gap",
            value=-0.15,
            zone="weak",
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=200,
            sample_quality="rich",
            is_headline_eligible=True,
            dimension=None,
            series=None,
        )
        # Phase 102 UAT: conversion_win_pct is now a per-TC metric whose band
        # comes from TC_METRIC_BANDS via the time_control dimension (blitz conv
        # band = 0.667..0.769 → +67 to +77).
        bucketed = SubsectionFinding(
            subsection_id="endgame_metrics_blitz",
            parent_subsection_id=None,
            window="all_time",
            metric=cast(MetricId, "conversion_win_pct"),
            value=0.65,
            zone="weak",
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=100,
            sample_quality="rich",
            is_headline_eligible=True,
            dimension={"time_control": "blitz"},
            series=None,
        )
        tab = _fake_findings(filters, findings=[scalar, bucketed])
        prompt = _assemble_user_prompt(tab)

        # v7 whole-number scale: score_gap band is -10 to +10.
        assert "weak (typical -10 to +10)" in prompt
        # Phase 102 UAT: per-TC blitz conversion band is +67 to +77 (TC_METRIC_BANDS).
        assert "weak (typical +67 to +77)" in prompt
        assert "lower is better" not in prompt  # v7: no lower_is_better metrics left.

    def test_score_gap_subsection_emitted_alongside_wdl_chart(self) -> None:
        """The score_gap scalar renders EVEN WHEN the overall_wdl chart fires.

        Previously (v5 C4) the scalar was dropped when the chart rendered, leaving
        only the score_timeline subsection's bullet — but that bullet's
        `value` is the latest weekly bucket of the rolling timeline, mislabeled
        as `(all_time)`. v9 kept both. Phase 102 UAT: the scalar moved from the
        retired `overall` subsection into the dedicated `score_gap` subsection;
        the chart still shows the WDL decomposition, and the scalar reports the
        all-time aggregate that exactly matches the chart math
        (endgame.score_pct - non_endgame.score_pct).
        """
        from app.schemas.endgames import EndgamePerformanceResponse, EndgameWDLSummary

        scalar = SubsectionFinding(
            subsection_id="score_gap",
            parent_subsection_id=None,
            window="all_time",
            metric="score_gap",
            value=-0.15,
            zone="weak",
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=200,
            sample_quality="rich",
            is_headline_eligible=True,
            dimension=None,
            series=None,
        )
        perf = EndgamePerformanceResponse(
            endgame_wdl=EndgameWDLSummary(
                wins=120,
                draws=40,
                losses=80,
                total=240,
                win_pct=50.0,
                draw_pct=16.7,
                loss_pct=33.3,
            ),
            non_endgame_wdl=EndgameWDLSummary(
                wins=300,
                draws=50,
                losses=350,
                total=700,
                win_pct=42.9,
                draw_pct=7.1,
                loss_pct=50.0,
            ),
            endgame_win_rate=50.0,
        )
        tab = EndgameTabFindings(
            as_of=datetime.datetime.now(datetime.UTC),
            filters=_sample_filter_context(),
            findings=[scalar],
            overall_performance=perf,
            findings_hash="b" * 64,
        )
        prompt = _assemble_user_prompt(tab)

        # Chart renders AND the score_gap [summary score_gap] block renders alongside it.
        assert "### Chart: overall_wdl" in prompt
        assert "### Subsection: score_gap" in prompt
        assert "[summary score_gap]" in prompt
        # The scalar value should be -15 (-0.15 * 100, rounded) — rendered as mean=-15 on the all_time line.
        assert "all_time: mean=-15" in prompt

    def test_all_time_series_trimmed_to_last_36_points(self) -> None:
        """v11: all_time Series block is capped at the most-recent 36 buckets.

        v5 originally capped at 12 to keep the payload short; v11 raised the
        cap to 36 so the LLM can speak about multi-year trajectories without
        overclaiming a 12-month window as "long-term". Older history beyond
        36 months is still trimmed to keep tokens bounded.

        Phase 88.1 (Plan 09): repointed from clock_diff_timeline to
        endgame_elo_timeline after the former subsection was retired alongside
        the cohort layer (REVIEW.md WR-06). endgame_elo_timeline is also
        monthly-for-all_time so the bucket-cap semantics are identical.
        """
        filters = _sample_filter_context()
        # 40 consecutive monthly buckets ending 2025-10: 2022-07 .. 2025-10.
        bucket_starts: list[str] = []
        cursor = datetime.date(2022, 7, 1)
        while cursor <= datetime.date(2025, 10, 1):
            bucket_starts.append(cursor.isoformat())
            # next month (first-of-month arithmetic)
            year, month = cursor.year, cursor.month + 1
            if month > 12:
                year += 1
                month = 1
            cursor = datetime.date(year, month, 1)
        assert len(bucket_starts) == 40
        # Values alternate so the flat-trend collapse (v7 B4) doesn't trigger.
        timeline = SubsectionFinding(
            subsection_id="endgame_elo_timeline",
            parent_subsection_id=None,
            window="all_time",
            metric="endgame_elo_gap",
            value=-40.0,
            zone="typical",
            trend="stable",
            weekly_points_in_window=40,
            sample_size=40,
            sample_quality="rich",
            is_headline_eligible=True,
            dimension={"platform": "lichess", "time_control": "rapid"},
            series=[
                TimePoint(bucket_start=bs, value=-30.0 if i % 2 == 0 else -50.0, n=20)
                for i, bs in enumerate(bucket_starts)
            ],
        )
        tab = _fake_findings(filters, findings=[timeline])
        prompt = _assemble_user_prompt(tab)

        # Most recent 36 buckets are retained: 2022-11 .. 2025-10.
        assert "2025-10-01" in prompt
        assert "2022-11-01" in prompt
        # Oldest 4 buckets are dropped: 2022-07 .. 2022-10.
        assert "2022-07-01" not in prompt
        assert "2022-10-01" not in prompt
        # Exactly 36 series value lines (bucket_start entries, not the header).
        series_lines = [
            ln for ln in prompt.splitlines() if ln.startswith(("2022-", "2023-", "2024-", "2025-"))
        ]
        assert len(series_lines) == 36

    def test_score_timeline_emits_three_summaries_three_series_deterministic_order(self) -> None:
        """Phase 68 v14 (260424-pc6): score_timeline subsection emits THREE [summary] + THREE [series] blocks.

        One finding per distinct metric (endgame_score, non_endgame_score,
        score_gap). No `part=` dim tag — each metric id is unique. Order:
        endgame_score → non_endgame_score → score_gap. All three series are
        pinned to weekly granularity regardless of window. When `n` is
        constant across all points (as here, n=12 on every row), the series
        block carries a single `[n=<N> for every point]` disclosure line and
        drops the `(n=N)` suffix from each bucket row.
        """
        filters = _sample_filter_context()
        endgame_series = [
            TimePoint(
                bucket_start=f"2026-02-{day:02d}",
                value=0.55 + 0.01 * i,
                n=12,
            )
            for i, day in enumerate((2, 9, 16, 23))
        ]
        non_endgame_series = [
            TimePoint(
                bucket_start=f"2026-02-{day:02d}",
                value=0.50 + 0.005 * i,
                n=12,
            )
            for i, day in enumerate((2, 9, 16, 23))
        ]
        gap_series = [
            TimePoint(
                bucket_start=f"2026-02-{day:02d}",
                value=0.05 + 0.005 * i,
                n=24,
            )
            for i, day in enumerate((2, 9, 16, 23))
        ]
        endgame_finding = SubsectionFinding(
            subsection_id="score_timeline",
            parent_subsection_id=None,
            window="last_3mo",
            metric="endgame_score_timeline",
            value=0.565,
            zone="typical",
            trend="improving",
            weekly_points_in_window=4,
            sample_size=40,
            sample_quality="adequate",
            is_headline_eligible=True,
            dimension=None,
            series=endgame_series,
        )
        non_endgame_finding = SubsectionFinding(
            subsection_id="score_timeline",
            parent_subsection_id=None,
            window="last_3mo",
            metric="non_endgame_score_timeline",
            value=0.5075,
            zone="typical",
            trend="stable",
            weekly_points_in_window=4,
            sample_size=40,
            sample_quality="adequate",
            is_headline_eligible=False,
            dimension=None,
            series=non_endgame_series,
        )
        gap_finding = SubsectionFinding(
            subsection_id="score_timeline",
            parent_subsection_id=None,
            window="last_3mo",
            metric="score_gap",
            value=0.0575,
            zone="typical",
            trend="improving",
            weekly_points_in_window=4,
            sample_size=40,
            sample_quality="adequate",
            is_headline_eligible=False,
            dimension=None,
            series=gap_series,
        )
        tab = _fake_findings(
            filters,
            findings=[endgame_finding, non_endgame_finding, gap_finding],
        )
        prompt = _assemble_user_prompt(tab)

        timeline_start = prompt.index("### Subsection: score_timeline")
        timeline_chunk = prompt[timeline_start:]

        # Exactly three [summary <metric>] blocks, one per metric, no dim tag.
        # Phase 82 D-01/D-02: renamed to endgame_score_timeline / non_endgame_score_timeline.
        assert timeline_chunk.count("[summary endgame_score_timeline]") == 1
        assert timeline_chunk.count("[summary non_endgame_score_timeline]") == 1
        assert timeline_chunk.count("[summary score_gap]") == 1
        # No leftover part-dim-tagged summaries.
        assert "part=endgame" not in timeline_chunk
        assert "part=non_endgame" not in timeline_chunk
        # Exactly three [series ...] blocks, pinned weekly regardless of window.
        assert timeline_chunk.count("[series endgame_score_timeline, last_3mo, weekly]") == 1
        assert timeline_chunk.count("[series non_endgame_score_timeline, last_3mo, weekly]") == 1
        assert timeline_chunk.count("[series score_gap, last_3mo, weekly]") == 1
        # Deterministic order: endgame_score_timeline -> non_endgame_score_timeline -> score_gap.
        endgame_idx = timeline_chunk.index("[summary endgame_score_timeline]")
        non_endgame_idx = timeline_chunk.index("[summary non_endgame_score_timeline]")
        gap_idx = timeline_chunk.index("[summary score_gap]")
        assert endgame_idx < non_endgame_idx < gap_idx
        # Constant-n disclosure appears (n=12 for endgame/non_endgame, n=24 for gap)
        # and no per-point (n=12) / (n=24) suffix leaks through.
        assert "[n=12 for every point]" in timeline_chunk
        assert "[n=24 for every point]" in timeline_chunk
        assert "(n=12)" not in timeline_chunk
        assert "(n=24)" not in timeline_chunk
        # No suppression carve-out left behind in the module.
        from app.services.insights_llm import _render_subsection_block as _rsb  # noqa: F401
        import inspect

        source = inspect.getsource(_rsb)
        assert "suppress_summary" not in source


class TestV6Enrichments:
    """Batch 2 (v6) payload enrichments: stale markers, trend tags, asymmetry
    flags, low-time gap scalar, all_time↔last_3mo delta, payload summary."""

    def _finding(
        self,
        *,
        subsection_id: str,
        metric: str,
        window: str,
        value: float,
        zone: str = "typical",
        sample_size: int = 100,
        sample_quality: str = "rich",
        dimension: dict[str, str] | None = None,
        series: list[TimePoint] | None = None,
    ) -> SubsectionFinding:
        from typing import cast

        from app.schemas.insights import MetricId, SampleQuality, SubsectionId, Window, Zone

        return SubsectionFinding(
            subsection_id=cast(SubsectionId, subsection_id),
            parent_subsection_id=None,
            window=cast(Window, window),
            metric=cast(MetricId, metric),
            value=value,
            zone=cast(Zone, zone),
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=sample_size,
            sample_quality=cast(SampleQuality, sample_quality),
            is_headline_eligible=True,
            dimension=dimension,
            series=series,
        )

    def test_payload_summary_block_rendered(self) -> None:
        """`## Payload summary` prepends the prompt with macro context."""
        from app.schemas.endgames import EndgamePerformanceResponse, EndgameWDLSummary

        filters = _sample_filter_context()
        series_finding = self._finding(
            subsection_id="score_timeline",
            metric="score_gap",
            window="all_time",
            value=-0.05,
            dimension={"part": "endgame"},
            series=[
                TimePoint(bucket_start=f"2026-01-{week:02d}", value=-0.05, n=50)
                for week in (5, 12, 19, 26)
            ],
        )
        perf = EndgamePerformanceResponse(
            endgame_wdl=EndgameWDLSummary(
                wins=120, draws=40, losses=80, total=240, win_pct=50.0, draw_pct=16.7, loss_pct=33.3
            ),
            non_endgame_wdl=EndgameWDLSummary(
                wins=300, draws=50, losses=350, total=700, win_pct=42.9, draw_pct=7.1, loss_pct=50.0
            ),
            endgame_win_rate=50.0,
        )
        tab = EndgameTabFindings(
            as_of=datetime.datetime.now(datetime.UTC),
            filters=filters,
            findings=[series_finding],
            overall_performance=perf,
            findings_hash="b" * 64,
        )
        prompt = _assemble_user_prompt(tab)
        assert "## Payload summary" in prompt
        assert "Total games in scope: 940" in prompt
        assert "Newest bucket across all series: 2026-01-26" in prompt
        # v9: Filters: line is no longer emitted at defaults.
        assert "Filters:" not in prompt

    def test_stale_marker_on_old_endgame_elo_gap(self) -> None:
        """A combo whose series trails >6mo behind the newest bucket is STALE-tagged."""
        filters = _sample_filter_context()
        old_series = [
            TimePoint(bucket_start=f"2023-{month:02d}-01", value=0.6, n=15)
            for month in (9, 10, 11, 12)
        ]
        new_series = [
            TimePoint(bucket_start=f"2026-{month:02d}-01", value=-0.42, n=20) for month in (1, 2)
        ] + [
            TimePoint(bucket_start=f"2025-{month:02d}-01", value=-0.42, n=20) for month in (11, 12)
        ]
        new_series.sort(key=lambda pt: pt.bucket_start)
        blitz_old = self._finding(
            subsection_id="endgame_elo_timeline",
            metric="endgame_elo_gap",
            window="all_time",
            value=60.0,
            dimension={"platform": "chess.com", "time_control": "blitz"},
            series=old_series,
            sample_size=60,
        )
        rapid_new = self._finding(
            subsection_id="endgame_elo_timeline",
            metric="endgame_elo_gap",
            window="all_time",
            value=-42.0,
            dimension={"platform": "chess.com", "time_control": "rapid"},
            series=new_series,
            sample_size=70,
        )
        tab = _fake_findings(filters, findings=[blitz_old, rapid_new])
        prompt = _assemble_user_prompt(tab)

        # Stale blitz combo's all_time line carries the `stale:` marker;
        # rapid combo's all_time line does not.
        blitz_summary_idx = next(
            i
            for i, ln in enumerate(prompt.splitlines())
            if ln == "[summary endgame_elo_gap | platform=chess.com, time_control=blitz]"
        )
        rapid_summary_idx = next(
            i
            for i, ln in enumerate(prompt.splitlines())
            if ln == "[summary endgame_elo_gap | platform=chess.com, time_control=rapid]"
        )
        prompt_lines = prompt.splitlines()
        # The `all_time:` line sits immediately below its [summary] header.
        blitz_all_time_line = prompt_lines[blitz_summary_idx + 1]
        rapid_all_time_line = prompt_lines[rapid_summary_idx + 1]
        assert "stale:" in blitz_all_time_line
        assert "stale:" not in rapid_all_time_line
        # Summary counts the stale series.
        assert "Stale series" in prompt

    def test_trend_emitted_on_summary_window_line(self) -> None:
        """v10: `trend=improving` rides the [summary] window line, not a separate tag.

        Phase 68 dropped the score_gap_timeline suppression carve-out, so
        every timeline subsection emits a [summary] block now. This test
        verifies that timeseries [summary] lines carry `trend=` / `std=`
        fields (the same format score_timeline now also emits for each
        per-part finding).

        Phase 88.1 (Plan 09): repointed from clock_diff_timeline to
        endgame_elo_timeline after the former subsection was retired
        alongside the cohort layer (REVIEW.md WR-06).
        """
        filters = _sample_filter_context()
        series = [
            TimePoint(bucket_start=f"2026-01-{day:02d}", value=v, n=30)
            for day, v in zip((5, 12, 19, 26), (-25.0, -20.0, -10.0, -2.0), strict=False)
        ]
        finding = self._finding(
            subsection_id="endgame_elo_timeline",
            metric="endgame_elo_gap",
            window="last_3mo",
            value=-2.0,
            series=series,
            dimension={"platform": "lichess", "time_control": "rapid"},
        )
        tab = _fake_findings(filters, findings=[finding])
        prompt = _assemble_user_prompt(tab)

        # The summary block's last_3mo line carries trend= and std=.
        lines = prompt.splitlines()
        summary_idx = next(
            i for i, ln in enumerate(lines) if ln.startswith("[summary endgame_elo_gap")
        )
        last_3mo_line = lines[summary_idx + 1]
        assert last_3mo_line.startswith("  last_3mo: ")
        assert "trend=improving" in last_3mo_line  # latest -2 vs prior-mean -18.3 → improving
        assert "std=" in last_3mo_line
        # Raw [series ...] still emits for the timeline data.
        assert "[series endgame_elo_gap, last_3mo, weekly" in prompt

    def test_asymmetry_line_emitted_for_strong_weak_split(self) -> None:
        """Pawn with strong conversion + weak recovery emits `[asymmetry type=pawn] ...`.

        v16: pawn now uses the standard "closes winning / defends losing"
        framing alongside every other endgame class. Section 6 benchmark
        data shows queen has the largest conversion/recovery asymmetry, not
        pawn — the v11 pawn special case was reasoned from chess theory, not
        from population data, and the data does not back it.
        """
        filters = _sample_filter_context()
        conv = self._finding(
            subsection_id="endgame_type_blitz",
            metric="conversion_win_pct",
            window="all_time",
            value=0.77,
            zone="strong",
            dimension={"endgame_class": "pawn", "time_control": "blitz"},
        )
        rec = self._finding(
            subsection_id="endgame_type_blitz",
            metric="recovery_save_pct",
            window="all_time",
            value=0.16,
            zone="weak",
            dimension={"endgame_class": "pawn", "time_control": "blitz"},
        )
        tab = _fake_findings(filters, findings=[conv, rec])
        prompt = _assemble_user_prompt(tab)

        assert "[asymmetry type=pawn tc=blitz] conversion=77 strong, recovery=16 weak" in prompt
        assert "closes winning endgames but bleeds losing ones" in prompt
        # v16: the v11 "expected asymmetry — pawn endgames amplify material
        # imbalance" framing is gone. Pawn now uses the same story text as
        # every other class.
        assert "expected asymmetry" not in prompt
        assert "amplify material imbalance" not in prompt

    def test_asymmetry_line_uses_standard_story_for_non_pawn_types(self) -> None:
        """Rook with strong conversion + weak recovery uses the standard story text."""
        filters = _sample_filter_context()
        conv = self._finding(
            subsection_id="endgame_type_blitz",
            metric="conversion_win_pct",
            window="all_time",
            value=0.80,
            zone="strong",
            dimension={"endgame_class": "rook", "time_control": "blitz"},
        )
        rec = self._finding(
            subsection_id="endgame_type_blitz",
            metric="recovery_save_pct",
            window="all_time",
            value=0.18,
            zone="weak",
            dimension={"endgame_class": "rook", "time_control": "blitz"},
        )
        tab = _fake_findings(filters, findings=[conv, rec])
        prompt = _assemble_user_prompt(tab)

        assert "[asymmetry type=rook tc=blitz] conversion=80 strong, recovery=18 weak" in prompt
        assert "closes winning endgames but bleeds losing ones" in prompt

    # Phase 88.1 (Plan 09, REVIEW.md WR-06): test_low_time_gap_line_emitted_in_time_pressure_chart
    # removed alongside _low_time_gap_line + _format_time_pressure_chart_block deletion.

    def test_summary_emitted_for_paired_windows(self) -> None:
        """Paired all_time + last_3mo scalars fold into one [summary] block with a within-noise shift.

        Phase 87.4 (D-05): the original fixture used metric=``endgame_skill``
        which was retired. Repointed to ``win_rate`` which has the same
        [0.45, 0.55] zone band shape so the summary / shift / within-noise
        assertions retain their semantics. Phase 102 UAT: the retired aggregate
        ``endgame_metrics`` subsection is no longer in _SECTION_LAYOUT, so the
        fixture now lives under a per-TC ``endgame_metrics_blitz`` subsection
        (win_rate is dimensionless, so the paired-window fold is unchanged).
        """
        filters = _sample_filter_context()
        at = self._finding(
            subsection_id="endgame_metrics_blitz",
            metric="win_rate",
            window="all_time",
            value=0.45,
            sample_size=2948,
        )
        lm = self._finding(
            subsection_id="endgame_metrics_blitz",
            metric="win_rate",
            window="last_3mo",
            value=0.49,
            sample_size=195,
        )
        tab = _fake_findings(filters, findings=[at, lm])
        prompt = _assemble_user_prompt(tab)

        assert "[summary win_rate]" in prompt
        assert "all_time: mean=+45, n=2948" in prompt
        assert "last_3mo: mean=+49, n=195" in prompt
        # Shift line closes the block with a within-noise flag.
        assert "shift=+4, within-noise" in prompt

    def test_player_profile_stale_combo_emits_no_recent_trajectory(self) -> None:
        """A stale combo carries `stale: ...` on all_time and `last_3mo: no data`.

        The old free-text trajectory ("+93 over 3 months") silently misled on
        stale combos because it was anchored to the combo's last game date,
        not calendar-now. v10 format replaces it with calendar-anchored
        last_3mo stats, so a stale combo structurally cannot imply recent
        activity.
        """
        from app.schemas.insights import PlayerProfileEntry

        filters = _sample_filter_context()
        stale_entry = PlayerProfileEntry(
            platform="chess.com",
            time_control="blitz",
            games=820,
            current_elo=1293,
            min_elo=819,
            max_elo=1300,
            window_days=1099,
            all_time_mean=1204,
            all_time_n=820,
            all_time_buckets=64,
            all_time_trend="flat",
            all_time_std=125,
            last_3mo_mean=None,
            last_3mo_n=None,
            last_3mo_buckets=None,
            last_3mo_trend=None,
            last_3mo_std=None,
            stale_last_bucket="2024-01",
            stale_months=27,
        )
        live_entry = PlayerProfileEntry(
            platform="lichess",
            time_control="rapid",
            games=450,
            current_elo=1782,
            min_elo=1655,
            max_elo=1839,
            window_days=161,
            all_time_mean=1750,
            all_time_n=450,
            all_time_buckets=23,
            all_time_trend="flat",
            all_time_std=45,
            last_3mo_mean=1775,
            last_3mo_n=210,
            last_3mo_buckets=12,
            last_3mo_trend="flat",
            last_3mo_std=30,
        )
        tab = EndgameTabFindings(
            as_of=datetime.datetime.now(datetime.UTC),
            filters=filters,
            findings=[],
            player_profile=[stale_entry, live_entry],
            findings_hash="b" * 64,
        )
        prompt = _assemble_user_prompt(tab)

        # Stale blitz combo: all_time carries `stale:`, last_3mo reads "no data".
        blitz_header = "[summary actual_elo | platform=chess.com, time_control=blitz]"
        assert blitz_header in prompt
        lines = prompt.splitlines()
        blitz_idx = lines.index(blitz_header)
        blitz_at_line = lines[blitz_idx + 1]
        blitz_lm_line = lines[blitz_idx + 2]
        assert blitz_at_line.startswith("  all_time: ")
        assert "stale: last 2024-01 (27 mo ago)" in blitz_at_line
        assert blitz_lm_line == "  last_3mo: no data"

        # Live lichess combo: no `stale:` marker, populated last_3mo line.
        live_header = "[summary actual_elo | platform=lichess, time_control=rapid]"
        live_idx = lines.index(live_header)
        live_at_line = lines[live_idx + 1]
        live_lm_line = lines[live_idx + 2]
        assert "stale:" not in live_at_line
        assert live_lm_line.startswith("  last_3mo: ")
        assert live_lm_line != "  last_3mo: no data"

        # The old free-text trajectory must NOT appear anywhere in the prompt.
        assert "over 3 months" not in prompt

    def test_endgame_elo_summary_emitted_before_gap_summary(self) -> None:
        """Phase 87.5 D-06 restore: `[summary endgame_elo | ...]`
        precedes `[summary endgame_elo_gap | ...]`.

        The Endgame ELO Timeline chart's headline value is the absolute
        skill-adjusted Endgame ELO (dashed line), not the gap. The derived
        endgame_elo summary is computed from the same retained series points
        as the gap summary (mean = weighted mean of actual_elo + gap), and
        rendered immediately above the gap summary so the LLM cites the
        chart's primary value, not the derived deviation.
        """
        filters = _sample_filter_context()
        # Series of 4 buckets so trend is computed: actual_elo rising 1450 →
        # 1500, gap holding around -40. Weighted mean endgame_elo per bucket
        # = actual_elo + gap.
        series = [
            TimePoint(bucket_start="2025-10-01", value=-40.0, n=10, actual_elo=1450),
            TimePoint(bucket_start="2025-11-01", value=-45.0, n=20, actual_elo=1470),
            TimePoint(bucket_start="2025-12-01", value=-40.0, n=15, actual_elo=1490),
            TimePoint(bucket_start="2026-01-01", value=-35.0, n=15, actual_elo=1500),
        ]
        finding = self._finding(
            subsection_id="endgame_elo_timeline",
            metric="endgame_elo_gap",
            window="all_time",
            value=-40.0,
            zone="typical",
            dimension={"platform": "chess.com", "time_control": "rapid"},
            series=series,
            sample_size=60,
        )
        tab = _fake_findings(filters, findings=[finding])
        prompt = _assemble_user_prompt(tab)

        elo_header = "[summary endgame_elo | platform=chess.com, time_control=rapid]"
        gap_header = "[summary endgame_elo_gap | platform=chess.com, time_control=rapid]"
        assert elo_header in prompt
        assert gap_header in prompt
        elo_idx = prompt.index(elo_header)
        gap_idx = prompt.index(gap_header)
        assert elo_idx < gap_idx, "endgame_elo summary must precede endgame_elo_gap summary"

        # Weighted mean endgame_elo: (1410*10 + 1425*20 + 1450*15 + 1465*15) / 60
        # = (14100 + 28500 + 21750 + 21975) / 60 = 86325 / 60 ≈ 1439.
        elo_block_lines = prompt[elo_idx:].splitlines()
        all_time_line = elo_block_lines[1]
        assert all_time_line.startswith("  all_time: ")
        assert "mean=+1439 Elo" in all_time_line
        assert "buckets=4 (monthly)" in all_time_line
        # endgame_elo summary has no zone/quality fields (no calibrated band).
        assert "zone=" not in all_time_line
        assert "quality=" not in all_time_line

    def test_endgame_elo_summary_skipped_when_actual_elo_missing(self) -> None:
        """No endgame_elo summary emitted if series points lack actual_elo.

        Defensive: actual_elo is only populated for endgame_elo_timeline series
        upstream. If the upstream pipeline regresses and stops setting it, the
        derived summary should silently fall back to gap-only rather than
        emitting a meaningless block.
        """
        filters = _sample_filter_context()
        series = [
            TimePoint(bucket_start=f"2026-01-{day:02d}", value=-40.0, n=15)
            for day in (5, 12, 19, 26)
        ]
        finding = self._finding(
            subsection_id="endgame_elo_timeline",
            metric="endgame_elo_gap",
            window="all_time",
            value=-40.0,
            dimension={"platform": "chess.com", "time_control": "rapid"},
            series=series,
        )
        tab = _fake_findings(filters, findings=[finding])
        prompt = _assemble_user_prompt(tab)

        assert "[summary endgame_elo |" not in prompt
        assert "[summary endgame_elo_gap |" in prompt

    def test_payload_summary_includes_all_time_window(self) -> None:
        """v11: payload summary spells out the all-time series window bounds.

        Phase 88.1 (Plan 09): repointed from clock_diff_timeline to
        endgame_elo_timeline after the former subsection was retired
        alongside the cohort layer (REVIEW.md WR-06). endgame_elo_timeline
        is also monthly-for-all_time so the window-bounds assertion is
        unchanged.
        """
        filters = _sample_filter_context()
        series = [
            TimePoint(bucket_start=f"2024-{month:02d}-01", value=-5.0, n=20)
            for month in (1, 4, 7, 10)
        ] + [
            TimePoint(bucket_start=f"2026-{month:02d}-01", value=-5.0, n=20) for month in (1, 2, 3)
        ]
        finding = self._finding(
            subsection_id="endgame_elo_timeline",
            metric="endgame_elo_gap",
            window="all_time",
            value=-5.0,
            series=series,
            dimension={"platform": "lichess", "time_control": "rapid"},
        )
        tab = _fake_findings(filters, findings=[finding])
        prompt = _assemble_user_prompt(tab)

        assert "All-time series window: 2024-01 → 2026-03" in prompt
        # Cap value is mentioned so the LLM knows the trim policy.
        assert "capped at 36 monthly buckets per series" in prompt


# ---------------------------------------------------------------------------
# TestSparseHistoryFixes — v27 fixes A/B/C for short-history users.
# See `.planning/debug/llm-prompt-missing-sections.md`.
# ---------------------------------------------------------------------------


class TestSparseHistoryFixes:
    """Regression tests for the v27 sparse-history rescue (Fixes A, B, C)."""

    def test_fix_a_all_time_c2_trimmed_to_empty_does_not_suppress_last_3mo_series(
        self,
    ) -> None:
        """Fix A: when the all_time series filters to empty (every point inside
        the C2 cutoff window), the last_3mo `[series ...]` block MUST still render.

        Before Fix A, `all_time_series_pairs` was keyed on raw `f.series is not None`
        so the pair entered the set even when the post-C2 retained list was empty.
        That made the C5 gate suppress the last_3mo series block too — the LLM
        saw [summary] lines pointing at no series data.
        """
        filters = _sample_filter_context()
        today = datetime.date.today()
        # All all_time points fall inside the last 90 days → C2 trims to empty.
        recent_buckets = [
            (today - datetime.timedelta(days=days)).isoformat() for days in (60, 45, 30, 15)
        ]
        all_time_finding = SubsectionFinding(
            subsection_id="score_timeline",
            parent_subsection_id=None,
            window="all_time",
            metric="endgame_score_timeline",
            value=0.55,
            zone="typical",
            trend="stable",
            weekly_points_in_window=4,
            sample_size=40,
            sample_quality="adequate",
            is_headline_eligible=False,
            dimension=None,
            series=[TimePoint(bucket_start=bs, value=0.55, n=10) for bs in recent_buckets],
        )
        last_3mo_finding = SubsectionFinding(
            subsection_id="score_timeline",
            parent_subsection_id=None,
            window="last_3mo",
            metric="endgame_score_timeline",
            value=0.55,
            zone="typical",
            trend="stable",
            weekly_points_in_window=4,
            sample_size=40,
            sample_quality="adequate",
            is_headline_eligible=False,
            dimension=None,
            series=[TimePoint(bucket_start=bs, value=0.55, n=10) for bs in recent_buckets],
        )
        tab = _fake_findings(filters, findings=[all_time_finding, last_3mo_finding])
        prompt = _assemble_user_prompt(tab)

        # The last_3mo series header MUST appear — proves C5 did not suppress it.
        assert "[series endgame_score_timeline, last_3mo, weekly]" in prompt
        # And at least one of the bucket dates must render below it.
        assert any(bs in prompt for bs in recent_buckets)

    def test_fix_b_sparse_player_profile_renders_sparse_anchor_tag(self) -> None:
        """Fix B: when every PlayerProfileEntry carries quality='sparse', the
        anchor tag swaps for `[anchor-combo] sparse-history — narrate cautiously...`
        and per-entry blocks suppress `trend=` / `std=`.

        This is what prevents the LLM from hallucinating a player_profile from
        non-existent anchor data (the failure mode from llm_logs.id=73 in dev).
        """
        from app.schemas.insights import PlayerProfileEntry

        filters = _sample_filter_context()
        sparse_entry = PlayerProfileEntry(
            platform="chess.com",
            time_control="bullet",
            games=361,
            current_elo=1380,
            min_elo=1290,
            max_elo=1410,
            window_days=54,
            all_time_mean=1355,
            all_time_n=361,
            all_time_buckets=7,
            all_time_trend="flat",  # value present but renderer must suppress it
            all_time_std=35,
            last_3mo_mean=1370,
            last_3mo_n=361,
            last_3mo_buckets=7,
            last_3mo_trend=None,
            last_3mo_std=20,
            quality="sparse",
        )
        tab = EndgameTabFindings(
            as_of=datetime.datetime.now(datetime.UTC),
            filters=filters,
            findings=[],
            player_profile=[sparse_entry],
            findings_hash="c" * 64,
        )
        prompt = _assemble_user_prompt(tab)

        assert "## Player profile" in prompt
        assert "[anchor-combo] sparse-history" in prompt
        # The full-history anchor tag must NOT appear (only sparse-history).
        assert "[anchor-combo platform=" not in prompt
        # all_time line must carry `quality=sparse` and MUST NOT carry trend / std.
        lines = prompt.splitlines()
        bullet_idx = lines.index("[summary actual_elo | platform=chess.com, time_control=bullet]")
        at_line = lines[bullet_idx + 1]
        lm_line = lines[bullet_idx + 2]
        assert "quality=sparse" in at_line
        assert "trend=" not in at_line
        assert "std=" not in at_line
        assert "quality=sparse" in lm_line
        assert "trend=" not in lm_line
        assert "std=" not in lm_line

    def test_fix_b_full_player_profile_keeps_original_anchor_tag(self) -> None:
        """Fix B regression: a non-sparse profile must still render the
        live-anchor tag with the platform/time_control fields and full
        trend/std on each entry. Sparse rendering only kicks in when EVERY
        entry has quality='sparse'."""
        from app.schemas.insights import PlayerProfileEntry

        filters = _sample_filter_context()
        full_entry = PlayerProfileEntry(
            platform="lichess",
            time_control="rapid",
            games=450,
            current_elo=1782,
            min_elo=1655,
            max_elo=1839,
            window_days=161,
            all_time_mean=1750,
            all_time_n=450,
            all_time_buckets=23,
            all_time_trend="flat",
            all_time_std=45,
            last_3mo_mean=1775,
            last_3mo_n=210,
            last_3mo_buckets=12,
            last_3mo_trend="flat",
            last_3mo_std=30,
            quality="full",
        )
        tab = EndgameTabFindings(
            as_of=datetime.datetime.now(datetime.UTC),
            filters=filters,
            findings=[],
            player_profile=[full_entry],
            findings_hash="d" * 64,
        )
        prompt = _assemble_user_prompt(tab)

        assert "[anchor-combo platform=lichess, time_control=rapid]" in prompt
        assert "sparse-history" not in prompt
        assert "trend=flat" in prompt
        assert "std=45" in prompt
        assert "quality=sparse" not in prompt

    def test_fix_c_endgame_elo_timeline_sentinel_when_no_findings(self) -> None:
        """Fix C: even when every (platform, time_control) combo is below
        SPARSE_COMBO_FLOOR (so `_findings_endgame_elo_timeline` emits zero
        findings), the `### Subsection: endgame_elo_timeline` header MUST
        still render with a sentinel `[no qualifying combo ...]` line.

        Before Fix C the entire subsection vanished from `## Section: overall`,
        which left the LLM with no signal that the chart exists.
        """
        from app.services.insights_service import SPARSE_COMBO_FLOOR

        filters = _sample_filter_context()
        # Empty findings list → no endgame_elo_timeline finding emitted.
        tab = _fake_findings(filters, findings=[])
        prompt = _assemble_user_prompt(tab)

        assert "### Subsection: endgame_elo_timeline" in prompt
        assert "[no qualifying combo" in prompt
        assert str(SPARSE_COMBO_FLOOR) in prompt


# ---------------------------------------------------------------------------
# TestHappyPath
# ---------------------------------------------------------------------------


class TestHappyPath:
    @pytest.mark.asyncio
    async def test_generate_insights_fresh_miss(
        self,
        fake_insights_agent: Any,
        fresh_test_user: User,
        test_engine: AsyncEngine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Fresh miss: returns status='fresh', writes exactly one llm_logs row."""
        report = _sample_report()
        fake_insights_agent(report)

        monkeypatch.setattr(
            "app.services.insights_llm.compute_findings",
            lambda fc, sess, uid: _fake_compute_findings(fc, sess, uid),
        )

        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            response = await generate_insights(
                _sample_filter_context(), fresh_test_user.id, session
            )

        assert response.status == "fresh"
        assert response.report.overview == report.overview
        assert response.report.sections[0].section_id == "overall"

        # Verify exactly one llm_logs row written with cache_hit=False + response_json set.
        # Note: the "test" model is unknown to genai-prices so the row's error field
        # will contain "cost_unknown:test" (not NULL). We query directly by user_id +
        # findings_hash rather than via get_latest_log_by_hash which filters error IS NULL.
        from sqlalchemy import select as sa_select
        from app.models.llm_log import LlmLog as LlmLogModel

        async with session_maker() as session:
            result = await session.execute(
                sa_select(LlmLogModel)
                .where(
                    LlmLogModel.user_id == fresh_test_user.id,
                    LlmLogModel.findings_hash == "b" * 64,
                    LlmLogModel.cache_hit.is_(False),
                )
                .order_by(LlmLogModel.created_at.desc())
                .limit(1)
            )
            log = result.scalar_one_or_none()
        assert log is not None
        assert log.cache_hit is False
        assert log.response_json is not None


# ---------------------------------------------------------------------------
# TestCacheBehavior
# ---------------------------------------------------------------------------


class TestMetadataOverride:
    """260422-tnb A3: server-side override of model_used + prompt_version."""

    @pytest.mark.asyncio
    async def test_generate_insights_overrides_model_used_and_prompt_version(
        self,
        fake_insights_agent: Any,
        fresh_test_user: User,
        test_engine: AsyncEngine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Fabricated LLM output for model_used/prompt_version is overwritten server-side.

        The LLM can (and has — see review of gemini-3-flash-preview run) return
        "gpt-4o-2024-05-13" as model_used. The service must override both
        fields after _run_agent returns so the user-facing response and the
        persisted llm_logs row both reflect the actual configured values.
        """
        # Simulate a fabricated report from the LLM.
        fabricated = EndgameInsightsReport(
            player_profile="Fabricated player profile.",
            overview="Fabricated overview.",
            recommendations=["Fabricated rec one.", "Fabricated rec two."],
            sections=[
                SectionInsight(
                    section_id="overall",
                    headline="A headline",
                    bullets=["a bullet"],
                ),
            ],
            model_used="FABRICATED",
            prompt_version="WRONG",
        )
        fake_insights_agent(fabricated)

        # Unique findings_hash — the cache-lookup is global (not per-user), so
        # we must not collide with any row left behind by the router tests which
        # seed rows with hashes like "m"*64 and do NOT tear them down.
        import uuid as _uuid

        findings_hash = _uuid.uuid4().hex + _uuid.uuid4().hex  # 64 lowercase hex
        monkeypatch.setattr(
            "app.services.insights_llm.compute_findings",
            lambda fc, sess, uid: _fake_compute_findings(
                fc, sess, uid, findings_hash=findings_hash
            ),
        )

        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            response = await generate_insights(
                _sample_filter_context(), fresh_test_user.id, session
            )

        # Response carries the overridden values — never "FABRICATED" or "WRONG".
        assert response.status == "fresh"
        assert response.report.model_used == insights_llm.settings.PYDANTIC_AI_MODEL_INSIGHTS
        # Phase 102 UAT: bumped from endgame_v35 to endgame_v40.
        assert response.report.prompt_version == "endgame_v47"

        # Log row's response_json also carries the overridden values (the override
        # happens BEFORE create_llm_log per A3). Query by findings_hash (unique
        # per-test) rather than filtering by error IS NULL — the "test" model is
        # unknown to genai-prices so the row's error column will contain
        # "cost_unknown:test". We query directly since we know our hash is unique.
        from sqlalchemy import select as sa_select
        from app.models.llm_log import LlmLog as LlmLogModel

        async with session_maker() as session:
            result = await session.execute(
                sa_select(LlmLogModel)
                .where(
                    LlmLogModel.user_id == fresh_test_user.id,
                    LlmLogModel.findings_hash == findings_hash,
                )
                .order_by(LlmLogModel.created_at.desc())
                .limit(1)
            )
            log = result.scalar_one_or_none()
        assert log is not None, f"no log row for findings_hash={findings_hash}"
        assert log.response_json is not None
        assert log.response_json["model_used"] == insights_llm.settings.PYDANTIC_AI_MODEL_INSIGHTS
        assert log.response_json["prompt_version"] == "endgame_v47"


class TestCacheBehavior:
    @pytest.mark.asyncio
    async def test_second_call_cache_hits(
        self,
        fake_insights_agent: Any,
        fresh_test_user: User,
        test_engine: AsyncEngine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A seeded cache row (error=None) causes the next call to return cache_hit.

        Note: the cache key is now structural (260425-dxh): the lookup runs via
        get_latest_successful_log_for_user on (user_id, prompt_version, model,
        opponent_strength) — findings_hash is no longer part of the key. The
        test provider "test" is unknown to genai-prices, so any row written by
        generate_insights itself gets error="cost_unknown:test" and would NOT
        be returned by the lookup (which filters error IS NULL). We seed a
        clean cache row manually to test the cache-hit branch directly.
        """
        report = _sample_report()
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)

        # Seed a cache-hit eligible row: error=None, response_json set,
        # matching (user_id, prompt_version=current, model="test",
        # opponent_strength="any" via filter_context).
        # _make_log_row defaults prompt_version to insights_llm._PROMPT_VERSION.
        async with session_maker() as session:
            await _seed(
                session,
                _make_log_row(
                    fresh_test_user.id,
                    model="test",
                    findings_hash="b" * 64,
                    response_json=report.model_dump(),
                    error=None,
                ),
            )

        fake_insights_agent(report)
        monkeypatch.setattr(
            "app.services.insights_llm.compute_findings",
            lambda fc, sess, uid: _fake_compute_findings(fc, sess, uid),
        )

        # Call returns cache_hit because the seeded row matches (prompt_version + model).
        async with session_maker() as session:
            r = await generate_insights(_sample_filter_context(), fresh_test_user.id, session)
        assert r.status == "cache_hit"

    @pytest.mark.asyncio
    async def test_prompt_version_bump_misses(
        self,
        fake_insights_agent: Any,
        fresh_test_user: User,
        test_engine: AsyncEngine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A row with an old prompt_version does not count as a cache hit."""
        report = _sample_report()
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)

        # Seed a row with old prompt version
        async with session_maker() as session:
            await _seed(
                session,
                _make_log_row(
                    fresh_test_user.id,
                    prompt_version="endgame_v0",
                    model="test",
                    findings_hash="b" * 64,
                    response_json=report.model_dump(),
                ),
            )

        fake_insights_agent(report)
        monkeypatch.setattr(
            "app.services.insights_llm.compute_findings",
            lambda fc, sess, uid: _fake_compute_findings(fc, sess, uid),
        )

        async with session_maker() as session:
            r = await generate_insights(_sample_filter_context(), fresh_test_user.id, session)
        # Should be fresh — old prompt_version doesn't match _PROMPT_VERSION
        assert r.status == "fresh"

    @pytest.mark.asyncio
    async def test_model_swap_misses(
        self,
        fake_insights_agent: Any,
        fresh_test_user: User,
        test_engine: AsyncEngine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A row with a different model does not count as a cache hit."""
        report = _sample_report()
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)

        # Seed a row with different model
        async with session_maker() as session:
            await _seed(
                session,
                _make_log_row(
                    fresh_test_user.id,
                    model="google:gemini-3.5-flash",
                    findings_hash="b" * 64,
                    response_json=report.model_dump(),
                ),
            )

        fake_insights_agent(report)
        monkeypatch.setattr(
            "app.services.insights_llm.compute_findings",
            lambda fc, sess, uid: _fake_compute_findings(fc, sess, uid),
        )

        async with session_maker() as session:
            r = await generate_insights(_sample_filter_context(), fresh_test_user.id, session)
        # Should be fresh — model "test" != "google:gemini-3.5-flash"
        assert r.status == "fresh"


class TestStructuralCacheInvalidation:
    """Tests for the 260425-dxh structural cache:
    (user_id, prompt_version, model, opponent_strength) + import freshness + 30d TTL.
    """

    @pytest.mark.asyncio
    async def test_import_with_new_games_invalidates_cache(
        self,
        fake_insights_agent: Any,
        fresh_test_user: User,
        test_engine: AsyncEngine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A completed import with games_imported > 0 after the cached row
        was written invalidates the cache: next call must be fresh."""
        from sqlalchemy import delete

        from app.models.import_job import ImportJob

        report = _sample_report()
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)

        old = datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=2)
        newer = datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=1)
        async with session_maker() as session:
            await _seed(
                session,
                _make_log_row(
                    fresh_test_user.id,
                    created_at=old,
                    response_json=report.model_dump(),
                ),
            )
            session.add(
                ImportJob(
                    id="job-with-games",
                    user_id=fresh_test_user.id,
                    platform="chess.com",
                    username="dxhuser",
                    status="completed",
                    games_fetched=42,
                    games_imported=42,
                    started_at=newer,
                    completed_at=newer,
                )
            )
            await session.commit()

        fake_insights_agent(report)
        monkeypatch.setattr(
            "app.services.insights_llm.compute_findings",
            lambda fc, sess, uid: _fake_compute_findings(fc, sess, uid),
        )

        async with session_maker() as session:
            r = await generate_insights(_sample_filter_context(), fresh_test_user.id, session)
        assert r.status == "fresh"

        # Cleanup the seeded ImportJob row.
        async with session_maker() as session:
            await session.execute(delete(ImportJob).where(ImportJob.id == "job-with-games"))
            await session.commit()

    @pytest.mark.asyncio
    async def test_no_op_import_does_not_invalidate(
        self,
        fake_insights_agent: Any,
        fresh_test_user: User,
        test_engine: AsyncEngine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A completed import with games_imported = 0 (daily resync that
        fetched nothing new) must NOT invalidate the cache."""
        from sqlalchemy import delete

        from app.models.import_job import ImportJob

        report = _sample_report()
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)

        old = datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=2)
        newer = datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=1)
        async with session_maker() as session:
            await _seed(
                session,
                _make_log_row(
                    fresh_test_user.id,
                    created_at=old,
                    response_json=report.model_dump(),
                ),
            )
            session.add(
                ImportJob(
                    id="job-no-games",
                    user_id=fresh_test_user.id,
                    platform="chess.com",
                    username="dxhuser",
                    status="completed",
                    games_fetched=0,
                    games_imported=0,
                    started_at=newer,
                    completed_at=newer,
                )
            )
            await session.commit()

        fake_insights_agent(report)
        monkeypatch.setattr(
            "app.services.insights_llm.compute_findings",
            lambda fc, sess, uid: _fake_compute_findings(fc, sess, uid),
        )

        async with session_maker() as session:
            r = await generate_insights(_sample_filter_context(), fresh_test_user.id, session)
        assert r.status == "cache_hit"

        async with session_maker() as session:
            await session.execute(delete(ImportJob).where(ImportJob.id == "job-no-games"))
            await session.commit()

    @pytest.mark.asyncio
    async def test_ttl_expiry_misses(
        self,
        fake_insights_agent: Any,
        fresh_test_user: User,
        test_engine: AsyncEngine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A cached row older than INSIGHTS_CACHE_MAX_AGE_DAYS is treated as a miss."""
        from app.services.insights_llm import INSIGHTS_CACHE_MAX_AGE_DAYS

        report = _sample_report()
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)

        too_old = datetime.datetime.now(datetime.UTC) - datetime.timedelta(
            days=INSIGHTS_CACHE_MAX_AGE_DAYS + 1
        )
        async with session_maker() as session:
            await _seed(
                session,
                _make_log_row(
                    fresh_test_user.id,
                    created_at=too_old,
                    response_json=report.model_dump(),
                ),
            )

        fake_insights_agent(report)
        monkeypatch.setattr(
            "app.services.insights_llm.compute_findings",
            lambda fc, sess, uid: _fake_compute_findings(fc, sess, uid),
        )

        async with session_maker() as session:
            r = await generate_insights(_sample_filter_context(), fresh_test_user.id, session)
        assert r.status == "fresh"

    @pytest.mark.asyncio
    async def test_other_users_log_not_returned(
        self,
        fake_insights_agent: Any,
        fresh_test_user: User,
        test_engine: AsyncEngine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A log row owned by a different user must not be served as cache hit
        (regression test for the missing user_id filter on the old hash-based lookup)."""
        import uuid as _uuid

        from sqlalchemy import delete

        report = _sample_report()
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)

        # Create a real second user (FK constraint prevents fabricated ids).
        async with session_maker() as session:
            other_user = User(
                email=f"other-user-{_uuid.uuid4()}@example.com",
                hashed_password="x",
            )
            session.add(other_user)
            await session.commit()
            await session.refresh(other_user)
            other_user_id = other_user.id

        try:
            async with session_maker() as session:
                await _seed(
                    session,
                    _make_log_row(
                        other_user_id,
                        response_json=report.model_dump(),
                    ),
                )

            fake_insights_agent(report)
            monkeypatch.setattr(
                "app.services.insights_llm.compute_findings",
                lambda fc, sess, uid: _fake_compute_findings(fc, sess, uid),
            )

            async with session_maker() as session:
                r = await generate_insights(_sample_filter_context(), fresh_test_user.id, session)
            assert r.status == "fresh"
        finally:
            async with session_maker() as session:
                # ON DELETE CASCADE on llm_logs.user_id removes the seeded log row.
                await session.execute(delete(User).where(User.id == other_user_id))
                await session.commit()

    @pytest.mark.asyncio
    async def test_cache_hit_skips_compute_findings(
        self,
        fake_insights_agent: Any,
        fresh_test_user: User,
        test_engine: AsyncEngine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Cache hit must NOT invoke compute_findings (the whole point of the rewrite)."""
        report = _sample_report()
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)

        async with session_maker() as session:
            await _seed(
                session,
                _make_log_row(
                    fresh_test_user.id,
                    response_json=report.model_dump(),
                ),
            )

        called = {"count": 0}

        async def _raising_compute_findings(
            fc: FilterContext, sess: AsyncSession, uid: int
        ) -> EndgameTabFindings:
            called["count"] += 1
            raise AssertionError("compute_findings must not be called on cache hit")

        fake_insights_agent(report)
        monkeypatch.setattr(
            "app.services.insights_llm.compute_findings",
            _raising_compute_findings,
        )

        async with session_maker() as session:
            r = await generate_insights(_sample_filter_context(), fresh_test_user.id, session)
        assert r.status == "cache_hit"
        assert called["count"] == 0


# ---------------------------------------------------------------------------
# TestNoRateLimit
# ---------------------------------------------------------------------------


class TestNoRateLimit:
    @pytest.mark.asyncio
    async def test_many_prior_misses_do_not_block_fresh_call(
        self,
        fake_insights_agent: Any,
        fresh_test_user: User,
        test_engine: AsyncEngine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Prior successful misses (any number) do not block a fresh call — rate limit removed."""
        report = _sample_report()
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)

        # Seed many miss rows with opponent_strength="stronger" so the structural
        # cache lookup (which uses opp_strength="any") MISSES — confirming the
        # fresh path runs without any rate-limit block.
        now = datetime.datetime.now(datetime.UTC)
        valid_report_json = report.model_dump()
        async with session_maker() as session:
            for i in range(5):
                await _seed(
                    session,
                    _make_log_row(
                        fresh_test_user.id,
                        created_at=now - datetime.timedelta(minutes=10 + i),
                        findings_hash="c" * 64,
                        response_json=valid_report_json,
                        opponent_strength="stronger",
                    ),
                )

        fake_insights_agent(report)
        monkeypatch.setattr(
            "app.services.insights_llm.compute_findings",
            lambda fc, sess, uid: _fake_compute_findings(fc, sess, uid),
        )

        async with session_maker() as session:
            r = await generate_insights(_sample_filter_context(), fresh_test_user.id, session)
        assert r.status == "fresh"

    @pytest.mark.asyncio
    async def test_old_rows_do_not_block_fresh_call(
        self,
        fake_insights_agent: Any,
        fresh_test_user: User,
        test_engine: AsyncEngine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Old miss rows do not block a fresh call (no rate limiting)."""
        report = _sample_report()
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)

        # Seed 3 misses with created_at >61 minutes ago.
        # Use opponent_strength="stronger" so the structural cache
        # lookup misses (the call uses default "any").
        old_time = datetime.datetime.now(datetime.UTC) - datetime.timedelta(minutes=61)
        async with session_maker() as session:
            for _ in range(3):
                await _seed(
                    session,
                    _make_log_row(
                        fresh_test_user.id,
                        created_at=old_time,
                        response_json={"ok": True},
                        findings_hash="e" * 64,
                        opponent_strength="stronger",
                    ),
                )

        fake_insights_agent(report)
        monkeypatch.setattr(
            "app.services.insights_llm.compute_findings",
            lambda fc, sess, uid: _fake_compute_findings(fc, sess, uid, findings_hash="f" * 64),
        )

        async with session_maker() as session:
            r = await generate_insights(_sample_filter_context(), fresh_test_user.id, session)
        assert r.status == "fresh"


# ---------------------------------------------------------------------------
# TestErrors
# ---------------------------------------------------------------------------


class TestErrors:
    @pytest.mark.asyncio
    async def test_provider_error_logs_row_and_raises(
        self,
        fresh_test_user: User,
        test_engine: AsyncEngine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Provider error: raises InsightsProviderError + writes one row with error='provider_error'."""
        from pydantic_ai import Agent
        from pydantic_ai.exceptions import ModelHTTPError
        from pydantic_ai.models.function import FunctionModel

        async def _failing_model(messages: Any, info: Any) -> Any:
            raise ModelHTTPError(status_code=500, model_name="test", body="simulated")

        fake = Agent(FunctionModel(_failing_model), output_type=EndgameInsightsReport)
        monkeypatch.setattr("app.services.insights_llm.get_insights_agent", lambda: fake)
        monkeypatch.setattr(
            "app.services.insights_llm.compute_findings",
            lambda fc, sess, uid: _fake_compute_findings(fc, sess, uid, findings_hash="g" * 64),
        )
        # Silence Sentry in this test
        mock_sentry = MagicMock()
        monkeypatch.setattr("app.services.insights_llm.sentry_sdk", mock_sentry)

        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            with pytest.raises(InsightsProviderError):
                await generate_insights(_sample_filter_context(), fresh_test_user.id, session)

        # Verify log row written with error marker and null response_json
        async with session_maker() as session:
            from sqlalchemy import select
            from app.models.llm_log import LlmLog as LlmLogModel

            result = await session.execute(
                select(LlmLogModel).where(
                    LlmLogModel.user_id == fresh_test_user.id,
                    LlmLogModel.findings_hash == "g" * 64,
                )
            )
            row = result.scalar_one_or_none()
        assert row is not None
        assert row.error is not None
        assert "provider_error" in row.error

    @pytest.mark.asyncio
    async def test_validation_failure_logs_row_and_raises(
        self,
        fresh_test_user: User,
        test_engine: AsyncEngine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Validation failure: raises InsightsValidationFailure + writes row with error marker."""
        from pydantic_ai import Agent
        from pydantic_ai.models.test import TestModel

        # TestModel with sections=[] violates min_length=1, triggering UnexpectedModelBehavior
        # after output_retries are exhausted.
        bad_output: dict[str, Any] = {
            "overview": "ok",
            "sections": [],  # violates min_length=1
            "model_used": "test",
            "prompt_version": "endgame_v16",
        }
        fake = Agent(
            TestModel(custom_output_args=bad_output),
            output_type=EndgameInsightsReport,
            retries={"output": 0},  # no retries — fail immediately
        )
        monkeypatch.setattr("app.services.insights_llm.get_insights_agent", lambda: fake)
        monkeypatch.setattr(
            "app.services.insights_llm.compute_findings",
            lambda fc, sess, uid: _fake_compute_findings(fc, sess, uid, findings_hash="h" * 64),
        )
        mock_sentry = MagicMock()
        monkeypatch.setattr("app.services.insights_llm.sentry_sdk", mock_sentry)

        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            with pytest.raises(InsightsValidationFailure):
                await generate_insights(_sample_filter_context(), fresh_test_user.id, session)

        async with session_maker() as session:
            from sqlalchemy import select
            from app.models.llm_log import LlmLog as LlmLogModel

            result = await session.execute(
                select(LlmLogModel).where(
                    LlmLogModel.user_id == fresh_test_user.id,
                    LlmLogModel.findings_hash == "h" * 64,
                )
            )
            row = result.scalar_one_or_none()
        assert row is not None
        # The "test" model is unknown to genai-prices so the repo appends
        # "; cost_unknown:test" to the error column. The marker we care about
        # (the pydantic-ai failure reason) must be the first part.
        assert row.error is not None
        assert row.error.startswith("validation_failure_after_retries")
        assert row.response_json is None


# ---------------------------------------------------------------------------
# TestSentryCapture
# ---------------------------------------------------------------------------


class TestSentryCapture:
    @pytest.mark.asyncio
    async def test_set_context_called_on_provider_error(
        self,
        fresh_test_user: User,
        test_engine: AsyncEngine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Provider error triggers sentry_sdk.set_context with structured data."""
        from pydantic_ai import Agent
        from pydantic_ai.exceptions import ModelHTTPError
        from pydantic_ai.models.function import FunctionModel

        async def _failing_model(messages: Any, info: Any) -> Any:
            raise ModelHTTPError(status_code=500, model_name="test", body="simulated")

        fake = Agent(FunctionModel(_failing_model), output_type=EndgameInsightsReport)
        monkeypatch.setattr("app.services.insights_llm.get_insights_agent", lambda: fake)
        findings_hash = "i" * 64
        monkeypatch.setattr(
            "app.services.insights_llm.compute_findings",
            lambda fc, sess, uid: _fake_compute_findings(
                fc, sess, uid, findings_hash=findings_hash
            ),
        )
        mock_sentry = MagicMock()
        monkeypatch.setattr("app.services.insights_llm.sentry_sdk", mock_sentry)

        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            with pytest.raises(InsightsProviderError):
                await generate_insights(_sample_filter_context(), fresh_test_user.id, session)

        mock_sentry.set_context.assert_called_with(
            "insights",
            {
                "user_id": fresh_test_user.id,
                "findings_hash": findings_hash,
                "model": "test",
                "endpoint": "insights.endgame",
            },
        )
        mock_sentry.capture_exception.assert_called_once()

    def test_no_variable_in_exception_message(self) -> None:
        """Exception messages use stable markers — no user_id or dynamic data."""
        exc = InsightsProviderError("provider_error")
        msg = str(exc)
        # Must not contain anything dynamic (user_id is an int, findings_hash is hex)
        assert "user_id" not in msg
        assert "findings_hash" not in msg
        # Must be the stable marker
        assert msg == "provider_error"


# ---------------------------------------------------------------------------
# TestHideOverview
# ---------------------------------------------------------------------------


class TestHideOverview:
    def test_maybe_strip_overview_strips_when_flag_set(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(insights_llm.settings, "INSIGHTS_HIDE_OVERVIEW", True)
        report = _sample_report(overview="Full overview text here.")
        stripped = _maybe_strip_overview(report)
        assert stripped.overview == ""
        # Original unchanged
        assert report.overview == "Full overview text here."

    def test_maybe_strip_overview_keeps_when_flag_false(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(insights_llm.settings, "INSIGHTS_HIDE_OVERVIEW", False)
        report = _sample_report(overview="Full overview text.")
        result = _maybe_strip_overview(report)
        assert result.overview == "Full overview text."

    @pytest.mark.asyncio
    async def test_hide_overview_strips_response_but_logs_full(
        self,
        fake_insights_agent: Any,
        fresh_test_user: User,
        test_engine: AsyncEngine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """INSIGHTS_HIDE_OVERVIEW=True: response has empty overview but log has full text."""
        full_overview = "Detailed analysis here."
        report = _sample_report(overview=full_overview)
        fake_insights_agent(report)

        monkeypatch.setattr(insights_llm.settings, "INSIGHTS_HIDE_OVERVIEW", True)
        findings_hash = "j" * 64
        monkeypatch.setattr(
            "app.services.insights_llm.compute_findings",
            lambda fc, sess, uid: _fake_compute_findings(
                fc, sess, uid, findings_hash=findings_hash
            ),
        )

        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            response = await generate_insights(
                _sample_filter_context(), fresh_test_user.id, session
            )

        # Response overview stripped
        assert response.status == "fresh"
        assert response.report.overview == ""

        # Log response_json still has the full overview.
        # Query directly (not via get_latest_log_by_hash which filters error IS NULL;
        # the "test" model yields cost_unknown:test in the error column).
        from sqlalchemy import select as sa_select
        from app.models.llm_log import LlmLog as LlmLogModel

        async with session_maker() as session:
            result = await session.execute(
                sa_select(LlmLogModel)
                .where(
                    LlmLogModel.user_id == fresh_test_user.id,
                    LlmLogModel.findings_hash == findings_hash,
                )
                .order_by(LlmLogModel.created_at.desc())
                .limit(1)
            )
            log = result.scalar_one_or_none()
        assert log is not None
        assert log.response_json is not None
        assert log.response_json.get("overview") == full_overview


# ---------------------------------------------------------------------------
# TestSection2ScoreGapFindings — Phase 87.2 Plan 04
# ---------------------------------------------------------------------------


class TestSection2ScoreGapFindings:
    """Phase 87.2: 4 new ΔES Score Gap findings emitted by _findings_endgame_metrics.

    D-09 (RESEARCH-corrected ADDITIVE): the 4 new score_gap_{conv,parity,recov,skill}
    findings are emitted ALONGSIDE the existing rate findings, not replacing them.

    Wire shape: (mean, n, zone, neutral_band). No p_value / verdict per memory
    feedback_llm_significance_signal.md — band IS the significance signal.
    """

    def _make_stats(
        self,
        *,
        games: int,
        rate: "float | None",
        mean: "float | None",
        n: "int | None",
    ) -> "Any":
        from app.schemas.endgames import PerTcBucketStats

        return PerTcBucketStats(
            games=games,
            win_pct=0.0,
            draw_pct=0.0,
            loss_pct=0.0,
            rate=rate,
            score_gap_mean=mean,
            score_gap_n=n,
            score_gap_p_value=None,
            score_gap_ci_low=None,
            score_gap_ci_high=None,
            percentile=None,
        )

    def _make_overview(
        self,
        *,
        tc: str = "blitz",
        conv_mean: "float | None" = 0.08,
        conv_n: "int | None" = 15,
        parity_mean: "float | None" = -0.02,
        parity_n: "int | None" = 15,
        recov_mean: "float | None" = 0.04,
        recov_n: "int | None" = 15,
        # Phase 87.4 (D-05): skill_mean / skill_n kwargs retained on the
        # builder signature for source-compat with the deleted-feature tests
        # below, but ignored at construction time — the underlying schema
        # fields were dropped.
        skill_mean: "float | None" = None,
        skill_n: "int | None" = None,
    ) -> "Any":
        del skill_mean, skill_n  # Phase 87.4 D-05: no longer fed into the schema.
        from typing import cast

        from app.schemas.endgames import (
            EndgameMetricsCardsResponse,
            EndgameMetricsTcCard,
            EndgameOverviewResponse,
        )

        # Phase 102 UAT: findings now come from the per-TC metrics card, not
        # score_gap_material. One card carries the conv/parity/recov ΔES means
        # and rates; each bucket's games doubles as its score_gap_n.
        conv = self._make_stats(games=conv_n or 0, rate=0.60, mean=conv_mean, n=conv_n)
        parity = self._make_stats(games=parity_n or 0, rate=0.50, mean=parity_mean, n=parity_n)
        recov = self._make_stats(games=recov_n or 0, rate=0.40, mean=recov_mean, n=recov_n)
        card = EndgameMetricsTcCard(
            tc=cast("Any", tc),
            total=(conv_n or 0) + (parity_n or 0) + (recov_n or 0),
            conversion=conv,
            parity=parity,
            recovery=recov,
        )
        return EndgameOverviewResponse.model_construct(
            endgame_metrics_cards=EndgameMetricsCardsResponse(cards=[card]),
        )

    def test_score_gap_findings_full_cohort(self) -> None:
        """Full cohort (each bucket n >= 10): 3 ΔES findings emitted (Phase 87.4
        D-05 drops the retired "skill" bucket).

        Asserts: 3 findings with correct metric_ids; value matches per-bucket mean;
        zone is dispatched via assign_zone; sample_size matches per-bucket n;
        is_headline_eligible True; existing rate findings also present (ADDITIVE, not swap).
        """
        import math

        from app.services.insights_service import _findings_endgame_metrics

        response = self._make_overview(
            conv_mean=0.08,
            conv_n=15,
            parity_mean=-0.02,
            parity_n=15,
            recov_mean=0.04,
            recov_n=15,
        )
        findings = _findings_endgame_metrics(response, window="all_time")

        delta_es_findings = [
            f
            for f in findings
            if f.metric
            in {
                "score_gap_conv",
                "score_gap_parity",
                "score_gap_recov",
            }
        ]
        assert len(delta_es_findings) == 3, (
            f"Expected 3 ΔES findings, got {len(delta_es_findings)}: {[f.metric for f in delta_es_findings]}"
        )

        by_metric = {f.metric: f for f in delta_es_findings}

        # Correct values from means.
        assert by_metric["score_gap_conv"].value == pytest.approx(0.08)
        assert by_metric["score_gap_parity"].value == pytest.approx(-0.02)
        assert by_metric["score_gap_recov"].value == pytest.approx(0.04)

        # Sample sizes match per-bucket n.
        assert by_metric["score_gap_conv"].sample_size == 15
        assert by_metric["score_gap_parity"].sample_size == 15

        # Zone dispatched (not None).
        for f in delta_es_findings:
            assert f.zone in {"weak", "typical", "strong"}, (
                f"zone {f.zone!r} not in expected set for {f.metric}"
            )
            assert not math.isnan(f.value)

        # is_headline_eligible True (n >= 10 and mean is not None).
        for f in delta_es_findings:
            assert f.is_headline_eligible is True, f"{f.metric}: expected is_headline_eligible=True"

        # Phase 102 UAT: findings now carry a per-TC dimension so render-time
        # percentile lookup is keyed by time control (metric_id still encodes
        # the conv/parity/recov bucket).
        for f in delta_es_findings:
            assert f.dimension == {"time_control": "blitz"}, (
                f"{f.metric}: expected time_control dimension"
            )

    def test_score_gap_findings_sparse_cohort(self) -> None:
        """Sparse cohort (each bucket n < 10): 3 findings emitted, is_headline_eligible False.

        Phase 87.4 (D-05): skill bucket retired — expected count drops from 4 to 3.
        """
        from app.services.insights_service import _findings_endgame_metrics

        response = self._make_overview(
            conv_mean=0.05,
            conv_n=5,
            parity_mean=0.01,
            parity_n=5,
            recov_mean=-0.03,
            recov_n=5,
        )
        findings = _findings_endgame_metrics(response, window="all_time")

        delta_es_findings = [
            f
            for f in findings
            if f.metric
            in {
                "score_gap_conv",
                "score_gap_parity",
                "score_gap_recov",
            }
        ]
        assert len(delta_es_findings) == 3

        for f in delta_es_findings:
            assert f.is_headline_eligible is False, (
                f"{f.metric}: expected is_headline_eligible=False for sparse cohort (n<10)"
            )
            assert f.sample_size == 5
            # zone still dispatched even for sparse cohort.
            assert f.zone in {"weak", "typical", "strong"}

    def test_score_gap_findings_empty_cohort(self) -> None:
        """Empty cohort (each bucket mean=None, n=0): 3 findings with value=NaN, is_headline_eligible=False.

        Phase 87.4 (D-05): skill bucket retired.
        """
        import math

        from app.services.insights_service import _findings_endgame_metrics

        response = self._make_overview(
            conv_mean=None,
            conv_n=0,
            parity_mean=None,
            parity_n=0,
            recov_mean=None,
            recov_n=0,
        )
        findings = _findings_endgame_metrics(response, window="all_time")

        delta_es_findings = [
            f
            for f in findings
            if f.metric
            in {
                "score_gap_conv",
                "score_gap_parity",
                "score_gap_recov",
            }
        ]
        assert len(delta_es_findings) == 3

        for f in delta_es_findings:
            assert math.isnan(f.value), f"{f.metric}: expected value=NaN for empty cohort"
            assert f.is_headline_eligible is False, (
                f"{f.metric}: expected is_headline_eligible=False for empty cohort"
            )
            assert f.sample_size == 0
            # assign_zone(metric_id, NaN) must return a zone (not raise).
            assert f.zone in {"weak", "typical", "strong"}

    def test_score_gap_findings_skill_metric_absent(self) -> None:
        """Phase 87.4 (D-05): the score_gap_skill finding was retired
        end-to-end. Regression guard against re-emitting it.
        """
        from app.services.insights_service import _findings_endgame_metrics

        response = self._make_overview()
        findings = _findings_endgame_metrics(response, window="all_time")

        skill_findings = [f for f in findings if f.metric == "score_gap_skill"]
        assert skill_findings == [], "score_gap_skill must not be emitted post-Phase 87.4 D-05"

    def test_existing_rate_findings_preserved(self) -> None:
        """D-09 ADDITIVE: per-bucket rate findings survive alongside ΔES findings.

        Phase 87.4 (D-05): the aggregate endgame_skill rate finding was retired
        end-to-end; only the per-bucket rate findings (conversion_win_pct /
        parity_score_pct / recovery_save_pct) survive.
        """
        from app.services.insights_service import _findings_endgame_metrics

        response = self._make_overview(
            conv_mean=0.08,
            conv_n=15,
            parity_mean=-0.02,
            parity_n=15,
            recov_mean=0.04,
            recov_n=15,
        )
        findings = _findings_endgame_metrics(response, window="all_time")

        metric_ids = {f.metric for f in findings}
        # Phase 87.4 (D-05): aggregate endgame_skill finding retired — must be absent.
        assert "endgame_skill" not in metric_ids
        assert "conversion_win_pct" in metric_ids, "conversion_win_pct finding missing"
        assert "parity_score_pct" in metric_ids, "parity_score_pct finding missing"
        assert "recovery_save_pct" in metric_ids, "recovery_save_pct finding missing"
        # New ΔES findings present (Phase 87.4 D-05: skill bucket retired).
        assert "score_gap_conv" in metric_ids
        assert "score_gap_parity" in metric_ids
        assert "score_gap_recov" in metric_ids
        assert "score_gap_skill" not in metric_ids
        # Total: 3 rate + 3 ΔES = 6 (Phase 87.4 D-05 drops aggregate skill +
        # the score_gap_skill ΔES bucket).
        assert len(findings) == 6, f"Expected 6 findings (3 rate + 3 ΔES), got {len(findings)}"


class TestPhase874PromptVersion:
    """Phase 87.5 Plan 03: _PROMPT_VERSION bumped to endgame_v33 with the
    Endgame ELO Timeline rebuild changelog blob prepended at the FRONT of the
    inline append-only comment.
    """

    def test_prompt_version_is_v33(self) -> None:
        """SC#7: bumped to endgame_v40 by Phase 102 UAT (was endgame_v35 after Phase 87.6)."""
        assert insights_llm._PROMPT_VERSION == "endgame_v47"

    def test_non_fractional_metrics_renamed(self) -> None:
        """Phase 87.5 (D-06): _NON_FRACTIONAL_METRICS swaps conversion_elo_gap → endgame_elo_gap."""
        assert "endgame_elo_gap" in insights_llm._NON_FRACTIONAL_METRICS, (
            "endgame_elo_gap must be registered as non-fractional (Elo points)"
        )
        assert "conversion_elo_gap" not in insights_llm._NON_FRACTIONAL_METRICS, (
            "legacy conversion_elo_gap must not survive in _NON_FRACTIONAL_METRICS"
        )

    def test_no_endgame_skill_payload_field(self) -> None:
        """D-05 (Plan 03 scope): the LLM payload module source contains no
        Skill-keyed quoted string literals after Phase 87.4. Plan 01 already
        removed the upstream Skill data via insights_service; this regression
        guard catches re-introducing a hardcoded reference here.
        """
        import inspect as _inspect

        src = _inspect.getsource(insights_llm)
        # Quoted-string literal guard: bare comment / changelog narration uses
        # the unquoted identifier, which is intentional context for future
        # readers and must NOT trip this assertion.
        assert '"endgame_skill"' not in src, (
            "quoted-string 'endgame_skill' literal still present in insights_llm.py"
        )
        assert '"score_gap_skill"' not in src, (
            "quoted-string 'score_gap_skill' literal still present"
        )
        assert '"endgame_skill_rate_mean"' not in src, (
            "quoted-string 'endgame_skill_rate_mean' literal still present"
        )


# ---------------------------------------------------------------------------
# TestPhase876LLMPayloadExtension — Phase 87.6 PR-direct rebuild assertions.
# ---------------------------------------------------------------------------


class TestPhase876LLMPayloadExtension:
    """Phase 87.6: guards for the non_endgame_elo payload extension + v34 prompt.

    RED gate: these tests fail until Task 2 extends the prompt, bumps the version,
    and wires the non_endgame_elo renderer.
    """

    def test_prompt_version_is_endgame_v39(self) -> None:
        """Phase 102 UAT: _PROMPT_VERSION bumped from endgame_v35 to endgame_v40."""
        assert insights_llm._PROMPT_VERSION == "endgame_v47"

    def test_prompt_prose_includes_non_endgame_elo_sentence_pattern(self) -> None:
        """Phase 87.6: the canonical 'Your Endgame ELO sits at X, vs Y' sentence skeleton
        must be present verbatim in the prompt file so future drift surfaces as a test failure.
        """
        from pathlib import Path

        prompt_path = (
            Path(__file__).resolve().parents[2] / "app" / "prompts" / "endgame_insights.md"
        )
        body = prompt_path.read_text(encoding="utf-8")
        assert "Your Endgame ELO sits at X, vs Y in non-endgame games" in body, (
            "Canonical sentence skeleton for Non-Endgame ELO comparison must be present "
            "in endgame_insights.md"
        )

    def test_prompt_glossary_has_non_endgame_elo_entry(self) -> None:
        """Phase 87.6: glossary entry for non_endgame_elo must exist with the exact header."""
        from pathlib import Path

        prompt_path = (
            Path(__file__).resolve().parents[2] / "app" / "prompts" / "endgame_insights.md"
        )
        body = prompt_path.read_text(encoding="utf-8")
        assert '- **non_endgame_elo** (UI label: "Non-Endgame ELO")' in body, (
            "Glossary entry for non_endgame_elo must be present in endgame_insights.md"
        )

    def test_endgame_elo_timeline_emits_three_summary_blocks(self) -> None:
        """Phase 87.6: the subsection renderer emits THREE summary blocks per combo.

        1. [summary endgame_elo | platform=..., time_control=...]
        2. [summary non_endgame_elo | platform=..., time_control=...]
        3. [summary endgame_elo_gap | platform=..., time_control=...]

        Uses a minimal mock SubsectionFinding + TimePoint series with all three
        ELO fields populated. Mirrors the TestV6Enrichments._finding() helper shape.
        """
        from typing import cast

        from app.schemas.insights import (
            MetricId,
            SampleQuality,
            SubsectionId,
            TimePoint,
            Window,
            Zone,
        )

        # Build a finding for endgame_elo_gap with TimePoints carrying all three PR fields.
        # _render_endgame_elo_summary_block + _render_non_endgame_elo_summary_block both
        # read from the same series — populate all three fields.
        series = [
            TimePoint(
                bucket_start=f"2026-0{m}-01",
                value=34.0,  # gap = endgame_elo - actual_elo = 1734 - 1700
                n=52,
                actual_elo=1700,
                endgame_elo=1734,
                non_endgame_elo=1671,
            )
            for m in (1, 2, 3, 4)
        ]
        finding = SubsectionFinding(
            subsection_id=cast(SubsectionId, "endgame_elo_timeline"),
            parent_subsection_id=None,
            window=cast(Window, "all_time"),
            metric=cast(MetricId, "endgame_elo_gap"),
            value=34.0,
            zone=cast(Zone, "typical"),
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=200,
            sample_quality=cast(SampleQuality, "rich"),
            is_headline_eligible=True,
            dimension={"platform": "chess.com", "time_control": "blitz"},
            series=series,
        )
        filters = _sample_filter_context()
        tab = _fake_findings(filters, findings=[finding])
        prompt = _assemble_user_prompt(tab)

        assert "[summary endgame_elo | platform=chess.com, time_control=blitz]" in prompt, (
            "endgame_elo summary block must be present"
        )
        assert "[summary non_endgame_elo | platform=chess.com, time_control=blitz]" in prompt, (
            "non_endgame_elo summary block must be present (Phase 87.6)"
        )
        assert "[summary endgame_elo_gap | platform=chess.com, time_control=blitz]" in prompt, (
            "endgame_elo_gap summary block must be present"
        )

        # Ordering: endgame_elo must precede non_endgame_elo must precede endgame_elo_gap.
        elo_idx = prompt.index("[summary endgame_elo | platform=chess.com")
        neg_idx = prompt.index("[summary non_endgame_elo | platform=chess.com")
        gap_idx = prompt.index("[summary endgame_elo_gap | platform=chess.com")
        assert elo_idx < neg_idx < gap_idx, (
            f"Block ordering wrong: endgame_elo({elo_idx}) < non_endgame_elo({neg_idx}) < "
            f"endgame_elo_gap({gap_idx}) required"
        )


# ---------------------------------------------------------------------------
# TestTimePressureScoreGapChartBlock — Phase 102 (Plan 01): new chart block
# helper _format_time_pressure_score_gap_chart_block renders 5-quintile per-TC
# Score-Gap-by-time table from EndgameTabFindings.time_pressure_cards.
# ---------------------------------------------------------------------------


def _make_pressure_quintile_bullet(
    q: int,
    n: int = 50,
    n_opp: int = 50,
    user_score: float = 0.55,
    opp_score: float = 0.50,
) -> "Any":
    """Build a PressureQuintileBullet with gate met (opp_score not None)."""
    from app.schemas.endgames import PressureQuintileBullet

    delta = user_score - opp_score
    return PressureQuintileBullet(
        quintile_index=q,
        quintile_label=f"{q * 20}-{q * 20 + 20}%",
        n=n,
        n_opp=n_opp,
        delta=delta,
        p_value=0.05,
        ci_low=delta - 0.02,
        ci_high=delta + 0.02,
        opp_score=opp_score,
    )


def _make_time_pressure_tc_card(
    tc: str,
    total: int = 200,
    quintiles_gate_met: bool = True,
) -> "Any":
    """Build a TimePressureTcCard with 5 quintiles (gate met or not)."""
    from typing import Literal, cast

    from app.schemas.endgames import (
        ClockGapBullet,
        PressureQuintileBullet,
        TimePressureTcCard,
    )

    if quintiles_gate_met:
        quintiles = [_make_pressure_quintile_bullet(q) for q in range(5)]
    else:
        quintiles = [
            PressureQuintileBullet(
                quintile_index=q,
                quintile_label=f"{q * 20}-{q * 20 + 20}%",
                n=0,
                n_opp=0,
                delta=0.0,
                p_value=None,
                ci_low=None,
                ci_high=None,
                opp_score=None,  # n-gate unmet
            )
            for q in range(5)
        ]
    return TimePressureTcCard(
        tc=cast(Literal["bullet", "blitz", "rapid", "classical"], tc),
        total=total,
        net_timeout_rate=0.0,
        clock_gap=ClockGapBullet(
            n=total, mean_diff_pct=0.0, p_value=None, ci_low=None, ci_high=None
        ),
        quintiles=quintiles,
    )


def _findings_with_time_pressure_cards(
    cards_data: list[tuple[str, bool]],
) -> EndgameTabFindings:
    """Build EndgameTabFindings with time_pressure_cards populated."""
    from app.schemas.endgames import TimePressureCardsResponse

    cards = [_make_time_pressure_tc_card(tc, quintiles_gate_met=gate) for tc, gate in cards_data]
    return EndgameTabFindings(
        as_of=datetime.datetime.now(datetime.UTC),
        filters=_sample_filter_context(),
        findings=[],
        time_pressure_cards=TimePressureCardsResponse(cards=cards),
        findings_hash="a" * 64,
    )


class TestTimePressureScoreGapChartBlock:
    """Phase 102 (Plan 01): _format_time_pressure_score_gap_chart_block."""

    def test_returns_empty_when_no_cards(self) -> None:
        """Empty time_pressure_cards → empty block."""
        from app.services.insights_llm import _format_time_pressure_score_gap_chart_block

        findings = _findings_with_time_pressure_cards([])
        assert _format_time_pressure_score_gap_chart_block(findings) == []

    def test_returns_empty_when_cards_is_none(self) -> None:
        """None time_pressure_cards → empty block."""
        from app.services.insights_llm import _format_time_pressure_score_gap_chart_block

        findings = EndgameTabFindings(
            as_of=datetime.datetime.now(datetime.UTC),
            filters=_sample_filter_context(),
            findings=[],
            time_pressure_cards=None,
            findings_hash="a" * 64,
        )
        assert _format_time_pressure_score_gap_chart_block(findings) == []

    def test_emits_chart_header_with_tc(self) -> None:
        """Chart header includes TC name and all_time suffix."""
        from app.services.insights_llm import _format_time_pressure_score_gap_chart_block

        findings = _findings_with_time_pressure_cards([("blitz", True)])
        lines = _format_time_pressure_score_gap_chart_block(findings)
        assert any(
            "### Chart: time_pressure_score_gap_by_time (blitz, all_time)" in line for line in lines
        )

    def test_emits_exactly_4_quintile_data_rows_when_all_gate_met(self) -> None:
        """With all 5 quintiles gate-met, exactly 4 data rows (Q0-Q3) are emitted per TC.

        Phase 102 UAT (2026-06-02): Q4 (80-100% clock = min pressure) is dropped
        from the payload to match the UI chart — only Q0-Q3 render.
        """
        from app.services.insights_llm import _format_time_pressure_score_gap_chart_block

        findings = _findings_with_time_pressure_cards([("blitz", True)])
        lines = _format_time_pressure_score_gap_chart_block(findings)
        # Count non-header table rows (exclude header and separator lines)
        table_rows = [
            line
            for line in lines
            if line.startswith("| ")
            and not line.startswith("| quintile")
            and not line.startswith("| ---")
        ]
        assert len(table_rows) == 4, (
            f"Expected exactly 4 quintile data rows (Q0-Q3), got {len(table_rows)}: {table_rows}"
        )

    def test_q4_min_pressure_row_excluded(self) -> None:
        """The Q4 (80-100%) min-pressure quintile is never rendered."""
        from app.services.insights_llm import _format_time_pressure_score_gap_chart_block

        findings = _findings_with_time_pressure_cards([("blitz", True)])
        lines = _format_time_pressure_score_gap_chart_block(findings)
        table_rows = [
            line
            for line in lines
            if line.startswith("| ") and not line.startswith(("| quintile", "| ---"))
        ]
        assert all("80-100%" not in row for row in table_rows), (
            f"Q4 (80-100%) must be excluded, got: {table_rows}"
        )

    def test_skips_rows_where_opp_score_is_none(self) -> None:
        """Quintiles with opp_score=None (n-gate unmet) are skipped."""
        from app.services.insights_llm import _format_time_pressure_score_gap_chart_block

        findings = _findings_with_time_pressure_cards([("rapid", False)])  # all gate unmet
        lines = _format_time_pressure_score_gap_chart_block(findings)
        # No TC sub-table should be emitted when all quintile rows are skipped
        assert not any("### Chart: time_pressure_score_gap_by_time" in line for line in lines)

    def test_prompt_contains_chart_block_for_tc_with_data(self) -> None:
        """Full prompt pipeline renders the chart block inside ## Section: time_pressure."""
        findings = _findings_with_time_pressure_cards([("blitz", True)])
        prompt = _assemble_user_prompt(findings)
        assert "### Chart: time_pressure_score_gap_by_time (blitz, all_time)" in prompt

    def test_multiple_tc_emits_separate_sub_tables(self) -> None:
        """Two TC cards produce two separate sub-tables."""
        from app.services.insights_llm import _format_time_pressure_score_gap_chart_block

        findings = _findings_with_time_pressure_cards([("blitz", True), ("rapid", True)])
        lines = _format_time_pressure_score_gap_chart_block(findings)
        assert sum(1 for line in lines if "### Chart: time_pressure_score_gap_by_time" in line) == 2

    def test_typical_band_column_present(self) -> None:
        """typical_band column appears in the table header."""
        from app.services.insights_llm import _format_time_pressure_score_gap_chart_block

        findings = _findings_with_time_pressure_cards([("blitz", True)])
        lines = _format_time_pressure_score_gap_chart_block(findings)
        assert any("typical_band" in line for line in lines)

    def test_aggregate_lines_render_clock_gap_and_net_flag_rate(self) -> None:
        """Below the quintile table, Clock Gap + Net Flag Rate aggregate lines always render.

        Phase 102 UAT: even with no percentile records, the two frequency-of-pressure
        metrics render from the card's raw value with a no-percentile note.
        """
        from app.services.insights_llm import _format_time_pressure_score_gap_chart_block

        findings = _findings_with_time_pressure_cards([("blitz", True)])
        lines = _format_time_pressure_score_gap_chart_block(findings)
        text = "\n".join(lines)
        assert "Time-pressure aggregates (blitz, all_time)" in text
        assert "Clock Gap" in text
        assert "Net Flag Rate" in text
        # No percentile records passed → the no-percentile fallback note appears.
        assert "no peer percentile yet" in text

    def test_aggregate_lines_render_percentile_tokens(self) -> None:
        """When per_tc_metric_percentiles is supplied, the three aggregates cite pctl tokens."""
        from app.schemas.insights import MetricPercentileRecord
        from app.services.insights_llm import _format_time_pressure_score_gap_chart_block

        findings = _findings_with_time_pressure_cards([("blitz", True)])
        per_tc = {
            "time_pressure_score_gap:blitz": MetricPercentileRecord(
                percentile=18, value=-12.0, n_games=189, anchor=1480, tc="blitz"
            ),
            "clock_gap:blitz": MetricPercentileRecord(
                percentile=22, value=-15.0, n_games=210, anchor=1480, tc="blitz"
            ),
            "net_flag_rate:blitz": MetricPercentileRecord(
                percentile=11, value=-13.0, n_games=210, anchor=1480, tc="blitz"
            ),
        }
        lines = _format_time_pressure_score_gap_chart_block(findings, per_tc)
        text = "\n".join(lines)
        assert "Time-Pressure Score Gap" in text
        assert "pctl=18 (vs ~1480-rated blitz peers | n_games=189 | value=-12)" in text
        assert "pctl=22 (vs ~1480-rated blitz peers | n_games=210 | value=-15)" in text
        assert "pctl=11 (vs ~1480-rated blitz peers | n_games=210 | value=-13)" in text
        # Frequency/performance framing is present so the LLM keeps them distinct.
        assert "PERFORMANCE under pressure" in text
        assert "FREQUENCY of pressure" in text


# ---------------------------------------------------------------------------
# TestPercentileAnnotation — Phase 102 (Plan 01): pctl= annotation in summary
# window lines when metric_percentiles is populated on EndgameTabFindings.
# ---------------------------------------------------------------------------


def _make_score_gap_finding(
    window: str = "all_time",
    value: float = 0.05,
    zone: str = "typical",
) -> SubsectionFinding:
    """Build a score_gap SubsectionFinding for percentile annotation tests."""
    from typing import cast
    from app.schemas.insights import MetricId, SampleQuality, SubsectionId, Window, Zone

    return SubsectionFinding(
        # Phase 102 UAT: score_gap now lives in the dedicated `score_gap`
        # subsection (the `overall` subsection is no longer in _SECTION_LAYOUT).
        subsection_id=cast(SubsectionId, "score_gap"),
        parent_subsection_id=None,
        window=cast(Window, window),
        metric=cast(MetricId, "score_gap"),
        value=value,
        zone=cast(Zone, zone),
        trend="n_a",
        weekly_points_in_window=0,
        sample_size=200,
        sample_quality=cast(SampleQuality, "rich"),
        is_headline_eligible=True,
        dimension=None,
    )


def _make_pctl_record(
    percentile: float = 31.0,
    value: float | None = None,
    n_games: int | None = None,
    anchor: int | None = None,
    tc: str | None = None,
) -> "MetricPercentileRecord":
    """Build a MetricPercentileRecord for test use."""
    from typing import Literal, cast

    from app.schemas.insights import MetricPercentileRecord

    tc_lit = cast(Literal["bullet", "blitz", "rapid", "classical"] | None, tc)
    return MetricPercentileRecord(
        percentile=percentile,
        value=value,
        n_games=n_games,
        anchor=anchor,
        tc=tc_lit,
    )


class TestPercentileAnnotation:
    """Phase 102 (Plan 01 + Plan 04): pctl= annotation in summary lines (D-03, D-05)."""

    def test_pctl_annotation_present_when_metric_in_metric_percentiles(self) -> None:
        """A finding whose metric is in metric_percentiles renders a pctl= token.

        D-05: cohort framing 'vs ~{anchor}-rated peers' when anchor present on record.
        """
        from app.schemas.insights import RatingAnchorContext

        finding = _make_score_gap_finding(zone="weak")
        rec = _make_pctl_record(percentile=31.0, anchor=1500)
        findings = EndgameTabFindings(
            as_of=datetime.datetime.now(datetime.UTC),
            filters=_sample_filter_context(),
            findings=[finding],
            metric_percentiles={"score_gap": rec},
            # Phase 102 (Plan 05): cohort_anchors requires RatingAnchorContext.
            cohort_anchors={
                "blitz": RatingAnchorContext(
                    anchor_rating=1500, n_chesscom_games=0, n_lichess_games=200
                )
            },
            findings_hash="a" * 64,
        )
        prompt = _assemble_user_prompt(findings)
        assert "pctl=31" in prompt, "pctl= token must appear when metric is in metric_percentiles"
        assert "vs ~1500-rated peers" in prompt, "cohort framing must appear with anchor"

    def test_no_pctl_token_when_metric_not_in_metric_percentiles(self) -> None:
        """A finding not in metric_percentiles renders NO pctl= token.

        Verifies that adding metric_percentiles for other metrics does not
        affect metrics outside the lookup dict.
        """
        finding = _make_score_gap_finding()
        findings = EndgameTabFindings(
            as_of=datetime.datetime.now(datetime.UTC),
            filters=_sample_filter_context(),
            findings=[finding],
            metric_percentiles={
                "achievable_score_gap": _make_pctl_record(55.0)
            },  # score_gap absent
            cohort_anchors=None,
            findings_hash="a" * 64,
        )
        prompt = _assemble_user_prompt(findings)
        assert "pctl=" not in prompt, (
            "pctl= token must NOT appear when metric is absent from metric_percentiles"
        )

    def test_no_pctl_token_when_metric_percentiles_is_none(self) -> None:
        """No metric_percentiles → no pctl= token (backwards compat)."""
        finding = _make_score_gap_finding()
        findings = EndgameTabFindings(
            as_of=datetime.datetime.now(datetime.UTC),
            filters=_sample_filter_context(),
            findings=[finding],
            metric_percentiles=None,
            findings_hash="a" * 64,
        )
        prompt = _assemble_user_prompt(findings)
        assert "pctl=" not in prompt

    def test_zone_typical_finding_with_extreme_percentile_still_emitted(self) -> None:
        """The finding must still be emitted even with extreme percentile.

        (Previously D-04 gate rule: zone was the sole emission gate. Now
        the prompt teaches zone OR extreme-pctl as the narration gate,
        but emission itself is never suppressed by zone status alone.)
        """
        finding = _make_score_gap_finding(zone="typical", value=0.02)
        findings = EndgameTabFindings(
            as_of=datetime.datetime.now(datetime.UTC),
            filters=_sample_filter_context(),
            findings=[finding],
            metric_percentiles={"score_gap": _make_pctl_record(5.0)},  # extreme percentile
            # Phase 102 (Plan 05): cohort_anchors now requires RatingAnchorContext.
            cohort_anchors=None,
            findings_hash="a" * 64,
        )
        prompt = _assemble_user_prompt(findings)
        # The finding must be present (zone=typical is emitted — typical is not filtered)
        assert "[summary score_gap]" in prompt, (
            "zone=typical finding must still be emitted even with extreme percentile"
        )
        # The pctl= annotation should be present (it's metadata on an emitted finding)
        assert "pctl=5" in prompt, "pctl= token should appear as metadata on the emitted finding"

    def test_enriched_pctl_token_carries_n_games_and_value(self) -> None:
        """Phase 102 (Plan 04): enriched pctl= token includes n_games and value."""
        finding = _make_score_gap_finding(zone="weak", value=-0.09)
        rec = _make_pctl_record(percentile=18.0, value=-9.0, n_games=312, anchor=1480, tc="blitz")
        findings = EndgameTabFindings(
            as_of=datetime.datetime.now(datetime.UTC),
            filters=_sample_filter_context(),
            findings=[finding],
            metric_percentiles={"score_gap": rec},
            findings_hash="a" * 64,
        )
        prompt = _assemble_user_prompt(findings)
        assert "pctl=18" in prompt
        assert "n_games=312" in prompt
        assert "value=-9" in prompt
        assert "vs ~1480-rated blitz peers" in prompt

    def test_per_tc_pctl_via_dim_key(self) -> None:
        """Phase 102 (Plan 04): per-TC metric percentile rendered via per_tc_metric_percentiles
        when the finding has a time_control dimension.
        """
        from typing import cast
        from app.schemas.insights import MetricId, SampleQuality, SubsectionId, Window, Zone

        # Phase 102 UAT: score_gap_conv lives under the per-TC subsection and
        # carries a time_control dimension (the per_tc lookup key is derived from
        # metric + time_control).
        conv_finding = SubsectionFinding(
            subsection_id=cast(SubsectionId, "endgame_metrics_blitz"),
            window=cast(Window, "all_time"),
            metric=cast(MetricId, "score_gap_conv"),
            value=0.05,
            zone=cast(Zone, "typical"),
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=95,
            sample_quality=cast(SampleQuality, "adequate"),
            is_headline_eligible=True,
            dimension={"time_control": "blitz"},
        )
        rec = _make_pctl_record(percentile=79.0, value=47.0, n_games=87, anchor=1480, tc="blitz")
        findings = EndgameTabFindings(
            as_of=datetime.datetime.now(datetime.UTC),
            filters=_sample_filter_context(),
            findings=[conv_finding],
            per_tc_metric_percentiles={"score_gap_conv:blitz": rec},
            findings_hash="a" * 64,
        )
        prompt = _assemble_user_prompt(findings)
        assert "pctl=79" in prompt, "per-TC pctl= token must appear from per_tc_metric_percentiles"
        assert "vs ~1480-rated blitz peers" in prompt

    def test_recovery_naming_bridge(self) -> None:
        """Phase 102 (Plan 04): 'recovery_score_gap:blitz' and 'score_gap_recov:blitz'
        both resolve to the same MetricPercentileRecord via the bridge alias.
        """

        rec = _make_pctl_record(percentile=25.0, anchor=1500, tc="blitz")
        per_tc: dict[str, MetricPercentileRecord] = {
            "score_gap_recov:blitz": rec,
            "recovery_score_gap:blitz": rec,
        }
        # Both keys must resolve to the same record.
        found_1 = _lookup_pctl_record(
            "score_gap_recov", "bucket=recovery, time_control=blitz", None, per_tc
        )
        found_2 = _lookup_pctl_record(
            "recovery_score_gap", "bucket=recovery, time_control=blitz", None, per_tc
        )
        assert found_1 is not None, "score_gap_recov should resolve via per_tc lookup"
        assert found_2 is not None, "recovery_score_gap bridge key should also resolve"
        assert found_1.percentile == 25.0
        assert found_2.percentile == 25.0

    def test_class_scoped_finding_does_not_resolve_tc_aggregate_pctl(self) -> None:
        """Phase 102 UAT fix: an Endgame Type (per-class × TC) finding must NOT pick
        up the per-TC AGGREGATE percentile.

        The per-class type findings share the conversion_win_pct / recovery_save_pct
        metric names AND a time_control dimension with the Endgame Metrics aggregate
        findings. Type Breakdown carries no percentiles by design, so a class-scoped
        dim_key (containing 'endgame_class=') must resolve to None — otherwise rook
        conversion in blitz would borrow the all-class blitz conversion percentile,
        whose value also contradicts the finding's own class-specific mean.
        """
        per_tc: dict[str, MetricPercentileRecord] = {
            "conversion_win_pct:blitz": _make_pctl_record(
                percentile=62.0, value=58.0, n_games=200, anchor=1500, tc="blitz"
            )
        }
        # Class-scoped (Endgame Type) finding → no percentile.
        assert (
            _lookup_pctl_record(
                "conversion_win_pct", "endgame_class=rook, time_control=blitz", None, per_tc
            )
            is None
        ), "per-class Endgame Type findings must not borrow the TC-aggregate percentile"
        # Aggregate (Endgame Metrics) finding → still resolves.
        assert (
            _lookup_pctl_record("conversion_win_pct", "time_control=blitz", None, per_tc)
            is not None
        ), "per-TC Endgame Metrics aggregate finding must still resolve its percentile"


# ---------------------------------------------------------------------------
# Phase 102 UAT: per-TC recovery-pattern / asymmetry hints count all_time only
# ---------------------------------------------------------------------------


class TestPerTcTypeHintWindowScoping:
    """The per-TC `endgame_type_<tc>` members span both windows; the hint helpers
    must count all_time findings only (no cross-window double-counting)."""

    @staticmethod
    def _recov(klass: str, window: str, zone: str = "weak") -> SubsectionFinding:
        from typing import cast

        from app.schemas.insights import MetricId, SampleQuality, SubsectionId, Window, Zone

        return SubsectionFinding(
            subsection_id=cast(SubsectionId, "endgame_type_blitz"),
            window=cast(Window, window),
            metric=cast(MetricId, "recovery_save_pct"),
            value=0.2,
            zone=cast(Zone, zone),
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=30,
            sample_quality=cast(SampleQuality, "adequate"),
            is_headline_eligible=True,
            dimension={"endgame_class": klass, "time_control": "blitz"},
        )

    @staticmethod
    def _conv(klass: str, window: str, zone: str) -> SubsectionFinding:
        from typing import cast

        from app.schemas.insights import MetricId, SampleQuality, SubsectionId, Window, Zone

        return SubsectionFinding(
            subsection_id=cast(SubsectionId, "endgame_type_blitz"),
            window=cast(Window, window),
            metric=cast(MetricId, "conversion_win_pct"),
            value=0.6,
            zone=cast(Zone, zone),
            trend="n_a",
            weekly_points_in_window=0,
            sample_size=30,
            sample_quality=cast(SampleQuality, "adequate"),
            is_headline_eligible=True,
            dimension={"endgame_class": klass, "time_control": "blitz"},
        )

    def test_recovery_pattern_not_double_counted_across_windows(self) -> None:
        """Two weak classes present in BOTH windows must not register as four."""
        members = [
            self._recov("rook", "all_time"),
            self._recov("pawn", "all_time"),
            self._recov("rook", "last_3mo"),
            self._recov("pawn", "last_3mo"),
        ]
        assert _recovery_pattern_tag(members, "blitz") == "", (
            "2 distinct weak classes (each in both windows) must not trip the 4-of-4 hint"
        )

    def test_recovery_pattern_fires_on_four_all_time_weak(self) -> None:
        """All four visible classes weak in all_time still fires the hint."""
        members = [self._recov(k, "all_time") for k in ("rook", "pawn", "queen", "minor_piece")] + [
            self._recov("rook", "last_3mo")
        ]
        tag = _recovery_pattern_tag(members, "blitz")
        assert "weak across 4 of 4 types in blitz" in tag

    def test_asymmetry_uses_all_time_not_last_3mo(self) -> None:
        """Asymmetry split must reflect the all_time finding, not last_3mo.

        all_time shows the conv-strong / recov-weak split; last_3mo shows both
        typical. Only the all_time split should surface.
        """
        members = [
            self._conv("rook", "all_time", "strong"),
            self._recov("rook", "all_time", "weak"),
            self._conv("rook", "last_3mo", "typical"),
            self._recov("rook", "last_3mo", "typical"),
        ]
        lines = _asymmetry_lines(members, "blitz")
        assert len(lines) == 1
        assert "[asymmetry type=rook tc=blitz]" in lines[0]
        assert "closes winning endgames but bleeds losing ones" in lines[0]


# ---------------------------------------------------------------------------
# Phase 102 (Plan 05): Rating-basis block tests
# ---------------------------------------------------------------------------


class TestRatingBasisBlock:
    """Phase 102 (Plan 05): _format_rating_basis_block renders per-TC Lichess-equivalent framing."""

    def _make_cc_heavy_anchor(self, tc: str = "blitz") -> tuple[str, "Any"]:
        """Pure chess.com anchor — n_lichess_games == 0."""
        from app.schemas.insights import RatingAnchorContext

        return tc, RatingAnchorContext(
            anchor_rating=1550,
            n_chesscom_games=320,
            n_lichess_games=0,
            chesscom_median_native=1400,
        )

    def _make_lichess_anchor(self, tc: str = "blitz") -> tuple[str, "Any"]:
        """Pure lichess anchor — n_chesscom_games == 0."""
        from app.schemas.insights import RatingAnchorContext

        return tc, RatingAnchorContext(
            anchor_rating=1620,
            n_chesscom_games=0,
            n_lichess_games=450,
            lichess_median_native=1620,
        )

    def _make_mixed_anchor(self, tc: str = "blitz") -> tuple[str, "Any"]:
        """Mixed anchor — both platforms have games."""
        from app.schemas.insights import RatingAnchorContext

        return tc, RatingAnchorContext(
            anchor_rating=1580,
            n_chesscom_games=200,
            n_lichess_games=300,
            chesscom_median_native=1410,
            lichess_median_native=1600,
        )

    def _render(self, anchors: "dict[str, Any] | None") -> str:
        from app.services.insights_llm import _format_rating_basis_block

        return "\n".join(_format_rating_basis_block(anchors))

    def test_empty_when_no_anchors(self) -> None:
        assert self._render(None) == ""
        assert self._render({}) == ""

    def test_pure_chesscom_shows_conversion_note(self) -> None:
        tc, ctx = self._make_cc_heavy_anchor("blitz")
        output = self._render({tc: ctx})
        assert "## Rating basis" in output
        assert "[rating basis] blitz:" in output
        assert "anchor ~1550 (Lichess-equivalent)" in output
        assert "chess.com median ~1400 (converted)" in output
        assert "lichess median n/a" in output
        assert "320 cc / 0 li" in output

    def test_pure_lichess_shows_native_label_no_conversion(self) -> None:
        tc, ctx = self._make_lichess_anchor("rapid")
        output = self._render({tc: ctx})
        assert "## Rating basis" in output
        assert "[rating basis] rapid:" in output
        assert "anchor ~1620 (Lichess-equivalent)" in output
        assert "lichess median ~1620 (native)" in output
        # No conversion note for pure-lichess user.
        assert "(converted)" not in output
        assert "chess.com median n/a" in output
        assert "0 cc / 450 li" in output

    def test_mixed_user_shows_both_platforms(self) -> None:
        tc, ctx = self._make_mixed_anchor("blitz")
        output = self._render({tc: ctx})
        assert "chess.com median ~1410 (converted)" in output
        assert "lichess median ~1600" in output
        assert "200 cc / 300 li" in output

    def test_tc_ordering_follows_canonical_order(self) -> None:
        """TCs appear in bullet/blitz/rapid/classical order, not insertion order."""
        from app.schemas.insights import RatingAnchorContext

        anchors = {
            "rapid": RatingAnchorContext(
                anchor_rating=1500, n_chesscom_games=100, n_lichess_games=0
            ),
            "bullet": RatingAnchorContext(
                anchor_rating=1520, n_chesscom_games=50, n_lichess_games=0
            ),
        }
        output = self._render(anchors)
        bullet_pos = output.find("[rating basis] bullet:")
        rapid_pos = output.find("[rating basis] rapid:")
        assert bullet_pos < rapid_pos, "bullet should appear before rapid"

    def test_rating_basis_block_in_assembled_prompt(self) -> None:
        """Rating-basis block appears in the assembled prompt for a cc-heavy user."""
        import datetime

        tc, ctx = self._make_cc_heavy_anchor("blitz")
        findings = EndgameTabFindings(
            as_of=datetime.datetime.now(datetime.UTC),
            filters=_sample_filter_context(),
            findings=[],
            cohort_anchors={tc: ctx},
            findings_hash="a" * 64,
        )
        prompt = _assemble_user_prompt(findings)
        assert "## Rating basis" in prompt
        assert "[rating basis] blitz:" in prompt
        assert "anchor ~1550 (Lichess-equivalent)" in prompt
        assert "chess.com median ~1400 (converted)" in prompt

    def test_rating_basis_block_absent_for_pure_lichess_in_assembled_prompt(self) -> None:
        """Rating-basis block still renders for pure-lichess but without conversion copy."""
        import datetime

        tc, ctx = self._make_lichess_anchor("blitz")
        findings = EndgameTabFindings(
            as_of=datetime.datetime.now(datetime.UTC),
            filters=_sample_filter_context(),
            findings=[],
            cohort_anchors={tc: ctx},
            findings_hash="a" * 64,
        )
        prompt = _assemble_user_prompt(findings)
        assert "## Rating basis" in prompt
        assert "(converted)" not in prompt
        assert "lichess median ~1620 (native)" in prompt

    def test_prompt_teaches_lichess_equivalent_framing(self) -> None:
        """The prompt file contains the D-05a Lichess-equivalent teaching."""
        from pathlib import Path

        prompt_path = (
            Path(__file__).resolve().parents[2] / "app" / "prompts" / "endgame_insights.md"
        )
        body = prompt_path.read_text(encoding="utf-8")
        assert "Lichess-equivalent anchor (D-05a)" in body, (
            "Prompt must contain D-05a teaching about the Lichess-equivalent framing"
        )
        assert "n_lichess_games == 0" in body, (
            "Pure chess.com disclosure branch must be documented in the prompt"
        )
        assert "n_chesscom_games == 0" in body, (
            "Pure lichess disclosure branch must be documented in the prompt"
        )

    def test_version_is_endgame_v39(self) -> None:
        """Phase 102 Plan 05/UAT: _PROMPT_VERSION bumped to endgame_v40."""
        from app.services import insights_llm

        assert insights_llm._PROMPT_VERSION == "endgame_v47"
