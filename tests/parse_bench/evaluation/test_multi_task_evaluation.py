"""Tests for mixed layout + parse rule evaluation (``_evaluate_multi_task``)."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from parse_bench.evaluation.runner import (
    EvaluationRunner,
    _drop_parse_owned_metric_aliases,
)
from parse_bench.schemas.evaluation import EvaluationResult, MetricValue
from parse_bench.schemas.layout_detection_output import (
    LayoutDetectionModel,
    LayoutOutput,
    LayoutPrediction,
)
from parse_bench.schemas.parse_output import ParseOutput
from parse_bench.schemas.pipeline_io import InferenceRequest, InferenceResult
from parse_bench.schemas.product import ProductType
from parse_bench.test_cases.schema import LayoutDetectionTestCase, ParseTestCase

LAYOUT_RULE: dict[str, Any] = {
    "type": "layout",
    "id": "el-1",
    "page": 1,
    "bbox": [0.0, 0.0, 0.5, 0.5],
    "canonical_class": "Text",
}
PRESENT_RULE: dict[str, Any] = {"type": "present", "id": "p-1", "text": "Hello"}


def _markdown_only_result() -> InferenceResult:
    """A parse result no layout adapter can turn into a ``LayoutOutput``."""
    now = datetime.now()
    return InferenceResult(
        request=InferenceRequest(
            example_id="table/doc",
            source_file_path="/tmp/doc.pdf",
            product_type=ProductType.PARSE,
        ),
        pipeline_name="markdown_only_provider",
        product_type=ProductType.PARSE,
        raw_output={},
        output=ParseOutput(
            example_id="table/doc",
            pipeline_name="markdown_only_provider",
            markdown="# Hello\n\nworld",
        ),
        started_at=now,
        completed_at=now,
        latency_in_ms=1,
    )


def _mixed_parse_test_case(**overrides: Any) -> ParseTestCase:
    kwargs: dict[str, Any] = {
        "test_id": "table/doc",
        "group": "table",
        "file_path": Path("/tmp/doc.pdf"),
        "test_rules": [LAYOUT_RULE, PRESENT_RULE],
    }
    kwargs.update(overrides)
    return ParseTestCase(**kwargs)


def test_markdown_only_provider_keeps_the_parse_metrics_it_earned(tmp_path: Path) -> None:
    """A provider with no layout output must not lose the rules it did pass.

    The layout adapter used to be resolved outside the try block, so the whole
    result came back ``success=False`` with no metrics and ``_aggregate_metrics``
    dropped the document and zero-padded it — throwing away parse rules that had
    already passed.
    """
    runner = EvaluationRunner(output_dir=tmp_path)
    test_case = _mixed_parse_test_case()
    assert runner._has_mixed_rules(test_case)

    result = runner._evaluate_single(_markdown_only_result(), test_case, None, "multi_task")

    assert result.success
    assert result.error is None
    metrics = {m.metric_name: m.value for m in result.metrics}
    assert metrics["rule_present_pass_rate"] == 1.0
    assert metrics["rule_pass_rate"] == 1.0
    # The layout half is a genuine zero across the full metric set, so the
    # document stays in the mAP/AP/F1 denominators instead of dropping out and
    # inflating the averages over the documents that did emit layout.
    assert metrics["layout_rule_pass_rate"] == 0.0
    assert metrics["AP50"] == 0.0
    assert metrics["mean_f1"] == 0.0


def test_missing_layout_counts_as_zero_in_the_aggregate(tmp_path: Path, monkeypatch: Any) -> None:
    """One perfect document plus one with no layout must not aggregate to 100%."""
    runner = EvaluationRunner(output_dir=tmp_path)

    monkeypatch.setattr(
        "parse_bench.evaluation.runner.create_layout_adapter_for_result",
        lambda _result: _StubLayoutAdapter(),
    )
    perfect = runner._evaluate_single(_markdown_only_result(), _mixed_parse_test_case(), None, "multi_task")
    monkeypatch.undo()
    missing = runner._evaluate_single(
        _markdown_only_result(), _mixed_parse_test_case(test_id="table/doc2"), None, "multi_task"
    )

    assert perfect.success and missing.success
    aggregate = runner._aggregate_metrics([perfect, missing])
    assert aggregate["avg_AP50"] == 0.5
    assert aggregate["avg_mean_f1"] == 0.5
    assert aggregate["avg_layout_rule_pass_rate"] == 0.5
    assert aggregate["avg_rule_pass_rate"] == 1.0


def test_a_real_adapter_failure_still_fails_the_result(tmp_path: Path, monkeypatch: Any) -> None:
    """Only "provider emitted no layout" is swallowed, not adapter bugs."""
    runner = EvaluationRunner(output_dir=tmp_path)

    def _boom(_inference_result: InferenceResult) -> Any:
        raise RuntimeError("adapter harness bug")

    monkeypatch.setattr("parse_bench.evaluation.runner.create_layout_adapter_for_result", _boom)
    result = runner._evaluate_single(_markdown_only_result(), _mixed_parse_test_case(), None, "multi_task")

    assert not result.success
    assert result.error is not None
    assert "adapter harness bug" in result.error


def test_layout_detection_test_case_takes_the_same_path(tmp_path: Path) -> None:
    """The routing must not depend on which test case class carries the rules."""
    runner = EvaluationRunner(output_dir=tmp_path)
    test_case = LayoutDetectionTestCase(
        test_id="table/doc",
        group="table",
        file_path=Path("/tmp/doc.pdf"),
        test_rules=[LAYOUT_RULE, PRESENT_RULE],
    )

    result = runner._evaluate_single(_markdown_only_result(), test_case, None, "multi_task")

    assert result.success
    assert {m.metric_name: m.value for m in result.metrics}["rule_present_pass_rate"] == 1.0


def test_parse_half_inherits_document_scoped_parse_config(tmp_path: Path, monkeypatch: Any) -> None:
    """``expected_markdown`` and the table settings must survive the rule split."""
    runner = EvaluationRunner(output_dir=tmp_path)
    test_case = _mixed_parse_test_case(
        expected_markdown="| a |\n|---|",
        allow_splitting_ambiguous_merged_tables=True,
        trm_unsupported=True,
        max_top_title_rows=3,
        metadata={"source_dataset": "some-dataset"},
    )

    captured: dict[str, Any] = {}
    parse_evaluator = runner._evaluators["parse"]
    original_evaluate = parse_evaluator.evaluate

    def _capture(inference_result: InferenceResult, split_test_case: Any) -> Any:
        captured["test_case"] = split_test_case
        return original_evaluate(inference_result, split_test_case)

    monkeypatch.setattr(parse_evaluator, "evaluate", _capture)
    runner._evaluate_single(_markdown_only_result(), test_case, None, "multi_task")

    split = captured["test_case"]
    assert split.expected_markdown == "| a |\n|---|"
    assert split.allow_splitting_ambiguous_merged_tables is True
    assert split.trm_unsupported is True
    assert split.max_top_title_rows == 3
    assert split.metadata == {"source_dataset": "some-dataset"}


class _StubLayoutAdapter:
    """Returns a layout payload for any inference result.

    Uses a string-labelled model (CHUNKR) rather than LLAMAPARSE: the LlamaParse
    label mapper lazily imports ``llama_cloud``, which is only installed with the
    ``runners`` extra.
    """

    def to_layout_output(self, inference_result: InferenceResult, **_: Any) -> LayoutOutput:
        return LayoutOutput(
            example_id=inference_result.request.example_id,
            pipeline_name=inference_result.pipeline_name,
            model=LayoutDetectionModel.CHUNKR,
            image_width=100,
            image_height=100,
            predictions=[LayoutPrediction(bbox=[0.0, 0.0, 50.0, 50.0], score=1.0, label="Text", page=1)],
        )


class _EmptyLayoutAdapter:
    """Matched the result, but the provider reported no elements."""

    def to_layout_output(self, inference_result: InferenceResult, **_: Any) -> LayoutOutput:
        return LayoutOutput(
            example_id=inference_result.request.example_id,
            pipeline_name=inference_result.pipeline_name,
            model=LayoutDetectionModel.CHUNKR,
            image_width=100,
            image_height=100,
            predictions=[],
        )


def test_empty_layout_output_scores_a_real_zero(tmp_path: Path, monkeypatch: Any) -> None:
    """An adapter that matched but found nothing is scoreable, not a failure.

    This branch used to append "Could not extract layout from PARSE output" and
    fail the whole result, taking the parse metrics with it. Running the
    evaluator against the empty prediction set gives a genuine 0 across the
    whole metric set, with the denominators the evaluator builds itself —
    localization and classification are separate checks, so counting one
    failure per ground truth element would under-count them.
    """
    runner = EvaluationRunner(output_dir=tmp_path)
    monkeypatch.setattr(
        "parse_bench.evaluation.runner.create_layout_adapter_for_result",
        lambda _result: _EmptyLayoutAdapter(),
    )

    result = runner._evaluate_single(_markdown_only_result(), _mixed_parse_test_case(), None, "multi_task")

    assert result.success
    metrics = {m.metric_name: m.value for m in result.metrics}
    # Parse half intact, layout half a true zero across the full metric set.
    assert metrics["rule_present_pass_rate"] == 1.0
    assert metrics["rule_pass_rate"] == 1.0
    assert metrics["layout_rule_pass_rate"] == 0.0
    assert metrics["AP50"] == 0.0
    assert metrics["mean_f1"] == 0.0
    # One ground truth element, two checks: localization and classification.
    layout_rule_metric = next(m for m in result.metrics if m.metric_name == "layout_rule_pass_rate")
    assert (layout_rule_metric.metadata or {}).get("total") == 2


@pytest.mark.parametrize(
    ("test_case_factory", "expected_source_dataset"),
    [
        (lambda: _mixed_parse_test_case(metadata={"source_dataset": "from-metadata"}), "from-metadata"),
        (
            lambda: LayoutDetectionTestCase(
                test_id="table/doc",
                group="table",
                file_path=Path("/tmp/doc.pdf"),
                test_rules=[LAYOUT_RULE, PRESENT_RULE],
                source_dataset="from-field",
            ),
            "from-field",
        ),
    ],
    ids=["parse_test_case_metadata", "layout_test_case_field"],
)
def test_layout_half_inherits_source_dataset(
    tmp_path: Path,
    monkeypatch: Any,
    test_case_factory: Any,
    expected_source_dataset: str,
) -> None:
    """``source_dataset`` reaches the layout evaluator from either carrier."""
    runner = EvaluationRunner(output_dir=tmp_path)
    monkeypatch.setattr(
        "parse_bench.evaluation.runner.create_layout_adapter_for_result",
        lambda _result: _StubLayoutAdapter(),
    )

    captured: dict[str, Any] = {}

    def _capture(inference_result: InferenceResult, layout_test_case: Any) -> EvaluationResult:
        captured["test_case"] = layout_test_case
        return EvaluationResult(
            test_id=layout_test_case.test_id,
            example_id=inference_result.request.example_id,
            pipeline_name=inference_result.pipeline_name,
            product_type="layout_detection",
            success=True,
            metrics=[
                MetricValue(metric_name="layout_rule_pass_rate", value=0.0, metadata={"passed": 0, "total": 2}),
                MetricValue(metric_name="rule_pass_rate", value=0.0, metadata={"passed": 0, "total": 2}),
            ],
        )

    monkeypatch.setattr(runner._evaluators["layout_detection"], "evaluate", _capture)
    result = runner._evaluate_single(_markdown_only_result(), test_case_factory(), None, "multi_task")

    assert captured["test_case"].source_dataset == expected_source_dataset
    # The layout evaluator's `rule_pass_rate` alias is dropped in favour of the
    # parse half's, which carries the rule_results payload the report renders.
    names = [m.metric_name for m in result.metrics]
    assert names.count("rule_pass_rate") == 1
    assert "layout_rule_pass_rate" in names
    assert {m.metric_name: m.value for m in result.metrics}["rule_pass_rate"] == 1.0


def test_alias_is_kept_when_the_parse_half_produced_nothing() -> None:
    """With no parse `rule_pass_rate` to collide with, the layout one stands."""
    layout_metrics = [
        MetricValue(metric_name="layout_rule_pass_rate", value=0.25),
        MetricValue(metric_name="rule_pass_rate", value=0.25),
    ]

    assert _drop_parse_owned_metric_aliases(layout_metrics, set()) == layout_metrics
    assert [m.metric_name for m in _drop_parse_owned_metric_aliases(layout_metrics, {"rule_pass_rate"})] == [
        "layout_rule_pass_rate"
    ]


def test_alias_drop_leaves_other_layout_metrics_alone() -> None:
    """Only the colliding name is dropped; mAP and friends pass through."""
    layout_metrics = [
        MetricValue(metric_name="mAP", value=0.4),
        MetricValue(metric_name="rule_pass_rate", value=0.25),
        MetricValue(metric_name="layout_element_rule_pass_rate", value=0.25),
    ]

    kept = _drop_parse_owned_metric_aliases(layout_metrics, {"rule_pass_rate", "mAP"})

    assert [m.metric_name for m in kept] == ["mAP", "layout_element_rule_pass_rate"]
