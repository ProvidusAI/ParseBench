"""Regression tests for JSONL test-case loading in ``_load_jsonl_dataset``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from parse_bench.test_cases.loader import _load_jsonl_dataset
from parse_bench.test_cases.schema import (
    ExtractFieldTestRule,
    LayoutDetectionTestCase,
    LayoutTestRule,
    ParseTestCase,
)


def _write_jsonl(root: Path, rows: list[dict], name: str = "layout.jsonl") -> None:
    (root / name).write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")


def _with_pdf(root: Path, stem: str) -> None:
    pdfs = root / "pdfs"
    pdfs.mkdir(exist_ok=True)
    (pdfs / f"{stem}.pdf").write_bytes(b"%PDF-1.4 fake")


def _layout_row(pdf: str, category: str, rule_id: str = "el-1") -> dict[str, Any]:
    return {
        "pdf": pdf,
        "category": category,
        "type": "layout",
        "id": rule_id,
        "rule": {"id": rule_id, "page": 1, "bbox": [0, 0, 1, 1], "canonical_class": "title"},
    }


def _rule_types(test_case: ParseTestCase | LayoutDetectionTestCase) -> list[str]:
    return [type(rule).__name__ for rule in (test_case.test_rules or [])]


def test_layout_doc_with_order_rule_keeps_both_rule_kinds(tmp_path: Path) -> None:
    """Layout rules were dropped when the doc also had parse rules."""
    _with_pdf(tmp_path, "doc1")
    _write_jsonl(
        tmp_path,
        [
            _layout_row("pdfs/doc1.pdf", "layout"),
            {
                "pdf": "pdfs/doc1.pdf",
                "category": "layout",
                "type": "order",
                "id": "ord-1",
                "rule": {"layout_bindings": {"before": "el-1", "after": "el-1"}},
            },
        ],
    )

    test_cases = _load_jsonl_dataset(tmp_path)

    assert len(test_cases) == 1
    tc = test_cases[0]
    assert isinstance(tc, ParseTestCase)
    assert _rule_types(tc) == ["LayoutTestRule", "ParseOrderRule"]
    assert len(tc.get_parse_rules()) == 1


def test_mixed_doc_keeps_expected_markdown_and_table_settings(tmp_path: Path) -> None:
    """LayoutDetectionTestCase has no expected_markdown or table settings."""
    _with_pdf(tmp_path, "doc2")
    _write_jsonl(
        tmp_path,
        [
            _layout_row("pdfs/doc2.pdf", "table"),
            {
                "pdf": "pdfs/doc2.pdf",
                "category": "table",
                "type": "table",
                "id": "t-1",
                "rule": {
                    "expected_table": "<table><tr><td>a</td></tr></table>",
                    "allow_splitting_ambiguous_merged_tables": True,
                    "trm_unsupported": True,
                    "max_top_title_rows": 3,
                },
            },
            {
                "pdf": "pdfs/doc2.pdf",
                "category": "table",
                "type": "expected_markdown",
                "id": "md-1",
                "rule": {},
                "expected_markdown": "| a |\n|---|",
            },
        ],
        name="table.jsonl",
    )

    tc = _load_jsonl_dataset(tmp_path)[0]

    assert isinstance(tc, ParseTestCase)
    assert _rule_types(tc) == ["LayoutTestRule", "ParseTableRule"]
    assert tc.expected_markdown == "| a |\n|---|"
    assert tc.allow_splitting_ambiguous_merged_tables is True
    assert tc.trm_unsupported is True
    assert tc.max_top_title_rows == 3


def test_layout_doc_with_only_expected_markdown_stays_layout_shaped(tmp_path: Path) -> None:
    """An expected_markdown row is not a rule, so _has_mixed_rules is False.

    The markdown is dropped here; that is pre-existing. Moving the doc to the
    ParseTestCase branch to keep it would drop its layout scoring instead.
    """
    _with_pdf(tmp_path, "doc3")
    _write_jsonl(
        tmp_path,
        [
            _layout_row("pdfs/doc3.pdf", "table"),
            {
                "pdf": "pdfs/doc3.pdf",
                "category": "table",
                "type": "expected_markdown",
                "id": "md-1",
                "rule": {},
                "expected_markdown": "| a |\n|---|",
            },
        ],
        name="table.jsonl",
    )

    tc = _load_jsonl_dataset(tmp_path)[0]

    assert isinstance(tc, LayoutDetectionTestCase)
    assert _rule_types(tc) == ["LayoutTestRule"]


def test_mixed_doc_with_an_extract_field_rule_loads(tmp_path: Path) -> None:
    """Loading, not scoring: ParseEvaluator filters ExtractFieldTestRule out.

    LayoutDetectionTestCase.test_rules is a closed union, so the same payload
    raises there and aborts the whole _load_jsonl_dataset call.
    """
    _with_pdf(tmp_path, "doc4")
    _write_jsonl(
        tmp_path,
        [
            _layout_row("pdfs/doc4.pdf", "layout"),
            {
                "pdf": "pdfs/doc4.pdf",
                "category": "layout",
                "type": "extract_field",
                "id": "f-1",
                "rule": {"field_path": "a.b", "expected_value": "x"},
            },
        ],
    )

    tc = _load_jsonl_dataset(tmp_path)[0]

    assert isinstance(tc, ParseTestCase)
    assert [type(rule) for rule in tc.test_rules or []] == [LayoutTestRule, ExtractFieldTestRule]
    # The same payload on the other class is a hard ValidationError.
    with pytest.raises(ValidationError):
        LayoutDetectionTestCase(
            test_id=tc.test_id,
            group=tc.group,
            file_path=tc.file_path,
            test_rules=[dict(_layout_row("x", "layout")["rule"], type="layout"), {"type": "extract_field"}],
        )


def test_layout_only_doc_still_builds_layout_test_case(tmp_path: Path) -> None:
    """The shipped layout dataset shape is unchanged."""
    _with_pdf(tmp_path, "doc5")
    _write_jsonl(tmp_path, [_layout_row("pdfs/doc5.pdf", "layout")])

    test_cases = _load_jsonl_dataset(tmp_path)

    assert len(test_cases) == 1
    tc = test_cases[0]
    assert isinstance(tc, LayoutDetectionTestCase)
    assert len(tc.get_layout_rules()) == 1


def test_doc_with_only_parse_rules_still_builds_parse_test_case(tmp_path: Path) -> None:
    _with_pdf(tmp_path, "doc6")
    _write_jsonl(
        tmp_path,
        [
            {
                "pdf": "pdfs/doc6.pdf",
                "category": "text_content",
                "type": "present",
                "id": "p-1",
                "rule": {"text": "hello"},
            },
        ],
        name="text_content.jsonl",
    )

    test_cases = _load_jsonl_dataset(tmp_path)

    assert len(test_cases) == 1
    assert isinstance(test_cases[0], ParseTestCase)
    # text_content shares its inference results with text_formatting.
    assert test_cases[0].test_id == "text/doc6"
