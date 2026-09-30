"""ParseBench-specific native extract field-grounding metrics."""

from types import SimpleNamespace

import pytest

from parse_bench.evaluation.metrics.field_grounding.extract_adapter import (
    compute_extract_field_grounding_metrics,
)
from parse_bench.test_cases.schema import ExtractFieldBbox, ExtractFieldTestRule


def test_extract_grounding_uses_native_extract_namespace_only() -> None:
    rule = ExtractFieldTestRule(
        field_path="invoice.number",
        expected_value="INV-001",
        bboxes=[ExtractFieldBbox(page=1, bbox=[0.1, 0.2, 0.3, 0.1])],
    )
    citation = SimpleNamespace(
        field_path="invoice.number",
        page=1,
        bbox=[0.1, 0.2, 0.3, 0.1],
    )

    metrics = compute_extract_field_grounding_metrics(
        extracted_data={"invoice": {"number": "INV-001"}},
        field_rules=[rule],
        field_citations=[citation],
    )
    by_name = {metric.metric_name: metric for metric in metrics}

    for metric_name in (
        "extract_value_precision",
        "extract_value_recall",
        "extract_value_f1",
        "extract_bbox_iou",
        "extract_bbox_recall",
        "extract_localization_pass_rate",
        "extract_attribution_pass_rate",
        "extract_element_pass_rate",
    ):
        assert by_name[metric_name].value == pytest.approx(1.0)

    assert "extract_field_localization_pass_rate" not in by_name
    assert "extract_field_attribution_pass_rate" not in by_name
    assert "extract_field_element_pass_rate" not in by_name
    assert by_name["extract_bbox_iou"].metadata["score_sum"] == pytest.approx(1.0)
    assert by_name["extract_bbox_iou"].metadata["score_count"] == 1
    assert by_name["extract_bbox_recall"].metadata["score_sum"] == pytest.approx(1.0)
    assert by_name["extract_bbox_recall"].metadata["score_count"] == 1
    assert by_name["extract_element_pass_rate"].metadata["rule_results"][0]["bbox_recall"] == pytest.approx(1.0)


def test_extract_element_pass_rate_metadata_includes_all_rule_results() -> None:
    rules = [
        ExtractFieldTestRule(
            field_path=f"rows[{index}].amount",
            expected_value=index,
            bboxes=[ExtractFieldBbox(page=1, bbox=[0.1, 0.01 * index, 0.1, 0.005])],
        )
        for index in range(25)
    ]
    citations = [
        SimpleNamespace(
            field_path=f"rows[{index}].amount",
            page=1,
            bbox=[0.1, 0.01 * index, 0.1, 0.005],
        )
        for index in range(25)
    ]

    metrics = compute_extract_field_grounding_metrics(
        extracted_data={"rows": [{"amount": index} for index in range(25)]},
        field_rules=rules,
        field_citations=citations,
    )
    by_name = {metric.metric_name: metric for metric in metrics}

    element = by_name["extract_element_pass_rate"]

    assert element.value == 1.0
    assert element.metadata["total"] == 25
    assert element.metadata["passed"] == 25
    assert element.metadata["tp"] == 25
    assert element.metadata["fp"] == 0
    assert element.metadata["fn"] == 0
    assert len(element.metadata["rule_results"]) == 25
    assert element.metadata["rule_results"][24]["field_path"] == "rows[24].amount"
    assert element.metadata["rule_results"][24]["bbox_recall"] == pytest.approx(1.0)
    assert by_name["extract_bbox_iou"].metadata["score_count"] == 25
    assert by_name["extract_bbox_iou"].metadata["score_sum"] == pytest.approx(25.0)
    assert by_name["extract_bbox_recall"].metadata["score_count"] == 25
    assert by_name["extract_bbox_recall"].metadata["score_sum"] == pytest.approx(25.0)
    assert "extract_field_element_pass_rate" not in by_name
